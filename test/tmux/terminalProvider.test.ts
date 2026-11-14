import { afterEach, describe, expect, it, vi } from 'vitest';
import { REVIVE_DEADLINE_MS, REVIVE_GRACE_MS, REVIVE_QUIET_MS, SLOT_MAPPING_STATE_KEY, TmuxTerminalProvider, UNREACHABLE_RETRY_MS } from '../../src/tmux/terminalProvider';
import { createRemoteExec } from '../../src/tmux/remoteExec';
import { buildAttachOrCreateArgv, buildClearClosedCommand, buildKillSession, buildRenameSession, sessionName } from '../../src/tmux/tmuxSession';

// The terminal provider is the user-facing heart of the fork: it decides which
// tmux session (slot) each VS Code terminal maps to. Both hard invariants live
// here — *invisible* (plain terminal options, no tmux branding) and *no zombies /
// no stealing* (a second client never -A-attaches into another client's live
// session; hand-off adopts detached orphans; the same client re-attaches its own).
// Every decision is pure over an injected `exec` + `workspaceState`, so the whole
// contract is unit-testable with no real ssh2 / VS Code.

const HOST = 'example.com';
const WS = '/home/user/proj';
const CWD = '/home/user/proj';

/** Deterministic session name for a slot in the test workspace. */
const name = (slot: number): string => sessionName(HOST, WS, slot);

/** The subset of `vscode.TerminalOptions` this provider produces. */
interface LaunchOptions {
    readonly name?: string;
    readonly shellPath?: string;
    readonly shellArgs?: string[];
    readonly cwd?: string;
    readonly isTransient?: boolean;
    readonly env?: { readonly [key: string]: string | null | undefined };
}

/** The `-s <name>` target a launched/returned option-set attaches to. */
const targetSession = (options: LaunchOptions): string => {
    const args = options.shellArgs ?? [];
    return args[args.indexOf('-s') + 1] ?? '';
};

/** A fake `vscode.Memento` backed by a Map — models client-local workspaceState. */
function fakeState(initial: Record<string, unknown> = {}) {
    const store = new Map<string, unknown>(Object.entries(initial));
    return {
        keys: (): string[] => [...store.keys()],
        get: (key: string, def?: unknown): unknown => (store.has(key) ? store.get(key) : def),
        update: async (key: string, value: unknown): Promise<void> => {
            if (value === undefined) {
                store.delete(key);
            } else {
                store.set(key, value);
            }
        },
    };
}

/** This test window's client id (the owner tag its attaches write). */
const ME = '1a2b3c4d-0011aabb';
/** Another machine's client id. */
const OTHER = '9f8e7d6c-ffeeddcc';

/** A `list-sessions` stdout line: `<name> <attached> <windows> <created> <paneDead> o:<owner>`.
 * No owner → an untagged session (owner unknown). */
const row = (sessionId: string, attached: boolean, windows = 1, created = 1700000000, paneDead = false, owner = ''): string =>
    `${sessionId} ${attached ? 1 : 0} ${windows} ${created} ${paneDead ? 1 : 0} o:${owner}`;

/** A row for a session whose owner tag names `owner`. */
const owned = (sessionId: string, attached: boolean, owner: string): string => row(sessionId, attached, 1, 1700000000, false, owner);

/** The session names a batched `has-session` command asks about, in order. Matched on the
 * EXACT `-t =<name>` target the real tmux uses, not a loose substring: a bare `includes(name)`
 * mimicked the very prefix-match bug the `=` fix removes (it would report `code-<h>-01`
 * present when only `code-<h>-0` exists). */
const hasTargets = (command: string): string[] =>
    [...command.matchAll(/has-session -t ='([^']*)'/g)].map(m => m[1]);

/** One tagged answer line of the batched `has-session` command (`__has <i> <rc> <msg>`). */
const hasLine = (index: number, code: number, message = ''): string => `__has ${index} ${code} ${message}`;

/** A batched `has-session` reply: each asked-about name answered by `answer(name)`. */
function hasReply(command: string, answer: (target: string) => { code: number; message?: string }) {
    const stdout = hasTargets(command)
        .map((target, index) => {
            const { code, message } = answer(target);
            return hasLine(index, code, message);
        })
        .join('\n');
    return { stdout, stderr: '', code: 0 };
}

/**
 * A `RemoteExec` that answers `list-sessions` with the given rows and the batched
 * `has-session` against a set of existing names (exit 0 = present; exit 1 + tmux's own
 * "can't find session" = absent), mirroring what the real tmux CLI reports.
 */
function fakeExec(opts: { list?: string[]; existing?: string[]; clients?: string } = {}) {
    const listOut = (opts.list ?? []).join('\n');
    const existing = new Set(opts.existing ?? []);
    return vi.fn(async (command: string): Promise<ExecResult> => {
        if (command.includes('list-sessions')) {
            return { stdout: listOut, stderr: '', code: 0 };
        }
        if (command.includes('list-clients')) {
            return { stdout: opts.clients ?? '', stderr: '', code: 0 };
        }
        if (command.includes('has-session')) {
            return hasReply(command, target => existing.has(target)
                ? { code: 0 }
                : { code: 1, message: `can't find session: ${target}` });
        }
        return { stdout: '', stderr: '', code: 0 };
    });
}

/** What a fake exec may answer. `code` is optional so the many inline fakes below that only
 * care about stdout keep reading naturally; it defaults to 0 (see `makeProvider`). */
interface ExecResult {
    readonly stdout: string;
    readonly stderr: string;
    readonly code?: number;
}

function makeProvider(over: {
    exec?: ReturnType<typeof fakeExec>;
    /** A fully-formed `RemoteExec`, passed through untouched (e.g. one built by `createRemoteExec`). */
    rawExec?: import('../../src/tmux/remoteExec').RemoteExec;
    state?: ReturnType<typeof fakeState>;
    opened?: LaunchOptions[];
    historyLimit?: number;
    tmuxPath?: string;
    tmuxVersion?: string;
    listTerminals?: () => readonly import('vscode').Terminal[];
    reviveGraceMs?: number;
    reviveDeadlineMs?: number;
    reviveQuietMs?: number;
    handOff?: import('../../src/tmux/slotState').HandOffPolicy;
    offerTakeOver?: () => Promise<boolean>;
    staleClientSeconds?: number;
    ctx?: import('../../src/tmux/terminalProvider').TmuxSessionContext;
} = {}) {
    const opened = over.opened ?? [];
    const exec = over.exec ?? fakeExec();
    const state = over.state ?? fakeState();
    const log = { info: vi.fn(), trace: vi.fn() };
    const provider = new TmuxTerminalProvider({
        ctx: over.ctx ?? { hostKey: HOST, workspaceKey: WS, cwd: CWD },
        // `code` defaults to 0 so a fake that omits it reads as tmux succeeding.
        exec: over.rawExec ?? (async (command: string) => ({ code: 0, ...await exec(command) })),
        state,
        // LaunchOptions is the subset this provider produces; narrow back to it for recording.
        openTerminal: (options: import('vscode').TerminalOptions): void => {
            opened.push(options as LaunchOptions);
        },
        listTerminals: over.listTerminals,
        reviveGraceMs: over.reviveGraceMs ?? 0,
        // Defaults to the grace so the existing waiting tests stay as quick as they were;
        // the claim-driven tests below set it explicitly.
        reviveDeadlineMs: over.reviveDeadlineMs ?? over.reviveGraceMs ?? 0,
        reviveQuietMs: over.reviveQuietMs ?? 0,
        log,
        historyLimit: over.historyLimit,
        tmuxPath: over.tmuxPath,
        tmuxVersion: over.tmuxVersion,
        clientId: ME,
        handOff: over.handOff,
        offerTakeOver: over.offerTakeOver,
        staleClientSeconds: over.staleClientSeconds,
    });
    return { provider, opened, exec, state, log };
}

/** The options carried by a returned `TerminalProfile` (mock stores them as-is). */
const optionsOf = (profile: { options: unknown }): LaunchOptions => profile.options as LaunchOptions;

describe('slot allocation', () => {
    it('gives a fresh window slot 0', async () => {
        const { provider } = makeProvider();
        expect(targetSession(optionsOf(await provider.provideTerminalProfile()))).toBe(name(0));
    });

    it('hands out 0, 1, 2 for three terminals opened in a row', async () => {
        const { provider } = makeProvider();
        const slots = [
            targetSession(optionsOf(await provider.provideTerminalProfile())),
            targetSession(optionsOf(await provider.provideTerminalProfile())),
            targetSession(optionsOf(await provider.provideTerminalProfile())),
        ];
        expect(slots).toEqual([name(0), name(1), name(2)]);
    });

    it('reuses the lowest freed slot after a terminal closes (close 1, open → 1)', async () => {
        const { provider } = makeProvider();
        await provider.provideTerminalProfile(); // 0
        await provider.provideTerminalProfile(); // 1
        await provider.provideTerminalProfile(); // 2
        provider.releaseSlot(1);                 // close-detach slot 1
        expect(targetSession(optionsOf(await provider.provideTerminalProfile()))).toBe(name(1));
    });

    it('never steals a slot another client is attached to (second client → slot 2)', async () => {
        // PC is attached to slots 0 and 1; the laptop has an empty local mapping.
        const exec = fakeExec({ list: [row(name(0), true), row(name(1), true)] });
        const { provider } = makeProvider({ exec });
        expect(targetSession(optionsOf(await provider.provideTerminalProfile()))).toBe(name(2));
    });
});

describe('atomic slot claim (05 l: two machines opening a terminal at the same moment)', () => {
    // The no-steal guard reads a `list-sessions` snapshot, but VS Code spawns the tmux
    // process only *after* provideTerminalProfile returns. Two machines pressing "New
    // Terminal" together both read "slot 0 is free" and both returned `new-session -A` on
    // it: the second spawn attached to the first one's brand-new session (reproduced on the
    // rig). The chosen slot is now created on the remote (`new-session -d`, refused when the
    // name exists) before it is handed out; a refused claim moves on to the next slot.

    /** A remote that refuses the claim of `taken` names as duplicates. */
    function claimExec(taken: string[] = [], opts: { throwOnClaim?: boolean } = {}) {
        return vi.fn(async (command: string): Promise<ExecResult> => {
            if (command.includes('\'new-session\' \'-d\'')) {
                if (opts.throwOnClaim) {
                    throw new Error('connection reset');
                }
                const claimed = taken.find(n => command.includes(`'${n}'`));
                return claimed ? { stdout: '', stderr: `duplicate session: ${claimed}`, code: 1 } : { stdout: '', stderr: '', code: 0 };
            }
            return { stdout: '', stderr: '', code: 0 };
        });
    }
    const claims = (exec: ReturnType<typeof claimExec>): string[] =>
        exec.mock.calls.map(call => call[0]).filter(command => command.includes('\'new-session\' \'-d\''));

    it('creates the chosen slot on the remote, then hands out an attach of it', async () => {
        const exec = claimExec();
        const { provider } = makeProvider({ exec });

        const options = optionsOf(await provider.provideTerminalProfile());

        expect(targetSession(options)).toBe(name(0));
        expect(claims(exec)).toHaveLength(1);
        expect(claims(exec)[0]).toContain(`'${name(0)}'`);
        expect(options.shellArgs).toContain('-A'); // the terminal attaches what the claim created
    });

    it('moves on to the next slot when another machine claimed this one first', async () => {
        const exec = claimExec([name(0), name(1)]);
        const { provider } = makeProvider({ exec });

        expect(targetSession(optionsOf(await provider.provideTerminalProfile()))).toBe(name(2));
        expect(claims(exec)).toHaveLength(3);
    });

    it('keeps the slot when the claim cannot be delivered (the snapshot already said free)', async () => {
        const exec = claimExec([], { throwOnClaim: true });
        const { provider } = makeProvider({ exec });

        expect(targetSession(optionsOf(await provider.provideTerminalProfile()))).toBe(name(0));
    });

    it('gives up on a remote that refuses every slot with a plain shell, never a guessed slot', async () => {
        const exec = vi.fn(async (command: string): Promise<ExecResult> => command.includes('\'new-session\' \'-d\'')
            ? { stdout: '', stderr: 'duplicate session: x', code: 1 }
            : { stdout: '', stderr: '', code: 0 });
        const { provider } = makeProvider({ exec });

        expect(optionsOf(await provider.provideTerminalProfile())).toEqual({});
        // ...and holds no slot for it.
        exec.mockImplementation(async () => ({ stdout: '', stderr: '', code: 0 }));
        expect(targetSession(optionsOf(await provider.provideTerminalProfile()))).toBe(name(0));
    });

    it('a restored session is not claimed (it exists already)', async () => {
        const state = fakeState({ [SLOT_MAPPING_STATE_KEY]: { '0': name(0) } });
        const exec = fakeExec({ list: [row(name(0), false)], existing: [name(0)] });
        const { provider } = makeProvider({ state, exec, reviveGraceMs: 30, reviveDeadlineMs: 300 });

        const init = provider.initialize();
        await provider.provideTerminalProfile();
        await init;

        expect(exec.mock.calls.some(call => call[0].includes('\'new-session\' \'-d\''))).toBe(false);
    });
});

describe('no-steal guard under a probe failure', () => {
    // `attachedRemoteSlots` IS the no-steal guard. A *transient* `list-sessions` failure
    // (network blip, missed deadline) must not silently disarm it — and guessing a slot from
    // a stale snapshot is no better. When the remote cannot be asked, the new terminal gets
    // a plain shell (this one terminal only) rather than a slot that might be someone else's.

    it('answers with a plain shell, not a guessed slot, when the snapshot cannot be taken', async () => {
        let listCalls = 0;
        const exec = vi.fn(async (command: string): Promise<ExecResult> => {
            if (command.includes('list-sessions')) {
                listCalls++;
                if (listCalls === 1) {
                    return { stdout: row(name(0), true), stderr: '' };
                }
                throw new Error('connection reset'); // transient blip on every later probe
            }
            return { stdout: '', stderr: '' };
        });
        const { provider, log } = makeProvider({ exec });

        await provider.initialize(); // seeds attachedRemoteSlots = {0} from the good snapshot
        const options = optionsOf(await provider.provideTerminalProfile());

        expect(options).toEqual({}); // VS Code's default shell
        expect(log.info).toHaveBeenCalledTimes(1);
        expect(String(log.info.mock.calls[0][0])).toMatch(/plain shell/);
    });

    it('treats a list tmux could not run (non-zero exit, no "no server") as unreachable', async () => {
        const exec = vi.fn(async (command: string): Promise<ExecResult> => command.includes('list-sessions')
            ? { stdout: '', stderr: 'sh: 1: tmux: not found', code: 127 }
            : { stdout: '', stderr: '' });
        const { provider } = makeProvider({ exec });

        expect(optionsOf(await provider.provideTerminalProfile())).toEqual({});
    });

    it('keeps the slot chosen from a good snapshot when only the claim fails', async () => {
        // The claim only closes the two-machine race; losing it is no reason to drop to a
        // plain shell when a fresh snapshot already said the slot is free.
        const exec = vi.fn(async (command: string): Promise<ExecResult> => {
            if (command.includes('list-sessions')) {
                return { stdout: row(name(0), true), stderr: '' };
            }
            if (command.includes('\'new-session\' \'-d\'')) {
                throw new Error('connection reset');
            }
            return { stdout: '', stderr: '' };
        });
        const { provider } = makeProvider({ exec });

        expect(targetSession(optionsOf(await provider.provideTerminalProfile()))).toBe(name(1));
    });
});

describe('init race (no duplicate/mirrored tab on a slot being restored or adopted)', () => {
    // extension.ts kicks off initialize() fire-and-forget, then registers the
    // profile provider. A "New Terminal" (or the auto-terminal VS Code opens on
    // connect) could call provideTerminalProfile() *before* initialize() finished
    // restoring/adopting — and allocateSlot, ignoring the persisted mapping and the
    // pending restore, handed out slot 0 too. Two terminals on one tmux session →
    // shared view, mirrored keystrokes. Two complementary guards close it: mapped
    // slots are reserved synchronously (before initialize()'s first await), and
    // provideTerminalProfile awaits `initialized` so adoption (remote-discovered,
    // not yet in the mapping) also completes first.

    it('reserves a mapped survivor slot so a new terminal never collides with it', async () => {
        // A survivor mapping from a previous window: slot 0 is spoken for. Even
        // before initialize() runs, a brand-new terminal must skip it → slot 1.
        const state = fakeState({ [SLOT_MAPPING_STATE_KEY]: { '0': name(0) } });
        const { provider } = makeProvider({ state });
        expect(targetSession(optionsOf(await provider.provideTerminalProfile()))).toBe(name(1));
    });

    it('awaits initialize() so a terminal created mid-restore does not collide with an adopted orphan', async () => {
        // Force the race a near-synchronous fake exec would hide: hold initialize()'s
        // list-sessions probe open. There is a detached orphan on slot 0 that no client
        // holds and this client has not mapped (hand-off) — initialize() will adopt it.
        // Without the gate, provideTerminalProfile races ahead and allocates the very
        // slot 0 that adoption is about to claim (mirrored tab). The gate must keep it
        // pending until initialize() settles, then hand out slot 1.
        let releaseList!: () => void;
        const listGate = new Promise<void>(res => { releaseList = res; });
        let firstList = true;
        const exec = vi.fn(async (command: string) => {
            if (command.includes('list-sessions')) {
                if (firstList) {
                    firstList = false;
                    await listGate; // only initialize()'s probe blocks
                }
                return { stdout: row(name(0), false), stderr: '' };
            }
            return { stdout: '', stderr: '' };
        });
        const opened: LaunchOptions[] = [];
        const { provider } = makeProvider({ exec, opened });

        const initP = provider.initialize(); // fire-and-forget, exactly like extension.ts
        let profile: { options: unknown } | undefined;
        const profileP = provider.provideTerminalProfile().then(p => { profile = p; });

        // Drain every pending microtask; without the gate, allocation would have run.
        await new Promise<void>(res => setTimeout(res, 0));
        expect(profile).toBeUndefined(); // still gated on initialize()

        releaseList();
        await initP;
        await profileP;

        // The gate held, so nothing was allocated behind adoption's back. What the caller
        // then receives is the adopted session itself, not a second one beside it: with the
        // restore queue, a profile request during connect is answered from the queue. That
        // is the only correct answer when the caller is VS Code reviving a persisted
        // terminal — indistinguishable from a user's "New Terminal", since the API passes no
        // context — and it is a reasonable one either way, because the alternative is
        // handing someone a fresh empty session while their own sits unclaimed.
        expect(targetSession(optionsOf(profile!))).toBe(name(0)); // the adopted orphan
        expect(opened).toEqual([]);                               // nothing opened behind it
    });

    it('drains reservations after initialize so a closed-then-reopened slot is reusable', async () => {
        // Reservation must be a connect-time guard, not permanent: once initialize()
        // has resolved every survivor into an open terminal, closing one and opening a
        // new terminal must reuse that slot (same client re-attaching its own session).
        const state = fakeState({ [SLOT_MAPPING_STATE_KEY]: { '0': name(0) } });
        const exec = fakeExec({ list: [row(name(0), false)], existing: [name(0)] });
        const { provider } = makeProvider({ state, exec });

        await provider.initialize(); // restores slot 0 into an open terminal
        provider.releaseSlot(0);     // user closes it (detach, mapping kept)

        expect(targetSession(optionsOf(await provider.provideTerminalProfile()))).toBe(name(0));
    });
});

describe('live terminal close wiring (onDidOpenTerminal / onDidCloseTerminal)', () => {
    // Regression coverage for a real 09-verify bug: `releaseSlot` is pure and
    // unit-tested (see "reuses the lowest freed slot" above), but nothing ever
    // called it from a real VS Code close event — extension.ts never wired
    // `vscode.window.onDidCloseTerminal`. So closing and reopening a terminal
    // within one window session never freed a slot: every "New Terminal" after a
    // close minted a brand-new, ever-growing session instead of reattaching the
    // one just detached (found live: 5 open/kill cycles -> 5 distinct sessions on
    // the remote, not 1 reused slot). The fix correlates a live `vscode.Terminal`
    // back to its slot via the session name baked into `shellArgs` at open time.
    it('handleTerminalOpened + handleTerminalClosed round-trip frees the slot for reuse', async () => {
        const { provider } = makeProvider();
        const profile = await provider.provideTerminalProfile(); // slot 0
        const fakeTerminal = { creationOptions: optionsOf(profile) } as unknown as import('vscode').Terminal;

        provider.handleTerminalOpened(fakeTerminal);
        provider.handleTerminalClosed(fakeTerminal);

        expect(targetSession(optionsOf(await provider.provideTerminalProfile()))).toBe(name(0));
    });

    it('ignores a terminal that is not one of ours (no shellArgs / foreign session)', () => {
        const { provider } = makeProvider();
        const foreign = { creationOptions: { shellPath: '/bin/bash' } } as unknown as import('vscode').Terminal;
        expect(() => provider.handleTerminalOpened(foreign)).not.toThrow();
        expect(() => provider.handleTerminalClosed(foreign)).not.toThrow();
    });

    it('closing an unopened/unknown terminal is a no-op (does not free an unrelated slot)', async () => {
        const { provider } = makeProvider();
        await provider.provideTerminalProfile(); // slot 0
        const unknown = { creationOptions: { shellPath: 'tmux', shellArgs: [] } } as unknown as import('vscode').Terminal;

        provider.handleTerminalClosed(unknown);

        expect(targetSession(optionsOf(await provider.provideTerminalProfile()))).toBe(name(1)); // 0 still open
    });
});

describe('restore mapping (per client, on reload)', () => {
    it('re-attaches mapped slots whose session survives and prunes the dead', async () => {
        const state = fakeState({ [SLOT_MAPPING_STATE_KEY]: { '0': name(0), '2': name(2) } });
        const exec = fakeExec({ existing: [name(0)] }); // has-session: 0 present, 2 gone
        const opened: LaunchOptions[] = [];
        const { provider } = makeProvider({ state, exec, opened });

        await provider.initialize();

        expect(opened.map(targetSession)).toEqual([name(0)]); // only slot 0 re-opened
        expect(provider.mappedSlots()).toEqual([0]);          // slot 2 pruned
        expect(state.get(SLOT_MAPPING_STATE_KEY)).toEqual({ '0': name(0) });
    });

    // THE FIELD BUG (fixed): "attached" was read as "another machine holds this", so
    // restore was skipped and the user got a brand-new empty terminal while their real work
    // sat in a session they could no longer see. VS Code keeps a closed window's pty alive
    // for its reconnection grace (3h by default), so OUR OWN tmux client stays attached long
    // after the window is gone. The owner tag says so — reclaiming it with `-D` (which evicts
    // the stale client and leaves the pane's process running) is taking back what is ours.
    // Observed live as session `code-8282129a2247-0` running htop, orphan client stale by 158s.
    it('reclaims a slot our own (stale) client holds', async () => {
        const state = fakeState({ [SLOT_MAPPING_STATE_KEY]: { '0': name(0) } });
        const exec = fakeExec({ list: [owned(name(0), true, ME)], existing: [name(0)] });
        const opened: LaunchOptions[] = [];
        const { provider } = makeProvider({ state, exec, opened });

        await provider.initialize();

        expect(opened.map(targetSession)).toEqual([name(0)]); // re-attached, not abandoned
        expect(opened[0].shellArgs).toContain('-D');          // evicting the stale client
        expect(provider.mappedSlots()).toEqual([0]);
    });

    // The no-steal invariant, unchanged and now stated precisely: it is about sessions
    // this machine does NOT own. An attached session absent from our mapping belongs to
    // another client, and re-attaching would mirror keystrokes into their live terminal.
    it('never touches an attached session this client does not own (no steal)', async () => {
        const state = fakeState({}); // nothing mapped — this session is not ours
        const exec = fakeExec({ list: [row(name(0), true)], existing: [name(0)] });
        const opened: LaunchOptions[] = [];
        const { provider } = makeProvider({ state, exec, opened });

        await provider.initialize();

        expect(opened).toEqual([]);
        expect(provider.mappedSlots()).toEqual([]);
    });

    // A plain restore must never carry `-D` — evicting a client is reserved for the
    // reclaim path, so an ordinary reattach can't kick a second machine off by accident.
    it('does not pass -D when re-attaching a detached session', async () => {
        const state = fakeState({ [SLOT_MAPPING_STATE_KEY]: { '0': name(0) } });
        const exec = fakeExec({ list: [row(name(0), false)], existing: [name(0)] });
        const opened: LaunchOptions[] = [];
        const { provider } = makeProvider({ state, exec, opened });

        await provider.initialize();

        expect(opened.map(targetSession)).toEqual([name(0)]);
        expect(opened[0].shellArgs).not.toContain('-D');
    });
});

describe('reconnect re-reconcile (initialize is idempotent, no duplicate tab)', () => {
    // A transient SSH reconnect re-fires resolve-success on the *same* extension
    // host, so extension.ts calls initialize() again ("refresh provider state"). A
    // slot already backing an open terminal in this window must not spawn a second,
    // mirrored tab: reopen() skips slots already in openSlots, so only genuinely-not-
    // open survivors/orphans are (re)opened on the second pass.
    it('does not re-open an already-open survivor when initialize() runs again', async () => {
        const state = fakeState({ [SLOT_MAPPING_STATE_KEY]: { '0': name(0) } });
        const exec = fakeExec({ list: [row(name(0), false)], existing: [name(0)] });
        const opened: LaunchOptions[] = [];
        const { provider } = makeProvider({ state, exec, opened });

        await provider.initialize(); // first connect: restore slot 0 (opens once)
        await provider.initialize(); // reconnect: reconcile again — must not re-open

        expect(opened.map(targetSession)).toEqual([name(0)]); // opened exactly once
        expect(provider.mappedSlots()).toEqual([0]);
    });
});

describe('adoption (hand-off / reconciliation)', () => {
    it('re-attaches mapped, adopts detached-unmapped, leaves another client\'s attached', async () => {
        const state = fakeState({ [SLOT_MAPPING_STATE_KEY]: { '0': name(0) } });
        const exec = fakeExec({
            list: [row(name(0), false), row(name(1), false), row(name(2), true)],
            existing: [name(0)], // mapped slot 0's session still exists
        });
        const opened: LaunchOptions[] = [];
        const { provider } = makeProvider({ state, exec, opened });

        await provider.initialize();

        const openedSessions = opened.map(targetSession);
        expect(openedSessions).toContain(name(0)); // slot 0 re-attached (mapped)
        expect(openedSessions).toContain(name(1)); // slot 1 adopted (detached, unmapped)
        expect(openedSessions).not.toContain(name(2)); // slot 2 left (attached elsewhere)
        expect(provider.mappedSlots()).toEqual([0, 1]);
    });

    // Previously asserted that a zero-window session is left to the reaper. That input
    // cannot occur: tmux destroys a session when its last window closes, so `list-sessions`
    // never reports `#{session_windows}` below 1 — verified against real tmux 3.4 across
    // every session state reproducible on a live server, including sessions whose shell had
    // exited. The old expectation therefore pinned behaviour for an impossible input while
    // reading as though it covered a real corpse case. Adoption is the correct handling of
    // the input regardless: attaching an (impossible) empty session is harmless, whereas the
    // guard re-imported a predicate already proven dead once in the reap decision.
    it('adopts a detached session regardless of window count (zero-window cannot occur)', async () => {
        const exec = fakeExec({ list: [row(name(1), false, 0)] });
        const opened: LaunchOptions[] = [];
        const { provider } = makeProvider({ exec, opened });

        await provider.initialize();

        expect(opened.map(targetSession)).toEqual([name(1)]);
        expect(provider.mappedSlots()).toEqual([1]);
    });
});

describe('explicit close kills the session (no invisible leftovers)', () => {
    // A terminal the user explicitly closes must leave nothing behind. The previous
    // design "tombstoned" the slot instead: the slot was excluded from restore AND
    // adoption while its tmux session went on running on the remote forever — reachable
    // by nothing, visible to no one, surviving every reload. That is precisely the zombie
    // this fork promises never to create, and it shipped. Observed in the field:
    //
    //   tmux slot 2: mapped=yes tombstoned=yes open=no attached=no windows=1
    //       -> skip (user-closed (tombstoned))
    //
    // with `code-bcb9aa492263-2` still alive in `tmux ls`, holding a live shell the user
    // could not get back — reported as "1 lost". Close now means kill, which is also what
    // closing a terminal means in stock open-remote-ssh; nothing survives to be skipped,
    // so the tombstone concept is gone entirely.

    /** Flush pending microtasks/timers (the close handler kills fire-and-forget). */
    const flush = (): Promise<void> => new Promise<void>(res => setTimeout(res, 0));
    /** Every `kill-session` command the provider issued. */
    const kills = (exec: ReturnType<typeof fakeExec>): string[] =>
        exec.mock.calls.map(c => c[0]).filter(c => c.includes('kill-session'));

    /** Open slot 0 and hand back a `Terminal` double closed for `reason`. */
    async function openThenClose(reason: number | undefined, over: Parameters<typeof makeProvider>[0] = {}) {
        const made = makeProvider(over);
        const profile = await made.provider.provideTerminalProfile(); // slot 0
        const term = {
            creationOptions: optionsOf(profile),
            exitStatus: reason === undefined ? undefined : { code: undefined, reason },
        } as unknown as import('vscode').Terminal;
        made.provider.handleTerminalOpened(term);
        made.provider.handleTerminalClosed(term);
        await flush();
        return made;
    }

    it('kills the tmux session when the user closes the terminal (reason 3)', async () => {
        const { exec, provider, state } = await openThenClose(3);

        expect(kills(exec)).toEqual([buildKillSession(name(0))]);
        // The mapping goes with it: leaving it would make the next reload try to restore a
        // session that no longer exists, costing a pointless has-session round-trip.
        expect(provider.mappedSlots()).toEqual([]);
        expect(state.get(SLOT_MAPPING_STATE_KEY)).toEqual({});
    });

    // `onDidCloseTerminal` fires on *disposal*, for four distinct reasons — the
    // `TerminalExitReason` enum (upstream VS Code 1.71+): Unknown=0, Shutdown=1
    // "the window closed/reloaded", Process=2 "the shell process exited", User=3.
    // Only User is the user closing the terminal. Killing on Shutdown would destroy a
    // running Claude Code task every time the window closes — the exact opposite of what
    // this fork is for.
    it.each([
        [1, 'window shutdown/reload'],
        [2, 'shell process exit'],
        [0, 'unknown'],
    ])('never kills when the terminal closed for reason %i (%s)', async (reason) => {
        // The session is still there afterwards (only the user's close may end it).
        const { exec, provider } = await openThenClose(reason, { exec: fakeExec({ list: [row(name(0), false)] }) });

        expect(kills(exec)).toEqual([]);
        expect(provider.mappedSlots()).toEqual([0]); // still restorable on the next connect
    });

    // engines.vscode is ^1.70.2 and `exitStatus.reason` only exists from 1.71. On an older
    // host the close reason is unknowable, and the two possible mistakes are not
    // symmetric: wrongly keeping a session costs one stale terminal that the next reload
    // re-attaches, wrongly killing one destroys work that cannot be recovered. Keep it.
    it('never kills when the host reports no exit status at all (VS Code < 1.71)', async () => {
        const { exec, provider } = await openThenClose(undefined, { exec: fakeExec({ list: [row(name(0), false)] }) });

        expect(kills(exec)).toEqual([]);
        expect(provider.mappedSlots()).toEqual([0]);
    });

    it('frees the slot for reuse after an explicit close', async () => {
        const { provider } = await openThenClose(3);
        expect(targetSession(optionsOf(await provider.provideTerminalProfile()))).toBe(name(0));
    });

    it('survives a kill that fails on the remote without breaking the close path', async () => {
        // The session outliving a failed kill is the acceptable outcome: reconcile has no
        // tombstone to consult any more, so the next reload simply re-attaches it and the
        // user can see (and close) it again. Silently swallowing the failure is what must
        // not happen to the rest of the close handling.
        const exec = vi.fn(async (command: string) => {
            if (command.includes('kill-session')) {
                throw new Error('channel closed');
            }
            return { stdout: '', stderr: '' };
        }) as unknown as ReturnType<typeof fakeExec>;
        const { provider } = await openThenClose(3, { exec });

        expect(provider.mappedSlots()).toEqual([]);
    });

    it('restores a mapped detached slot on reload even after an earlier user close', async () => {
        // The regression this whole change exists to prevent: a slot the user once closed
        // must never become permanently unreachable while its session is still alive.
        const state = fakeState({ [SLOT_MAPPING_STATE_KEY]: { '0': name(0) } });
        const exec = fakeExec({ list: [row(name(0), false)], existing: [name(0)] });
        const opened: LaunchOptions[] = [];
        const { provider } = makeProvider({ state, exec, opened });

        await provider.initialize();

        expect(opened.map(targetSession)).toEqual([name(0)]);
        expect(provider.mappedSlots()).toEqual([0]);
    });

    it('adopts a live detached orphan left behind by a previous version\'s tombstone', async () => {
        // Upgrade path for anyone already carrying the shipped bug: 1.0.5 persisted
        // `tmux.tombstonedSlots.v1`, and those slots are exactly the sessions stranded on
        // the remote. Reading the key at all would keep them stranded, so it is gone —
        // the orphan is adopted like any other, and the stale key is cleared on persist.
        const state = fakeState({ 'tmux.tombstonedSlots.v1': [1] });
        const exec = fakeExec({ list: [row(name(1), false)] });
        const opened: LaunchOptions[] = [];
        const { provider } = makeProvider({ state, exec, opened });

        await provider.initialize();

        expect(opened.map(targetSession)).toEqual([name(1)]);
        expect(provider.mappedSlots()).toEqual([1]);
        expect(state.get('tmux.tombstonedSlots.v1')).toBeUndefined();
    });
});

describe('profile options (invisible + argv, no injection surface)', () => {
    it('returns tmux shellPath, the 02 argv builder output, and cwd', async () => {
        const { provider } = makeProvider({ historyLimit: 50000 });
        const options = optionsOf(await provider.provideTerminalProfile());
        expect(options.shellPath).toBe('tmux');
        expect(options.shellArgs).toEqual(
            buildAttachOrCreateArgv(name(0), CWD, undefined, { historyLimit: 50000, owner: ME }),
        );
        expect(options.cwd).toBe(CWD);
    });

    // `isTransient: true` opted these terminals out of VS Code's terminal persistence, on
    // the reasoning that tmux owns lifetime so VS Code should keep its hands off. That is
    // true of the *session* but not of the *window*: the same persistence layer is what
    // restores split and group layout, so opting out silently threw away every split the
    // user had made. They came back as separate tabs on every reload — reported twice from
    // the field. VS Code reviving a terminal is harmless here anyway: it relaunches the
    // same `new-session -A` argv, which re-attaches the very session it left.
    it('does not opt out of VS Code terminal persistence (that is what restores splits)', async () => {
        const { provider } = makeProvider();
        expect(optionsOf(await provider.provideTerminalProfile()).isTransient).toBeUndefined();
    });

    it('falls back to a bare `tmux` on PATH when the probe resolved no path', async () => {
        const { provider } = makeProvider(); // no tmuxPath
        const options = optionsOf(await provider.provideTerminalProfile());
        expect(options.shellPath).toBe('tmux');
    });

    it('launches tmux by the probe-resolved absolute path (nix / ~/.local/bin, not on the non-login PATH)', async () => {
        // VS Code spawns shellPath directly, not through a login shell, so a bare
        // `tmux` misses installs off the default PATH (nix profile, ~/.local/bin).
        // The bootstrap probe already resolved the absolute path via `command -v`;
        // the provider must launch that path.
        const tmuxPath = '/home/user/.nix-profile/bin/tmux';
        const { provider } = makeProvider({ tmuxPath });
        const options = optionsOf(await provider.provideTerminalProfile());
        expect(options.shellPath).toBe(tmuxPath);
    });

    it('uses the resolved tmux path for restored/adopted terminals too (reopen path)', async () => {
        // buildOptions backs both provideTerminalProfile *and* reopen; a restored
        // survivor must launch by the same absolute path, not a bare `tmux`.
        const tmuxPath = '/home/user/.local/bin/tmux';
        const state = fakeState({ [SLOT_MAPPING_STATE_KEY]: { '0': name(0) } });
        const exec = fakeExec({ list: [row(name(0), false)], existing: [name(0)] });
        const opened: LaunchOptions[] = [];
        const { provider } = makeProvider({ state, exec, opened, tmuxPath });

        await provider.initialize();

        expect(opened[0]?.shellPath).toBe(tmuxPath);
    });

    it('hands the probed path and version to the argv builder', async () => {
        const tmuxPath = '/opt/tmux/bin/tmux';
        const { provider } = makeProvider({ tmuxPath, tmuxVersion: '3.4', historyLimit: 777 });
        const options = optionsOf(await provider.provideTerminalProfile());
        expect(options.shellArgs).toEqual(
            buildAttachOrCreateArgv(name(0), CWD, undefined, { historyLimit: 777, tmuxPath, tmuxVersion: '3.4', owner: ME }),
        );
    });

    // A pty that inherits `TMUX` from the server environment makes tmux refuse to start
    // ("sessions should be nested with care") when it points at the same server; null
    // deletes the variable from the terminal's environment.
    it('unsets TMUX / TMUX_PANE in the launched terminal environment', async () => {
        const { provider } = makeProvider();
        expect(optionsOf(await provider.provideTerminalProfile()).env).toEqual({ TMUX: null, TMUX_PANE: null });
    });

    // The pty runs the probed binary; the exec-side list/has/kill must address the same one.
    it('runs list/has/kill through the probed tmux path', async () => {
        const tmuxPath = '/opt/tmux/bin/tmux';
        const state = fakeState({ [SLOT_MAPPING_STATE_KEY]: { '0': name(0) } });
        const exec = fakeExec({ list: [row(name(0), false)], existing: [name(0)] });
        const { provider } = makeProvider({ state, exec, tmuxPath });

        await provider.initialize();

        const commands = exec.mock.calls.map(call => call[0] as string);
        expect(commands.length).toBeGreaterThan(0);
        for (const command of commands) {
            expect(command).not.toMatch(/(^|[$(]|; )'?tmux'? /);
            expect(command).toContain(`'${tmuxPath}'`);
        }
    });

    it('defaults the history limit through to the 02 builder when unset', async () => {
        const { provider } = makeProvider();
        const options = optionsOf(await provider.provideTerminalProfile());
        expect(options.shellArgs).toEqual(buildAttachOrCreateArgv(name(0), CWD, undefined, { owner: ME }));
    });

    it('titles the tab like a shell (workspace folder), never "tmux" (invisible UX)', async () => {
        const { provider } = makeProvider();
        const options = optionsOf(await provider.provideTerminalProfile());
        expect(options.name).toBe('proj');
        expect(options.name).not.toContain('tmux');
    });

    it('persists the new slot→session mapping in workspaceState', async () => {
        const { provider, state } = makeProvider();
        await provider.provideTerminalProfile();
        expect(state.get(SLOT_MAPPING_STATE_KEY)).toEqual({ '0': name(0) });
        expect(provider.mappedSlots()).toEqual([0]);
    });
});

describe('readMapping (malformed persisted state, defensive parsing)', () => {
    // The constructor loads the persisted slot->sessionName mapping through
    // `readMapping`, which must tolerate a hand-edited or corrupted
    // workspaceState blob (bad key, bad value) by dropping just the bad entry
    // rather than throwing or resurrecting garbage slots.
    it('drops a non-numeric key, a negative slot, a non-integer slot, and a non-string value; keeps the valid entry', async () => {
        const state = fakeState({
            [SLOT_MAPPING_STATE_KEY]: {
                'x': name(9),
                '-1': name(9),
                '1.5': name(9),
                '0': 42,
                '3': name(3),
            },
        });
        const exec = fakeExec({ existing: [name(3)] });
        const { provider } = makeProvider({ state, exec });

        await provider.initialize();

        expect(provider.mappedSlots()).toEqual([3]);
    });

    it('treats a completely empty/missing persisted mapping as no survivors, without throwing', async () => {
        const { provider } = makeProvider({ state: fakeState({}) });
        expect(() => provider.mappedSlots()).not.toThrow();
        expect(provider.mappedSlots()).toEqual([]);
    });
});

describe('has-session verdicts (prune only on a confirmed absence)', () => {
    // Existence is read from tmux's exit status AND message (`classifyTmuxFailure`). Every
    // phrasing tmux actually uses for "not there" must prune the mapping; anything that only
    // says "could not ask" — or that client and server disagree — must keep it, because the
    // mapping is the only client-local record of which session belongs to which slot.
    const mappedState = () => fakeState({ [SLOT_MAPPING_STATE_KEY]: { '0': name(0) } });
    const answering = (code: number, message: string) => vi.fn(async (command: string): Promise<ExecResult> =>
        command.includes('has-session')
            ? hasReply(command, () => ({ code, message }))
            : { stdout: '', stderr: '' });

    it.each([
        `can't find session: placeholder`,
        `no server running on /tmp/tmux-1000/default`,
        `error connecting to /tmp/tmux-1000/default (No such file or directory)`,
    ])('prunes a mapped slot whose has-session reports: %s', async (message) => {
        const { provider } = makeProvider({ state: mappedState(), exec: answering(1, message) });

        await provider.initialize();

        expect(provider.mappedSlots()).toEqual([]); // pruned, not kept as a false survivor
    });

    it.each([
        ['unreachable', `error connecting to /tmp/tmux-1000/default (Permission denied)`],
        ['unreachable', ''],
        ['incompatible', 'protocol version mismatch (client 8, server 7)'],
    ])('keeps the mapping (and opens nothing) on an %s answer: %j', async (_verdict, message) => {
        const state = mappedState();
        const opened: LaunchOptions[] = [];
        const { provider } = makeProvider({ state, opened, exec: answering(1, message) });

        await provider.initialize();

        expect(provider.mappedSlots()).toEqual([0]);
        expect(state.get(SLOT_MAPPING_STATE_KEY)).toEqual({ '0': name(0) });
        expect(opened).toEqual([]);
    });

    it('keeps the mapping when a slot\'s answer line never came back', async () => {
        const exec = vi.fn(async (command: string): Promise<ExecResult> =>
            command.includes('has-session') ? { stdout: 'banner only\n', stderr: '' } : { stdout: '', stderr: '' });
        const { provider } = makeProvider({ state: mappedState(), exec });

        await provider.initialize();

        expect(provider.mappedSlots()).toEqual([0]);
    });
});

describe('reconcile cost (two remote round-trips, however many slots)', () => {
    it('asks about every mapped slot in ONE batched has-session call', async () => {
        const state = fakeState({ [SLOT_MAPPING_STATE_KEY]: { '0': name(0), '1': name(1), '2': name(2), '3': name(3) } });
        const exec = fakeExec({
            list: [0, 1, 2, 3].map(slot => row(name(slot), false)),
            existing: [name(0), name(1), name(3)],
        });
        const { provider } = makeProvider({ state, exec });

        await provider.initialize();

        const commands = exec.mock.calls.map(c => c[0]);
        expect(commands.filter(c => c.includes('has-session'))).toHaveLength(1);
        expect(hasTargets(commands.find(c => c.includes('has-session'))!)).toEqual([name(0), name(1), name(2), name(3)]);
        expect(commands).toHaveLength(2); // list + batched has
        expect(provider.mappedSlots()).toEqual([0, 1, 3]); // only the confirmed-absent slot pruned
    });

    it('skips the has-session round-trip entirely when nothing needs confirming', async () => {
        const exec = fakeExec();
        const { provider } = makeProvider({ exec });

        await provider.initialize();

        expect(exec.mock.calls.map(c => c[0]).filter(c => c.includes('has-session'))).toEqual([]);
    });
});

describe('a remote that never answers (deadline-bounded)', () => {
    // The production exec is `createRemoteExec(lazyExec, …)`: a half-dead link never closes
    // the stream, so without a deadline "New Terminal" would spin forever.
    const DEADLINE_MS = 8000;
    const hung = () => createRemoteExec(() => new Promise(() => { /* never settles */ }), DEADLINE_MS);

    afterEach(() => {
        vi.useRealTimers();
    });

    it('settles initialize() and keeps every mapping', async () => {
        vi.useFakeTimers();
        const state = fakeState({ [SLOT_MAPPING_STATE_KEY]: { '0': name(0) } });
        const { provider } = makeProvider({ state, rawExec: hung() });

        let settled = false;
        void provider.initialize().then(() => { settled = true; });
        await vi.advanceTimersByTimeAsync(2 * DEADLINE_MS);

        expect(settled).toBe(true);
        expect(provider.mappedSlots()).toEqual([0]);
    });

    it('settles provideTerminalProfile() with a plain shell and one info line', async () => {
        vi.useFakeTimers();
        const { provider, log } = makeProvider({ rawExec: hung() });

        const pending = provider.provideTerminalProfile();
        await vi.advanceTimersByTimeAsync(DEADLINE_MS);

        expect(optionsOf(await pending)).toEqual({});
        expect(log.info).toHaveBeenCalledTimes(1);
        expect(String(log.info.mock.calls[0][0])).not.toMatch(/tmux/i);
    });

    it('frees nothing it did not claim: the next terminal after recovery gets slot 0', async () => {
        vi.useFakeTimers();
        let alive = false;
        const rawExec = createRemoteExec(
            command => alive
                ? Promise.resolve({ stdout: command.includes('has-session') ? '' : '\n__rc=0\n', stderr: '' })
                : new Promise(() => { /* hung */ }),
            DEADLINE_MS,
        );
        const { provider } = makeProvider({ rawExec });

        const first = provider.provideTerminalProfile();
        await vi.advanceTimersByTimeAsync(DEADLINE_MS);
        expect(optionsOf(await first)).toEqual({});

        // Right after a failure the remote is not asked again (bug D: one deadline, not one
        // per call); once it has had time to recover, the next terminal asks and gets slot 0.
        alive = true;
        expect(optionsOf(await provider.provideTerminalProfile())).toEqual({});
        await vi.advanceTimersByTimeAsync(UNREACHABLE_RETRY_MS);
        const second = provider.provideTerminalProfile();
        await vi.advanceTimersByTimeAsync(0);
        expect(targetSession(optionsOf(await second))).toBe(name(0));
    });
});

describe('folderName (tab title from a remote cwd, edge inputs)', () => {
    // folderName titles the tab after the workspace folder — must degrade
    // sanely for edge-case remote paths instead of producing an empty title.
    it.each([
        ['/home/user/proj/', 'proj'],       // trailing slash
        ['/', '/'],                          // root: no segment after stripping the slash
        ['', ''],                            // empty cwd: falls back to the whole (empty) path
        ['/home/user//proj///', 'proj'],     // multiple trailing slashes
    ])('titles cwd %s as %s', async (cwd, expected) => {
        const provider = new TmuxTerminalProvider({
            ctx: { hostKey: HOST, workspaceKey: WS, cwd },
            exec: async (command: string) => ({ code: 0, ...await fakeExec()(command) }),
            state: fakeState(),
            openTerminal: () => { /* not exercised */ },
            log: { info: vi.fn(), trace: vi.fn() },
            clientId: ME,
        });
        const options = optionsOf(await provider.provideTerminalProfile());
        expect(options.name).toBe(expected);
    });
});

describe('slotFromCreationOptions (defensive parsing of shellArgs)', () => {
    // handleTerminalOpened parses the slot back out of `-s <name>` in
    // shellArgs. A malformed/foreign options object (here: "-s" present but as
    // the very last element, with no name following it) must resolve to
    // "not ours" rather than throwing or indexing past the array.
    it('does not throw when "-s" is the last shellArgs element with no value after it', () => {
        const { provider } = makeProvider();
        const dangling = { creationOptions: { shellPath: 'tmux', shellArgs: ['new-session', '-s'] } } as unknown as import('vscode').Terminal;

        expect(() => provider.handleTerminalOpened(dangling)).not.toThrow();
        // Not recognised as one of ours, so closing it must not free any slot.
        expect(() => provider.handleTerminalClosed(dangling)).not.toThrow();
    });
});

describe('coexisting with VS Code terminal persistence (the cost of restoring splits)', () => {
    // Dropping `isTransient` hands restore-on-reload back to VS Code, which is the only way
    // to get split layout back — but it means two things now restore the same slot: VS Code
    // reviving its persisted terminal, and this provider's reconcile. Both land on the same
    // `new-session -A`, so a duplicate is not a lost session — it is two tmux clients on one
    // session, mirroring each other's keystrokes and clamping the window to the smaller of
    // the two. Neither side can be made to win the race (VS Code revives a remote terminal
    // once the server connection is up, which is exactly when reconcile runs), so the
    // provider is written to be correct whichever arrives first.

    /** A `Terminal` double whose creationOptions name `slot`'s session. */
    const revived = (slot: number, dispose = vi.fn()) => ({
        creationOptions: { shellArgs: ['new-session', '-A', '-s', name(slot)] },
        dispose,
    } as unknown as import('vscode').Terminal);

    it('skips a slot VS Code has already revived', async () => {
        // VS Code won the race: its revived terminal is live before reconcile decides.
        // Re-attaching would put a second client on the same session.
        const state = fakeState({ [SLOT_MAPPING_STATE_KEY]: { '0': name(0) } });
        const exec = fakeExec({ list: [row(name(0), true)], existing: [name(0)] });
        const opened: LaunchOptions[] = [];
        const { provider } = makeProvider({ state, exec, opened, listTerminals: () => [revived(0)] });

        await provider.initialize();

        expect(opened).toEqual([]);
        expect(provider.mappedSlots()).toEqual([0]); // still ours, just already on screen
    });

    it('still restores the slots VS Code did not revive', async () => {
        // Partial revive is the normal case: VS Code only persists terminals from ITS last
        // window, so a hand-off (or a slot it dropped) still needs reconcile.
        const state = fakeState({ [SLOT_MAPPING_STATE_KEY]: { '0': name(0), '1': name(1) } });
        const exec = fakeExec({ list: [row(name(0), true), row(name(1), false)], existing: [name(0), name(1)] });
        const opened: LaunchOptions[] = [];
        const { provider } = makeProvider({ state, exec, opened, listTerminals: () => [revived(0)] });

        await provider.initialize();

        expect(opened.map(targetSession)).toEqual([name(1)]);
    });

    it('ignores foreign terminals when seeding from the window', async () => {
        // A plain shell, or another workspace's session, must not reserve one of our slots.
        const foreign = { creationOptions: { shellArgs: ['-l'] } } as unknown as import('vscode').Terminal;
        const state = fakeState({ [SLOT_MAPPING_STATE_KEY]: { '0': name(0) } });
        const exec = fakeExec({ list: [row(name(0), false)], existing: [name(0)] });
        const opened: LaunchOptions[] = [];
        const { provider } = makeProvider({ state, exec, opened, listTerminals: () => [foreign] });

        await provider.initialize();

        expect(opened.map(targetSession)).toEqual([name(0)]);
    });

    it('disposes a revived terminal that arrives after reconcile already restored its slot', async () => {
        // Reconcile won the race, then VS Code's revive lands anyway. Left alone this is the
        // duplicate: two tabs, two tmux clients, one session, mirrored keystrokes.
        const state = fakeState({ [SLOT_MAPPING_STATE_KEY]: { '0': name(0) } });
        const exec = fakeExec({ list: [row(name(0), false)], existing: [name(0)] });
        const opened: LaunchOptions[] = [];
        const { provider } = makeProvider({ state, exec, opened });
        await provider.initialize();
        provider.handleTerminalOpened(revived(0)); // the terminal reconcile opened

        const dispose = vi.fn();
        provider.handleTerminalOpened(revived(0, dispose)); // the late duplicate

        expect(dispose).toHaveBeenCalled();
    });

    // The dangerous interaction: disposing a terminal fires onDidCloseTerminal, and VS Code
    // may well report that as a user close — which now KILLS the session. Discarding a
    // duplicate tab must never take the session down with it.
    it('never kills the session when discarding a duplicate', async () => {
        const state = fakeState({ [SLOT_MAPPING_STATE_KEY]: { '0': name(0) } });
        const exec = fakeExec({ list: [row(name(0), false)], existing: [name(0)] });
        const { provider } = makeProvider({ state, exec });
        await provider.initialize();
        provider.handleTerminalOpened(revived(0));

        const duplicate = {
            creationOptions: { shellArgs: ['new-session', '-A', '-s', name(0)] },
            exitStatus: { code: undefined, reason: 3 }, // VS Code reports it as a user close
            dispose: vi.fn(),
        } as unknown as import('vscode').Terminal;
        provider.handleTerminalOpened(duplicate);
        provider.handleTerminalClosed(duplicate);
        await new Promise(res => setTimeout(res, 0));

        expect(exec.mock.calls.map(c => c[0]).filter(c => c.includes('kill-session'))).toEqual([]);
        expect(provider.mappedSlots()).toEqual([0]); // the surviving terminal keeps the slot
    });

    it('lets a genuinely new terminal on a freed slot through', async () => {
        // The duplicate guard keys off a slot that is currently held. Once the holder
        // closes, the same slot must be openable again — otherwise close-then-reopen breaks.
        const { provider } = makeProvider();
        await provider.provideTerminalProfile(); // slot 0
        const first = revived(0);
        provider.handleTerminalOpened(first);
        provider.handleTerminalClosed(first);

        const dispose = vi.fn();
        provider.handleTerminalOpened(revived(0, dispose));

        expect(dispose).not.toHaveBeenCalled();
    });
});

describe('revive grace (letting VS Code go first, deterministically)', () => {
    // Seeding from the window only helps if VS Code's revive has actually landed by the
    // time reconcile looks. It has not, reliably: a remote terminal revives once the server
    // connection is up, which is the same moment reconcile starts. Losing that race is not
    // merely untidy now that `restore-takeover` passes tmux `-D` — reconcile would evict the
    // client VS Code just reconnected, leaving the user staring at a detached tab. So
    // reconcile waits a beat first, and the wait is a real (injectable) parameter rather
    // than an accident of scheduling.

    const revived = (slot: number) => ({
        creationOptions: { shellArgs: ['new-session', '-A', '-s', name(slot)] },
        dispose: vi.fn(),
    } as unknown as import('vscode').Terminal);

    it('waits for the grace period before reading the window', async () => {
        // The terminal is not there when initialize() is called; it appears during the wait,
        // exactly as a real revive does. Reconcile must see it and leave that slot alone.
        const terminals: import('vscode').Terminal[] = [];
        const state = fakeState({ [SLOT_MAPPING_STATE_KEY]: { '0': name(0) } });
        const exec = fakeExec({ list: [row(name(0), true)], existing: [name(0)] });
        const opened: LaunchOptions[] = [];
        const { provider } = makeProvider({
            state, exec, opened,
            listTerminals: () => terminals,
            reviveGraceMs: 20,
        });

        const done = provider.initialize();
        terminals.push(revived(0)); // VS Code's revive lands during the grace
        await done;

        expect(opened).toEqual([]);
    });

    it('restores normally once the grace has passed with nothing revived', async () => {
        // A fresh machine has nothing to revive, and must not be punished for waiting.
        const state = fakeState({ [SLOT_MAPPING_STATE_KEY]: { '0': name(0) } });
        const exec = fakeExec({ list: [row(name(0), false)], existing: [name(0)] });
        const opened: LaunchOptions[] = [];
        const { provider } = makeProvider({ state, exec, opened, reviveGraceMs: 20 });

        await provider.initialize();

        expect(opened.map(targetSession)).toEqual([name(0)]);
    });

    // THE 1.0.8 BUG, as a test. VS Code does not replay a revived terminal's stored
    // shellArgs — it calls provideTerminalProfile again — so a provider that answers with a
    // freshly allocated slot mints a brand-new session per revived terminal. Field log:
    // "2 re-attached" followed by "new slot 1", "new slot 2" a second later, leaving four
    // tabs where two belonged and two empty sessions the user had to close by hand.
    it('answers a revive with a queued session instead of minting a new one', async () => {
        const state = fakeState({ [SLOT_MAPPING_STATE_KEY]: { '0': name(0), '3': name(3) } });
        const exec = fakeExec({ list: [row(name(0), false), row(name(3), false)], existing: [name(0), name(3)] });
        const opened: LaunchOptions[] = [];
        const { provider } = makeProvider({ state, exec, opened, reviveGraceMs: 50 });

        const init = provider.initialize();
        // VS Code revives its two persisted terminals: two profile requests, no context.
        const first = await provider.provideTerminalProfile();
        const second = await provider.provideTerminalProfile();
        await init;

        expect([targetSession(optionsOf(first)), targetSession(optionsOf(second))])
            .toEqual([name(0), name(3)]);
        expect(opened).toEqual([]); // the queue was consumed, so nothing is opened on top
    });

    // THE FIELD BUG a fixed grace cannot fix (report of 2026-07-24, 04:19 log, v1.0.9).
    // Two split terminals, reload, and four tabs came back: two unsplit, two split.
    //
    //   04:19:28.670  tmux terminals: 0 to re-attach, 2 to reclaim, ...   <- queue built
    //   04:19:31.172  tmux terminals: opened 2 session(s) VS Code did not restore
    //   04:19:33.450  tmux terminal: new slot 2 (...)   <- VS Code's revive, 2.3s too late
    //   04:19:34.038  tmux terminal: new slot 3 (...)
    //
    // The queue was handed out correctly; it was just *closed too early*. VS Code revives
    // when the workbench finishes restoring, which on a real remote is seconds after our
    // probes finish — so the 2.5s timer expired, the drain opened both sessions itself
    // (as plain unsplit tabs), and the revive that arrived next found an empty queue and
    // minted two brand-new sessions with the restored split layout wrapped around them.
    //
    // No zombies (all four tabs were attached to real sessions), but a duplicate is a
    // duplicate. The wait must end on the *claims*, not on a clock: the timer is only a
    // backstop for a revive that never comes.
    it('waits for a revive that lands long after the fixed grace would have fired', async () => {
        const state = fakeState({ [SLOT_MAPPING_STATE_KEY]: { '0': name(0), '1': name(1) } });
        const exec = fakeExec({
            // Attached, because the closed window's pty outlives it — hence "to reclaim".
            list: [owned(name(0), true, ME), owned(name(1), true, ME)],
            existing: [name(0), name(1)],
        });
        const opened: LaunchOptions[] = [];
        const { provider } = makeProvider({ state, exec, opened, reviveGraceMs: 5, reviveDeadlineMs: 2000 });

        const init = provider.initialize();
        // The workbench takes its time: far past the grace, as in the log above.
        await new Promise(resolve => setTimeout(resolve, 40));
        const first = await provider.provideTerminalProfile();
        const second = await provider.provideTerminalProfile();
        await init;

        // Both revives get their own session back...
        expect([targetSession(optionsOf(first)), targetSession(optionsOf(second))])
            .toEqual([name(0), name(1)]);
        // ...and nothing is opened on top of them, so two tabs, not four.
        expect(opened).toEqual([]);
    });

    // FOLLOW-UP FROM THE SAME RIG, on v1.1.0. The duplicate was gone — two sessions, two
    // tabs — but the second terminal took eleven seconds to appear:
    //
    //   46.868  tmux terminals: 2 to re-attach, ...
    //   48.386  tmux terminal: slot 0 claimed from the restore queue   <- one revive, 1.5s in
    //   59.402  tmux terminals: no revive after 10000ms, opening 1 queued session(s) directly
    //
    // VS Code revived ONE of the two persisted terminals, and waiting for *all* of them meant
    // the odd one out paid the full backstop. But the first claim is itself the answer: revive
    // is demonstrably running, and revives arrive in a burst (0.6s apart in the earlier log).
    // So once anything has been claimed, a short quiet period is enough to conclude the burst
    // is over — the long deadline is only for a revive that never starts at all.
    it('stops waiting a beat after the last claim instead of holding for the deadline', async () => {
        const state = fakeState({ [SLOT_MAPPING_STATE_KEY]: { '0': name(0), '1': name(1) } });
        const exec = fakeExec({ list: [row(name(0), false), row(name(1), false)], existing: [name(0), name(1)] });
        const opened: LaunchOptions[] = [];
        const { provider } = makeProvider({
            state, exec, opened,
            reviveGraceMs: 5,
            // A deadline long enough that reaching it is unmistakable in the elapsed time.
            reviveDeadlineMs: 5000,
            reviveQuietMs: 30,
        });

        const startedAt = Date.now();
        const init = provider.initialize();
        // VS Code revives exactly one of the two, as in the log above.
        const first = await provider.provideTerminalProfile();
        await init;
        const elapsed = Date.now() - startedAt;

        expect(targetSession(optionsOf(first))).toBe(name(0));
        // The unclaimed one still gets its terminal...
        expect(opened.map(targetSession)).toEqual([name(1)]);
        // ...without waiting out the backstop, which is what the user actually felt.
        expect(elapsed).toBeLessThan(1500);
    });

    // Each new claim has to re-arm the quiet period, or a burst slower than one quiet window
    // would be cut off half-way and the remaining sessions opened as duplicates of terminals
    // VS Code was still in the middle of reviving.
    it('re-arms the quiet period on every claim so a slow burst is not cut off', async () => {
        const state = fakeState({ [SLOT_MAPPING_STATE_KEY]: { '0': name(0), '1': name(1), '2': name(2) } });
        const exec = fakeExec({
            list: [row(name(0), false), row(name(1), false), row(name(2), false)],
            existing: [name(0), name(1), name(2)],
        });
        const opened: LaunchOptions[] = [];
        const { provider } = makeProvider({
            state, exec, opened, reviveGraceMs: 5, reviveDeadlineMs: 5000, reviveQuietMs: 60,
        });

        const init = provider.initialize();
        const claimed: string[] = [];
        // Three revives, each landing after a gap shorter than the quiet window but well
        // past the point a single un-rearmed window would have expired.
        for (let i = 0; i < 3; i++) {
            await new Promise(resolve => setTimeout(resolve, 40));
            claimed.push(targetSession(optionsOf(await provider.provideTerminalProfile())));
        }
        await init;

        expect(claimed).toEqual([name(0), name(1), name(2)]);
        expect(opened).toEqual([]); // nothing opened on top of a revive still in progress
    });

    // The backstop must still fire, or a mapping with no revive behind it (persistence off,
    // or a cold start that revived nothing) would leave the user staring at no terminals
    // while their sessions sit alive on the remote.
    it('gives up on the revive at the deadline and opens the queue itself', async () => {
        const state = fakeState({ [SLOT_MAPPING_STATE_KEY]: { '0': name(0) } });
        const exec = fakeExec({ list: [owned(name(0), true, ME)], existing: [name(0)] });
        const opened: LaunchOptions[] = [];
        const { provider } = makeProvider({ state, exec, opened, reviveGraceMs: 5, reviveDeadlineMs: 30 });

        await provider.initialize(); // no profile request ever arrives

        expect(opened.map(targetSession)).toEqual([name(0)]);
    });

    // A reload *within* the reconnection grace reconnects the existing pty instead of
    // relaunching it, so that terminal never calls the provider — the queue would never
    // empty and the wait would burn its full deadline for nothing. Seeing the slot land in
    // the window has to end the wait just as a claim does.
    it('ends the wait when a revived terminal appears without a profile request', async () => {
        const terminals: import('vscode').Terminal[] = [];
        const state = fakeState({ [SLOT_MAPPING_STATE_KEY]: { '0': name(0) } });
        const exec = fakeExec({ list: [row(name(0), true)], existing: [name(0)] });
        const opened: LaunchOptions[] = [];
        const { provider } = makeProvider({
            state, exec, opened,
            listTerminals: () => terminals,
            reviveGraceMs: 5,
            // Long enough that finishing quickly can only mean the window was observed.
            reviveDeadlineMs: 5000,
        });

        const init = provider.initialize();
        setTimeout(() => terminals.push(revived(0)), 30);
        await init;

        expect(opened).toEqual([]);
    });

    // Hand-off has nothing of ours to revive: the sessions come from the remote (adopt),
    // not from this client's mapping, so there is no persisted terminal coming for them and
    // waiting on one would just delay the terminals for the whole deadline.
    it('does not wait on a revive for sessions adopted from another machine', async () => {
        const state = fakeState(); // empty mapping — a different machine created these
        const exec = fakeExec({ list: [row(name(0), false)], existing: [name(0)] });
        const opened: LaunchOptions[] = [];
        const { provider } = makeProvider({ state, exec, opened, reviveGraceMs: 5, reviveDeadlineMs: 5000 });

        await provider.initialize();

        expect(opened.map(targetSession)).toEqual([name(0)]);
    });

    it('opens only what the revive left unclaimed', async () => {
        // VS Code persisted one terminal, we have two sessions: the odd one out still needs
        // a terminal, or a session goes unreachable.
        const state = fakeState({ [SLOT_MAPPING_STATE_KEY]: { '0': name(0), '3': name(3) } });
        const exec = fakeExec({ list: [row(name(0), false), row(name(3), false)], existing: [name(0), name(3)] });
        const opened: LaunchOptions[] = [];
        const { provider } = makeProvider({ state, exec, opened, reviveGraceMs: 20 });

        const init = provider.initialize();
        const first = await provider.provideTerminalProfile();
        await init;

        expect(targetSession(optionsOf(first))).toBe(name(0));
        expect(opened.map(targetSession)).toEqual([name(3)]);
    });

    it('opens everything when there is nothing to revive (hand-off to a fresh machine)', async () => {
        const state = fakeState({ [SLOT_MAPPING_STATE_KEY]: { '0': name(0) } });
        const exec = fakeExec({ list: [row(name(0), false)], existing: [name(0)] });
        const opened: LaunchOptions[] = [];
        const { provider } = makeProvider({ state, exec, opened, reviveGraceMs: 20 });

        await provider.initialize();

        expect(opened.map(targetSession)).toEqual([name(0)]);
    });

    // Once the queue is empty the provider is back to ordinary allocation — a user opening a
    // terminal after restore has settled must get a NEW session, not a second view of one.
    it('mints a new session once the queue is empty', async () => {
        const state = fakeState({ [SLOT_MAPPING_STATE_KEY]: { '0': name(0) } });
        const exec = fakeExec({ list: [row(name(0), false)], existing: [name(0)] });
        const { provider } = makeProvider({ state, exec, reviveGraceMs: 0 });

        await provider.initialize();

        expect(targetSession(optionsOf(await provider.provideTerminalProfile()))).toBe(name(1));
    });

    // A reconnect re-plans. Entries queued by the previous pass name slots that already have
    // terminals, and handing one out would put a second client on a live session.
    it('rebuilds the queue from scratch on a reconnect', async () => {
        const state = fakeState({ [SLOT_MAPPING_STATE_KEY]: { '0': name(0) } });
        const exec = fakeExec({ list: [row(name(0), false)], existing: [name(0)] });
        const opened: LaunchOptions[] = [];
        const { provider } = makeProvider({ state, exec, opened, reviveGraceMs: 0 });

        await provider.initialize(); // slot 0 restored, queue drained
        await provider.initialize(); // reconnect

        expect(opened.map(targetSession)).toEqual([name(0)]); // not restored twice
        expect(targetSession(optionsOf(await provider.provideTerminalProfile()))).toBe(name(1));
    });
});

describe('probe failures must not be read as "the session is gone"', () => {
    // `refreshRemote` already refuses to treat an empty list-sessions as proof of absence,
    // because the probe degrades to "no sessions" when the channel fails — one blip would
    // otherwise wipe every mapping. The narrower `has-session` probe that settles existence
    // had the opposite habit: it caught the exec rejection and reported "gone", so the exact
    // blip the first guard was written to survive still pruned the whole mapping one slot at
    // a time. A mapping is client-local and is the only record of which session belongs to
    // which slot; losing it strands live work behind an adoption that may never happen.

    it('keeps the mapping when the existence probe cannot be delivered', async () => {
        const state = fakeState({ [SLOT_MAPPING_STATE_KEY]: { '0': name(0) } });
        const exec = vi.fn(async (command: string): Promise<ExecResult> => {
            if (command.includes('has-session')) {
                throw new Error('channel closed');
            }
            return { stdout: '', stderr: '' }; // list-sessions degrades to "saw nothing"
        }) as unknown as ReturnType<typeof fakeExec>;
        const { provider } = makeProvider({ state, exec, reviveGraceMs: 0 });

        await provider.initialize();

        expect(provider.mappedSlots()).toEqual([0]);
        expect(state.get(SLOT_MAPPING_STATE_KEY)).toEqual({ '0': name(0) });
    });

    it('still prunes when the probe is delivered and answers "no such session"', async () => {
        // The distinction has to cut both ways, or a genuinely dead mapping lives forever and
        // every reconnect spawns a terminal onto nothing.
        const state = fakeState({ [SLOT_MAPPING_STATE_KEY]: { '0': name(0) } });
        const exec = fakeExec({ list: [], existing: [] }); // reachable, session absent
        const opened: LaunchOptions[] = [];
        const { provider } = makeProvider({ state, exec, opened, reviveGraceMs: 0 });

        await provider.initialize();

        expect(provider.mappedSlots()).toEqual([]);
        expect(opened).toEqual([]);
    });

    it('does not queue a restore for a slot whose existence is unknown', async () => {
        // Keeping the mapping is right; opening a terminal onto a session we could not
        // confirm is not — `-A` would silently create an empty new one under that name.
        const state = fakeState({ [SLOT_MAPPING_STATE_KEY]: { '0': name(0) } });
        const exec = vi.fn(async (command: string) => {
            if (command.includes('has-session')) {
                throw new Error('channel closed');
            }
            return { stdout: '', stderr: '' };
        }) as unknown as ReturnType<typeof fakeExec>;
        const opened: LaunchOptions[] = [];
        const { provider } = makeProvider({ state, exec, opened, reviveGraceMs: 0 });

        await provider.initialize();

        expect(opened).toEqual([]);
    });
});

describe('a reconnect is not a revive', () => {
    // The restore queue exists to be consumed by VS Code reviving persisted terminals, which
    // only happens when a window is (re)built. A reconnect — the SSH link dropped and came
    // back, same window, same tabs — produces no revive calls at all, so holding the queue
    // open there just leaves a trap: the user's next "New Terminal" would silently become a
    // re-attach instead of the new session they asked for.

    it('drains immediately on a refresh instead of waiting for a revive', async () => {
        const state = fakeState({ [SLOT_MAPPING_STATE_KEY]: { '0': name(0) } });
        const exec = fakeExec({ list: [row(name(0), false)], existing: [name(0)] });
        const opened: LaunchOptions[] = [];
        // A grace long enough that a test which waited for it would time out first.
        const { provider } = makeProvider({ state, exec, opened, reviveGraceMs: 60_000 });

        await provider.initialize({ awaitRevive: false });

        expect(opened.map(targetSession)).toEqual([name(0)]);
    });

    it('leaves no queue for a later new terminal to be answered from', async () => {
        const state = fakeState({ [SLOT_MAPPING_STATE_KEY]: { '0': name(0) } });
        const exec = fakeExec({ list: [row(name(0), false)], existing: [name(0)] });
        const { provider } = makeProvider({ state, exec, reviveGraceMs: 60_000 });

        await provider.initialize({ awaitRevive: false });

        expect(targetSession(optionsOf(await provider.provideTerminalProfile()))).toBe(name(1));
    });
});

describe('window reload', () => {
    // A reload rebuilds the window: the extension host restarts, workspaceState survives, and
    // VS Code restores its terminals — by EITHER reconnecting the still-live remote pty
    // (inside the reconnection grace, no provider call) OR relaunching, which calls the
    // profile provider. Both happen, sometimes in the same reload, and each needs a different
    // half of the machinery: the pty reconnect is caught by reading the window, the relaunch
    // by the restore queue.

    const revived = (slot: number) => ({
        creationOptions: { shellArgs: ['new-session', '-A', '-s', name(slot)] },
        dispose: vi.fn(),
    } as unknown as import('vscode').Terminal);

    it('handles a reload that reconnects one pty and relaunches the other', async () => {
        const state = fakeState({ [SLOT_MAPPING_STATE_KEY]: { '0': name(0), '1': name(1) } });
        const exec = fakeExec({ list: [row(name(0), true), row(name(1), false)], existing: [name(0), name(1)] });
        const opened: LaunchOptions[] = [];
        // Slot 0's pty came back on its own; slot 1's did not.
        const { provider } = makeProvider({
            state, exec, opened, reviveGraceMs: 50,
            listTerminals: () => [revived(0)],
        });

        const init = provider.initialize();
        const relaunched = await provider.provideTerminalProfile(); // VS Code relaunching slot 1
        await init;

        expect(targetSession(optionsOf(relaunched))).toBe(name(1));
        expect(opened).toEqual([]); // slot 0 was already on screen, slot 1 was claimed
        expect(provider.mappedSlots()).toEqual([0, 1]);
    });

    it('does not resurrect a terminal the user closed before reloading', async () => {
        // The close killed the session and dropped the mapping, so a reload has nothing to
        // restore for that slot — and must not invent one.
        const state = fakeState({ [SLOT_MAPPING_STATE_KEY]: { '0': name(0) } });
        const exec = fakeExec({ list: [], existing: [] });
        const opened: LaunchOptions[] = [];
        const { provider } = makeProvider({ state, exec, opened, reviveGraceMs: 0 });

        await provider.initialize();

        expect(opened).toEqual([]);
        expect(provider.mappedSlots()).toEqual([]);
    });

    // Reconnect storms are real (a flaky link re-resolves repeatedly), and each resolve
    // re-plans. A drain scheduled by an earlier pass must not fire into the queue a later
    // pass is still building — it would hand out slots against a half-finished decision.
    it('never lets a stale pass drain the queue of a newer one', async () => {
        const state = fakeState({ [SLOT_MAPPING_STATE_KEY]: { '0': name(0) } });
        const exec = fakeExec({ list: [row(name(0), false)], existing: [name(0)] });
        const opened: LaunchOptions[] = [];
        const { provider } = makeProvider({ state, exec, opened, reviveGraceMs: 30 });

        const first = provider.initialize();   // will try to drain after 30ms
        const second = provider.initialize();  // supersedes it
        await Promise.all([first, second]);

        expect(opened.map(targetSession)).toEqual([name(0)]); // opened once, not twice
    });
});

describe('races', () => {
    const flush = (): Promise<void> => new Promise<void>(res => setTimeout(res, 0));

    // R1. VS Code reviving several terminals asks for several profiles at once. Allocation
    // read the free slot, then AWAITED a remote probe before recording the claim — so two
    // concurrent calls both read "0 is free", both awaited, and both took slot 0. Two
    // terminals on one tmux session: shared view, mirrored keystrokes. The window between
    // choosing a slot and claiming it has to contain no await at all.
    it('gives concurrent profile requests distinct slots', async () => {
        const { provider } = makeProvider();

        const profiles = await Promise.all([
            provider.provideTerminalProfile(),
            provider.provideTerminalProfile(),
            provider.provideTerminalProfile(),
        ]);

        const slots = profiles.map(p => targetSession(optionsOf(p)));
        expect(new Set(slots).size).toBe(3);
        expect(slots.sort()).toEqual([name(0), name(1), name(2)].sort());
    });

    it('gives concurrent revive requests distinct queued sessions', async () => {
        const state = fakeState({ [SLOT_MAPPING_STATE_KEY]: { '0': name(0), '1': name(1) } });
        const exec = fakeExec({ list: [row(name(0), false), row(name(1), false)], existing: [name(0), name(1)] });
        const { provider } = makeProvider({ state, exec, reviveGraceMs: 50 });

        const init = provider.initialize();
        const profiles = await Promise.all([
            provider.provideTerminalProfile(),
            provider.provideTerminalProfile(),
        ]);
        await init;

        expect(new Set(profiles.map(p => targetSession(optionsOf(p)))).size).toBe(2);
    });

    // R2. Closing a terminal kills its session, but the close handler is synchronous so the
    // kill is in flight when it returns — and the slot is free again immediately. Open a new
    // terminal fast enough and `new-session -A` on the reused name races the `kill-session`
    // still travelling to the remote. Lose that race and the brand-new terminal's session is
    // destroyed under it. A slot with a kill in flight is not free yet.
    it('does not reuse a slot whose kill is still in flight', async () => {
        let releaseKill!: () => void;
        const killGate = new Promise<void>(res => { releaseKill = res; });
        const exec = vi.fn(async (command: string) => {
            if (command.includes('kill-session')) {
                await killGate;
            }
            return { stdout: '', stderr: '' };
        }) as unknown as ReturnType<typeof fakeExec>;
        const { provider } = makeProvider({ exec });

        const profile = await provider.provideTerminalProfile(); // slot 0
        const term = {
            creationOptions: optionsOf(profile),
            exitStatus: { code: undefined, reason: 3 },
        } as unknown as import('vscode').Terminal;
        provider.handleTerminalOpened(term);
        provider.handleTerminalClosed(term); // kill starts, does not finish
        await flush();

        expect(targetSession(optionsOf(await provider.provideTerminalProfile()))).toBe(name(1));

        releaseKill();
        await flush();
    });

    it('frees the slot again once the kill has landed', async () => {
        // The guard must be temporary: a slot held forever by a completed kill would push
        // every later terminal to a higher number for the life of the window.
        const { provider } = makeProvider();
        const profile = await provider.provideTerminalProfile(); // slot 0
        const term = {
            creationOptions: optionsOf(profile),
            exitStatus: { code: undefined, reason: 3 },
        } as unknown as import('vscode').Terminal;
        provider.handleTerminalOpened(term);
        provider.handleTerminalClosed(term);
        await flush();

        expect(targetSession(optionsOf(await provider.provideTerminalProfile()))).toBe(name(0));
    });

    it('frees the slot even when the kill fails', async () => {
        const exec = vi.fn(async (command: string) => {
            if (command.includes('kill-session')) {
                throw new Error('channel closed');
            }
            return { stdout: '', stderr: '' };
        }) as unknown as ReturnType<typeof fakeExec>;
        const { provider } = makeProvider({ exec });
        const profile = await provider.provideTerminalProfile();
        const term = {
            creationOptions: optionsOf(profile),
            exitStatus: { code: undefined, reason: 3 },
        } as unknown as import('vscode').Terminal;
        provider.handleTerminalOpened(term);
        provider.handleTerminalClosed(term);
        await flush();

        expect(targetSession(optionsOf(await provider.provideTerminalProfile()))).toBe(name(0));
    });

    // R3. Every mutation persists the whole derived record. Two overlapping writes can land
    // out of order, leaving workspaceState holding the older snapshot — and that record is
    // the only thing telling the next window which session belongs to which slot.
    it('persists slot state in order under concurrent writes', async () => {
        const writes: Array<Record<string, string>> = [];
        const state = {
            keys: (): string[] => [],
            get: (_key: string, def?: unknown): unknown => def,
            update: async (key: string, value: unknown): Promise<void> => {
                if (key === SLOT_MAPPING_STATE_KEY) {
                    // Invert the natural completion order: an unserialised implementation
                    // lets the earlier, smaller snapshot land last.
                    const delay = 20 - writes.length * 10;
                    await new Promise(res => setTimeout(res, Math.max(delay, 0)));
                    writes.push(value as Record<string, string>);
                }
            },
        };
        const { provider } = makeProvider({ state });

        await Promise.all([
            provider.provideTerminalProfile(),
            provider.provideTerminalProfile(),
        ]);
        await flush();

        expect(Object.keys(writes[writes.length - 1])).toHaveLength(2); // newest snapshot wins
    });
});

describe('hand-off across machines (PC -> laptop -> PC)', () => {
    // The scenario this fork exists for, end to end: start two things on the PC, move to the
    // laptop and start two more, close the laptop, stop the PC, come back to the PC — all
    // four should still be there. The PC restores the two it owns (they are in ITS
    // client-local mapping) and *adopts* the two the laptop left behind (unmapped here, but
    // unheld on the remote, and in this workspace's namespace).

    it('lands a second machine on fresh slots instead of stealing the first machine\'s', async () => {
        // Laptop connecting while the PC holds slots 0 and 1: no mapping of its own, and both
        // remote sessions attached. Re-attaching either would mirror keystrokes into the PC.
        const exec = fakeExec({ list: [row(name(0), true), row(name(1), true)] });
        const opened: LaunchOptions[] = [];
        const { provider } = makeProvider({ exec, opened, reviveGraceMs: 0 });

        await provider.initialize();
        const first = await provider.provideTerminalProfile();
        const second = await provider.provideTerminalProfile();

        expect(opened).toEqual([]); // nothing adopted — both are held
        expect([targetSession(optionsOf(first)), targetSession(optionsOf(second))])
            .toEqual([name(2), name(3)]);
    });

    it('restores its own two and adopts the other machine\'s two on return', async () => {
        // Back at the PC: it maps 0 and 1; the laptop's 2 and 3 are detached on the remote.
        const state = fakeState({ [SLOT_MAPPING_STATE_KEY]: { '0': name(0), '1': name(1) } });
        const exec = fakeExec({
            list: [row(name(0), false), row(name(1), false), row(name(2), false), row(name(3), false)],
            existing: [name(0), name(1), name(2), name(3)],
        });
        const opened: LaunchOptions[] = [];
        const { provider } = makeProvider({ state, exec, opened, reviveGraceMs: 0 });

        await provider.initialize();

        expect(opened.map(targetSession)).toEqual([name(0), name(1), name(2), name(3)]);
        expect(provider.mappedSlots()).toEqual([0, 1, 2, 3]);
    });

    // Closing a laptop LID does not close its window: the remote pty (and the tmux client
    // inside it) survives for VSCODE_RECONNECTION_GRACE_TIME, 3h by default, so those
    // sessions still read as attached. While their clients are live (typed into within the
    // staleness threshold) they are not taken — only offered; see the ownership suite below
    // for the idle case.
    it('leaves the other machine\'s sessions alone while its clients are still attached', async () => {
        const state = fakeState({ [SLOT_MAPPING_STATE_KEY]: { '0': name(0), '1': name(1) } });
        const exec = fakeExec({
            list: [row(name(0), false), row(name(1), false), row(name(2), true), row(name(3), true)],
            existing: [name(0), name(1)],
        });
        const opened: LaunchOptions[] = [];
        const { provider } = makeProvider({ state, exec, opened, reviveGraceMs: 0 });

        await provider.initialize();

        expect(opened.map(targetSession)).toEqual([name(0), name(1)]);
        expect(provider.mappedSlots()).toEqual([0, 1]);
    });

    it('adopts them on a later connect, once those clients are gone', async () => {
        // Same machine, same state, one connect later: the laptop's grace has expired.
        const state = fakeState({ [SLOT_MAPPING_STATE_KEY]: { '0': name(0), '1': name(1) } });
        const exec = fakeExec({
            list: [row(name(0), false), row(name(1), false), row(name(2), false), row(name(3), false)],
            existing: [name(0), name(1), name(2), name(3)],
        });
        const opened: LaunchOptions[] = [];
        const { provider } = makeProvider({ state, exec, opened, reviveGraceMs: 0 });

        await provider.initialize();

        expect(opened.map(targetSession)).toContain(name(2));
        expect(opened.map(targetSession)).toContain(name(3));
    });
});

describe('hand-off ownership (03: owner tag, staleness, offer)', () => {
    const NOW = 1_800_000_000;
    /** `list-clients` output: the remote clock, then one `<session> <activity>` per client. */
    const clients = (...rows: Array<[string, number]>): string =>
        [`__now ${NOW}`, ...rows.map(([session, activity]) => `${session} ${activity}`)].join('\n');
    const flush = (): Promise<void> => new Promise<void>(res => setTimeout(res, 0));
    const anyTakeOver = (exec: ReturnType<typeof fakeExec>, opened: LaunchOptions[]): boolean =>
        opened.some(o => (o.shellArgs ?? []).includes('-D'))
        || exec.mock.calls.some(([command]) => command.includes('detach-client'));

    // THE REGRESSION. PC mapped slot 0; the laptop adopted it and is typing in it. PC's
    // reconnect used to read "mapped + attached" as its own stale pty and evict the laptop.
    it('never evicts a live client of another machine from a session we once mapped', async () => {
        const state = fakeState({ [SLOT_MAPPING_STATE_KEY]: { '0': name(0) } });
        const exec = fakeExec({ list: [owned(name(0), true, OTHER)], existing: [name(0)], clients: clients([name(0), NOW - 5]) });
        const opened: LaunchOptions[] = [];
        const offerTakeOver = vi.fn(async () => false);
        const { provider } = makeProvider({ state, exec, opened, offerTakeOver });

        await provider.initialize();
        await flush();

        expect(opened).toEqual([]);
        expect(anyTakeOver(exec, opened)).toBe(false);
        expect(offerTakeOver).toHaveBeenCalledTimes(1);
        // Mapping hygiene: the session is the laptop's now.
        expect(provider.mappedSlots()).toEqual([]);
        expect(state.get(SLOT_MAPPING_STATE_KEY)).toEqual({});
    });

    it('takes the session over with -D once the user accepts the offer', async () => {
        const exec = fakeExec({ list: [owned(name(0), true, OTHER)], existing: [name(0)], clients: clients([name(0), NOW - 5]) });
        const opened: LaunchOptions[] = [];
        const { provider, log } = makeProvider({ exec, opened, offerTakeOver: async () => true });

        await provider.initialize();
        await flush();

        expect(opened.map(targetSession)).toEqual([name(0)]);
        expect(opened[0].shellArgs).toContain('-D');
        expect(provider.mappedSlots()).toEqual([0]);
        expect(log.info.mock.calls.map(c => String(c[0])).some(line => /took over 1 session/.test(line))).toBe(true);
    });

    it('re-reads the remote after the answer: a session that went away is not recreated', async () => {
        let lists = 0;
        const exec = vi.fn(async (command: string): Promise<ExecResult> => {
            if (command.includes('list-sessions')) {
                lists++;
                return { stdout: lists === 1 ? owned(name(0), true, OTHER) : '', stderr: '', code: 0 };
            }
            if (command.includes('list-clients')) {
                return { stdout: clients([name(0), NOW - 5]), stderr: '', code: 0 };
            }
            return { stdout: '', stderr: '', code: 0 };
        });
        const opened: LaunchOptions[] = [];
        const { provider } = makeProvider({ exec, opened, offerTakeOver: async () => true });

        await provider.initialize();
        await flush();

        expect(opened).toEqual([]);
    });

    it('does not ask again on a reconnect after the user said not now', async () => {
        const exec = fakeExec({ list: [owned(name(0), true, OTHER)], existing: [name(0)], clients: clients([name(0), NOW - 5]) });
        const offerTakeOver = vi.fn(async () => false);
        const { provider } = makeProvider({ exec, offerTakeOver });

        await provider.initialize();
        await provider.initialize({ awaitRevive: false });
        await flush();

        expect(offerTakeOver).toHaveBeenCalledTimes(1);
    });

    // A SIGKILLed VS Code / a sleeping laptop leaves its client attached for 3h. Once it has
    // been idle past the threshold, `auto` hands the session over with no question asked.
    it('takes over an idle foreign client silently under auto', async () => {
        const exec = fakeExec({ list: [owned(name(0), true, OTHER)], clients: clients([name(0), NOW - 500]) });
        const opened: LaunchOptions[] = [];
        const offerTakeOver = vi.fn(async () => true);
        const { provider } = makeProvider({ exec, opened, offerTakeOver });

        await provider.initialize();
        await flush();

        expect(opened.map(targetSession)).toEqual([name(0)]);
        expect(opened[0].shellArgs).toContain('-D');
        expect(offerTakeOver).not.toHaveBeenCalled();
        expect(provider.mappedSlots()).toEqual([0]);
    });

    it('honours the injected staleness threshold', async () => {
        const exec = fakeExec({ list: [owned(name(0), true, OTHER)], clients: clients([name(0), NOW - 5]) });
        const opened: LaunchOptions[] = [];
        const { provider } = makeProvider({ exec, opened, staleClientSeconds: 3 });

        await provider.initialize();

        expect(opened.map(targetSession)).toEqual([name(0)]);
    });

    it('treats an untagged (pre-upgrade) session held by an idle client as handed off', async () => {
        const exec = fakeExec({ list: [row(name(0), true)], clients: clients([name(0), NOW - 500]) });
        const opened: LaunchOptions[] = [];
        const { provider } = makeProvider({ exec, opened });

        await provider.initialize();

        expect(opened[0].shellArgs).toContain('-D');
    });

    it('only offers an idle foreign client under ask', async () => {
        const exec = fakeExec({ list: [owned(name(0), true, OTHER)], clients: clients([name(0), NOW - 500]) });
        const opened: LaunchOptions[] = [];
        const offerTakeOver = vi.fn(async () => false);
        const { provider } = makeProvider({ exec, opened, offerTakeOver, handOff: 'ask' });

        await provider.initialize();
        await flush();

        expect(opened).toEqual([]);
        expect(offerTakeOver).toHaveBeenCalledTimes(1);
    });

    it('neither takes nor offers under never', async () => {
        const exec = fakeExec({ list: [owned(name(0), true, OTHER)], clients: clients([name(0), NOW - 500]) });
        const opened: LaunchOptions[] = [];
        const offerTakeOver = vi.fn(async () => true);
        const { provider } = makeProvider({ exec, opened, offerTakeOver, handOff: 'never' });

        await provider.initialize();
        await flush();

        expect(opened).toEqual([]);
        expect(offerTakeOver).not.toHaveBeenCalled();
    });

    it.each([
        ['list-clients rejects', (): Promise<ExecResult> => Promise.reject(new Error('channel'))],
        ['list-clients exits non-zero', async (): Promise<ExecResult> => ({ stdout: '', stderr: 'boom', code: 1 })],
        ['no remote clock', async (): Promise<ExecResult> => ({ stdout: `${name(0)} 1`, stderr: '', code: 0 })],
    ])('reads every client as live when the evidence is missing (%s)', async (_label, answer) => {
        const exec = vi.fn(async (command: string): Promise<ExecResult> => {
            if (command.includes('list-sessions')) {
                return { stdout: owned(name(0), true, OTHER), stderr: '', code: 0 };
            }
            if (command.includes('list-clients')) {
                return answer();
            }
            return { stdout: '', stderr: '', code: 0 };
        });
        const opened: LaunchOptions[] = [];
        const { provider } = makeProvider({ exec, opened });

        await provider.initialize();

        expect(opened).toEqual([]);
    });

    it('skips the list-clients round-trip when no session is held by someone else', async () => {
        const state = fakeState({ [SLOT_MAPPING_STATE_KEY]: { '0': name(0) } });
        const exec = fakeExec({ list: [owned(name(0), true, ME), row(name(1), false)], existing: [name(0)] });
        const { provider } = makeProvider({ state, exec });

        await provider.initialize();

        expect(exec.mock.calls.some(([command]) => command.includes('list-clients'))).toBe(false);
    });

    it('reclaims a session tagged with our id even when the mapping lost it', async () => {
        const exec = fakeExec({ list: [owned(name(0), true, ME)], existing: [name(0)] });
        const opened: LaunchOptions[] = [];
        const { provider } = makeProvider({ exec, opened });

        await provider.initialize();

        expect(opened.map(targetSession)).toEqual([name(0)]);
        expect(opened[0].shellArgs).toContain('-D');
        expect(provider.mappedSlots()).toEqual([0]);
    });

    it('tags every attach with this window\'s client id', async () => {
        const { provider } = makeProvider();
        const args = optionsOf(await provider.provideTerminalProfile()).shellArgs ?? [];
        expect(args[args.indexOf('@orst_owner') + 1]).toBe(ME);
    });

    describe('the evicted side (another machine took our session)', () => {
        /** Open slot 0, then close it for `reason` while the remote reports `after`. */
        async function evict(reason: number, after: string) {
            let closed = false;
            const exec = vi.fn(async (command: string): Promise<ExecResult> => {
                if (command.includes('list-sessions')) {
                    return { stdout: closed ? after : '', stderr: '', code: 0 };
                }
                return { stdout: '', stderr: '', code: 0 };
            });
            const opened: LaunchOptions[] = [];
            const made = makeProvider({ exec, opened });
            const profile = await made.provider.provideTerminalProfile();
            const term = { creationOptions: optionsOf(profile), exitStatus: { code: 0, reason } } as unknown as import('vscode').Terminal;
            made.provider.handleTerminalOpened(term);
            closed = true;
            made.provider.handleTerminalClosed(term);
            await flush();
            await flush();
            return { ...made, exec, opened };
        }

        // `-D` from the other machine detaches our client, which exits 0: VS Code reports a
        // process exit. Killing would destroy the other machine's work; re-attaching would
        // evict it right back (ping-pong).
        it('keeps the session, forgets the slot, does not re-attach, logs one info line', async () => {
            const { exec, opened, provider, log } = await evict(2, owned(name(0), true, OTHER));

            expect(exec.mock.calls.some(([command]) => command.includes('kill-session'))).toBe(false);
            expect(opened).toEqual([]);
            expect(provider.mappedSlots()).toEqual([]);
            const lines = log.info.mock.calls.map(c => String(c[0])).filter(line => /another machine/.test(line));
            expect(lines).toHaveLength(1);
        });

        // 05 (g): the session is gone, so the mapping goes too — keeping it only cost the
        // next reconcile a has-session round-trip to find that out.
        it('forgets the slot quietly when the shell simply exited (session gone)', async () => {
            const { provider, log } = await evict(2, '');

            expect(provider.mappedSlots()).toEqual([]);
            expect(log.info).not.toHaveBeenCalled();
        });

        it('does not probe on a window shutdown', async () => {
            const { exec, provider } = await evict(1, owned(name(0), true, OTHER));

            expect(exec.mock.calls.filter(([command]) => command.includes('list-sessions'))).toHaveLength(1); // the snapshot at open
            expect(provider.mappedSlots()).toEqual([0]);
        });
    });

    // Bug A. A window that closes cannot detach its tmux clients (VS Code kills the
    // extension host within milliseconds); what reaches the remote instead is its connection
    // dropping, on which the close watch marks the sessions it owned (`buildCloseWatchCommand`).
    describe('a window that went away (close marker)', () => {
        const closedBy = (client: string, at: number): string => ` c:${client}:${at}`;

        it('takes the session over at once, without asking, when its owner\'s window closed', async () => {
            // Typed 5 s ago — live by the idle rule — but the window it typed into is gone.
            const exec = fakeExec({ list: [owned(name(0), true, OTHER) + closedBy(OTHER, NOW - 2)], clients: clients([name(0), NOW - 5]) });
            const opened: LaunchOptions[] = [];
            const offerTakeOver = vi.fn(async () => true);
            const { provider } = makeProvider({ exec, opened, offerTakeOver });

            await provider.initialize();
            await flush();

            expect(opened.map(targetSession)).toEqual([name(0)]);
            expect(opened[0].shellArgs).toContain('-D');
            expect(offerTakeOver).not.toHaveBeenCalled();
        });

        // The marker is about the window that left it. Once another machine has taken the
        // session over, the client on it is that machine's, and live.
        it('ignores a marker left by a previous owner', async () => {
            const THIRD = '0badc0de-12345678';
            const exec = fakeExec({ list: [owned(name(0), true, OTHER) + closedBy(THIRD, NOW - 2)], clients: clients([name(0), NOW - 5]) });
            const opened: LaunchOptions[] = [];
            const offerTakeOver = vi.fn(async () => false);
            const { provider } = makeProvider({ exec, opened, offerTakeOver });

            await provider.initialize();
            await flush();

            expect(opened).toEqual([]);
            expect(offerTakeOver).toHaveBeenCalledTimes(1);
        });

        // Input after the close means the owner came back (a reload): never take it.
        it('ignores a marker the owner has typed past', async () => {
            const exec = fakeExec({ list: [owned(name(0), true, OTHER) + closedBy(OTHER, NOW - 10)], clients: clients([name(0), NOW - 5]) });
            const opened: LaunchOptions[] = [];
            const { provider } = makeProvider({ exec, opened, offerTakeOver: async () => false });

            await provider.initialize();
            await flush();

            expect(opened).toEqual([]);
        });

        // A reload drops the connection too, so the watch marks this window's own sessions
        // on the way out. The reloaded window is the same client: the marker is withdrawn on
        // its first reconcile, so no other machine reads a live window as gone.
        it('withdraws its own markers on reconcile, in one round-trip', async () => {
            const state = fakeState({ [SLOT_MAPPING_STATE_KEY]: { '0': name(0), '1': name(1) } });
            const exec = fakeExec({
                list: [owned(name(0), true, ME) + closedBy(ME, NOW - 2), owned(name(1), false, ME) + closedBy(ME, NOW - 2), owned(name(2), true, OTHER) + closedBy(OTHER, NOW)],
                existing: [name(0), name(1)],
                clients: clients([name(2), NOW - 5]),
            });
            const { provider } = makeProvider({ state, exec, offerTakeOver: async () => false });

            await provider.initialize();
            await flush();

            const clears = exec.mock.calls.map(([command]) => command).filter(command => command.includes('set-option'));
            expect(clears).toEqual([buildClearClosedCommand([name(0), name(1)])]);
        });

        it('makes no extra round-trip when no marker names it', async () => {
            const state = fakeState({ [SLOT_MAPPING_STATE_KEY]: { '0': name(0) } });
            const exec = fakeExec({ list: [owned(name(0), true, ME)], existing: [name(0)] });
            const { provider } = makeProvider({ state, exec });

            await provider.initialize();

            expect(exec.mock.calls.some(([command]) => command.includes('set-option'))).toBe(false);
        });

        // Nothing is sent at close time any more: the window's own requests cannot outrun
        // VS Code killing the extension host, so a close is the watch's business alone.
        it('sends nothing to the remote when its terminals close for a window shutdown', async () => {
            const exec = fakeExec();
            const { provider } = makeProvider({ exec });
            const profile = await provider.provideTerminalProfile();
            const term = { creationOptions: optionsOf(profile), exitStatus: { code: undefined, reason: 1 } } as unknown as import('vscode').Terminal;
            provider.handleTerminalOpened(term);
            const before = exec.mock.calls.length;

            provider.handleTerminalClosed(term);
            await flush();

            expect(exec.mock.calls.length).toBe(before);
        });
    });

    // Bug C. One vscode-server serves both machines, and it keeps each workspace's terminal
    // layout. The machine that went away left its terminal in that layout with its pty still
    // running; the window that takes over relaunches it — and with our profile as the default,
    // VS Code relaunches it by asking this provider for a profile (EDH row 23: "new slot 1"
    // 1.7 s after the take-over, no key pressed). That request IS the taken-over terminal.
    describe('a take-over waits for VS Code to relaunch the other machine\'s terminal', () => {
        it('hands the relaunch the taken-over session instead of minting a new one', async () => {
            const exec = fakeExec({ list: [owned(name(0), true, OTHER)], clients: clients([name(0), NOW - 500]) });
            const opened: LaunchOptions[] = [];
            const { provider } = makeProvider({ exec, opened, reviveGraceMs: 20, reviveDeadlineMs: 2000, reviveQuietMs: 20 });

            const init = provider.initialize();
            await new Promise(res => setTimeout(res, 60)); // the relaunch lands after the grace
            const relaunched = optionsOf(await provider.provideTerminalProfile());
            await init;

            expect(targetSession(relaunched)).toBe(name(0));
            expect(relaunched.shellArgs).toContain('-D');
            expect(opened).toEqual([]);
        });

        it('still opens it itself when no relaunch comes', async () => {
            const exec = fakeExec({ list: [owned(name(0), true, OTHER)], clients: clients([name(0), NOW - 500]) });
            const opened: LaunchOptions[] = [];
            const { provider } = makeProvider({ exec, opened, reviveGraceMs: 5, reviveDeadlineMs: 40 });

            await provider.initialize();

            expect(opened.map(targetSession)).toEqual([name(0)]);
            expect(opened[0].shellArgs).toContain('-D');
        });
    });
});

// Bug D. Every remote call is bounded by one deadline, but a reconcile against a hung remote
// used to make three of them in a row (legacy list, list, has-session) and New Terminal waited
// behind all three and then made a fourth: a plain shell after 32 s (EDH row 24).
describe('a hung remote costs one deadline, not one per call', () => {
    const DEADLINE_MS = 8000;
    const LEGACY = { hostKey: 'myvps', workspaceKey: '/home/user/proj/' };
    const ctx = { hostKey: HOST, workspaceKey: WS, cwd: CWD, legacy: LEGACY };
    const hung = () => createRemoteExec(() => new Promise(() => { /* never settles */ }), DEADLINE_MS);

    afterEach(() => {
        vi.useRealTimers();
    });

    it('a reconcile gives up after the first deadline, keeping every mapping', async () => {
        vi.useFakeTimers();
        const state = fakeState({ [SLOT_MAPPING_STATE_KEY]: { '0': name(0) } });
        const { provider } = makeProvider({ ctx, state, rawExec: hung() });

        let settled = false;
        void provider.initialize().then(() => { settled = true; });
        await vi.advanceTimersByTimeAsync(DEADLINE_MS + 100);

        expect(settled).toBe(true);
        expect(provider.mappedSlots()).toEqual([0]);
    });

    it('New Terminal during that reconcile is a plain shell after one deadline', async () => {
        vi.useFakeTimers();
        const state = fakeState({ [SLOT_MAPPING_STATE_KEY]: { '0': name(0) } });
        const { provider, log } = makeProvider({ ctx, state, rawExec: hung() });

        void provider.initialize();
        let answer: LaunchOptions | undefined;
        void provider.provideTerminalProfile().then(profile => { answer = optionsOf(profile); });
        await vi.advanceTimersByTimeAsync(DEADLINE_MS + 100);

        expect(answer).toEqual({});
        expect(log.info.mock.calls.some(([line]) => /did not answer in time/.test(String(line)))).toBe(true);
    });

    it('lists the remote once per reconcile when there is nothing legacy to rename', async () => {
        const state = fakeState({ [SLOT_MAPPING_STATE_KEY]: { '0': name(0) } });
        const exec = fakeExec({ list: [row(name(0), false)], existing: [name(0)] });
        const { provider } = makeProvider({ ctx, state, exec });

        await provider.initialize({ awaitRevive: false });

        expect(exec.mock.calls.filter(([command]) => command.includes('list-sessions'))).toHaveLength(1);
    });
});

/** A promise and the function that settles it — for holding a remote call open. */
function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(res => {
        resolve = res;
    });
    return { promise, resolve };
}

describe('overlapping reconciles (05 d: a reconnect inside the revive window)', () => {
    // A reconnect re-plans while the first pass is still holding its restore queue open for
    // VS Code's revive (up to ~12 s). Running the two passes concurrently let the second
    // plan() clear the first's queue — so a revive arriving next found nothing and minted a
    // NEW session (the 1.0.8/1.0.9 duplicate) — and let the first pass's cleanup wipe the
    // reservations the second had just made. Passes now run one after the other.

    it('keeps the restore queue intact and mints no slot twice', async () => {
        const state = fakeState({ [SLOT_MAPPING_STATE_KEY]: { '0': name(0), '1': name(1) } });
        const exec = fakeExec({ list: [row(name(0), false), row(name(1), false)], existing: [name(0), name(1)] });
        const opened: LaunchOptions[] = [];
        const { provider } = makeProvider({ state, exec, opened, reviveGraceMs: 30, reviveDeadlineMs: 300, reviveQuietMs: 30 });

        const first = provider.initialize();
        await provider.initialized;
        const second = provider.initialize({ awaitRevive: false }); // the reconnect
        const revivedProfile = await provider.provideTerminalProfile(); // VS Code's revive, late
        await Promise.all([first, second]);

        expect(targetSession(optionsOf(revivedProfile))).toBe(name(0));
        // Slot 1 opened once, by whichever pass drained it — never twice, never a new slot.
        expect(opened.map(targetSession)).toEqual([name(1)]);
        expect(provider.mappedSlots()).toEqual([0, 1]);
    });

    it('does not let a reconnect\'s pass run while the first is still planning (deferred exec)', async () => {
        const gate = deferred<void>();
        const lists: number[] = [];
        let calls = 0;
        const rawExec = async (command: string) => {
            if (command.includes('list-sessions')) {
                lists.push(++calls);
                if (calls === 1) {
                    await gate.promise; // the first plan is stuck on the remote
                }
                return { stdout: row(name(0), false), stderr: '', code: 0 };
            }
            if (command.includes('has-session')) {
                return { ...hasReply(command, () => ({ code: 0 })), code: 0 };
            }
            return { stdout: '', stderr: '', code: 0 };
        };
        const state = fakeState({ [SLOT_MAPPING_STATE_KEY]: { '0': name(0) } });
        const opened: LaunchOptions[] = [];
        const { provider } = makeProvider({ state, rawExec, opened });

        const first = provider.initialize({ awaitRevive: false });
        const second = provider.initialize({ awaitRevive: false });
        await new Promise(resolve => setTimeout(resolve, 10));
        expect(lists).toEqual([1]); // the second pass waits its turn
        gate.resolve();
        await Promise.all([first, second]);

        expect(opened.map(targetSession)).toEqual([name(0)]);
    });

    it('coalesces a storm of reconnects into one follow-up pass', async () => {
        const state = fakeState({ [SLOT_MAPPING_STATE_KEY]: { '0': name(0) } });
        const exec = fakeExec({ list: [row(name(0), false)], existing: [name(0)] });
        const { provider } = makeProvider({ state, exec, reviveGraceMs: 20 });

        const passes = [provider.initialize(), provider.initialize({ awaitRevive: false }), provider.initialize({ awaitRevive: false }), provider.initialize({ awaitRevive: false })];
        await Promise.all(passes);

        const lists = exec.mock.calls.filter(call => call[0].includes('list-sessions')).length;
        expect(lists).toBe(2);
    });

    it('a pass that fails does not wedge the next one', async () => {
        let fail = true;
        const rawExec = async (command: string) => {
            if (command.includes('list-sessions') && fail) {
                fail = false;
                throw new Error('channel closed');
            }
            return { stdout: '', stderr: '', code: 0 };
        };
        const { provider } = makeProvider({ rawExec });

        await provider.initialize({ awaitRevive: false });
        await expect(provider.initialize({ awaitRevive: false })).resolves.toBeUndefined();
    });
});

describe('revive waits are named, and a reconnect during revive is safe (05 f)', () => {
    it('exposes the three waits as named constants', () => {
        expect([REVIVE_GRACE_MS, REVIVE_DEADLINE_MS, REVIVE_QUIET_MS]).toEqual([2500, 10000, 2000]);
    });

    it('a reconnect during the revive window neither cuts the window short nor opens a duplicate', async () => {
        const state = fakeState({ [SLOT_MAPPING_STATE_KEY]: { '0': name(0) } });
        const exec = fakeExec({ list: [row(name(0), false)], existing: [name(0)] });
        const opened: LaunchOptions[] = [];
        const { provider } = makeProvider({ state, exec, opened, reviveGraceMs: 20, reviveDeadlineMs: 400 });

        const init = provider.initialize();
        await provider.initialized;
        const refresh = provider.initialize({ awaitRevive: false });
        await new Promise(resolve => setTimeout(resolve, 60)); // past the grace
        const revivedProfile = await provider.provideTerminalProfile(); // the revive is still served
        await Promise.all([init, refresh]);

        expect(targetSession(optionsOf(revivedProfile))).toBe(name(0));
        expect(opened).toEqual([]);
    });
});

describe('slot claim survives a failed persist (05 e)', () => {
    /** workspaceState whose writes reject (storage failure). */
    function brokenState(initial: Record<string, unknown> = {}) {
        const state = fakeState(initial);
        return { ...state, update: async (): Promise<void> => { throw new Error('storage failure'); } };
    }

    it('still resolves a usable terminal when the mapping cannot be saved', async () => {
        const { provider, log } = makeProvider({ state: brokenState() });

        const profile = await provider.provideTerminalProfile();

        expect(targetSession(optionsOf(profile))).toBe(name(0));
        expect(log.trace).toHaveBeenCalledWith(expect.stringContaining('storage failure'));
        // The slot is held by that terminal, so the next one gets its own.
        expect(targetSession(optionsOf(await provider.provideTerminalProfile()))).toBe(name(1));
    });

    it('serves a queued restore even when the mapping cannot be saved', async () => {
        const state = brokenState({ [SLOT_MAPPING_STATE_KEY]: { '0': name(0) } });
        const exec = fakeExec({ list: [row(name(0), false)], existing: [name(0)] });
        const { provider } = makeProvider({ state, exec, reviveGraceMs: 30, reviveDeadlineMs: 300 });

        const init = provider.initialize().catch(() => undefined);
        const profile = await provider.provideTerminalProfile();
        await init;

        expect(targetSession(optionsOf(profile))).toBe(name(0));
    });

    it('frees the slot and answers with a plain shell when building the terminal fails', async () => {
        const { provider } = makeProvider({ tmuxVersion: '3.4' });
        // A programming error past the claim (here: an owner id tmux would refuse).
        (provider as unknown as { clientId: string }).clientId = 'not an id; kill-server';

        const profile = await provider.provideTerminalProfile();

        expect(optionsOf(profile)).toEqual({});
        (provider as unknown as { clientId: string }).clientId = ME;
        expect(targetSession(optionsOf(await provider.provideTerminalProfile()))).toBe(name(0));
    });
});

describe('close without a user reason (05 g)', () => {
    const flush = (): Promise<void> => new Promise<void>(res => setTimeout(res, 0));

    async function openThenClose(reason: number | undefined, list: string[]) {
        const exec = fakeExec();
        const made = makeProvider({ exec });
        const profile = await made.provider.provideTerminalProfile(); // slot 0, list empty
        exec.mockImplementation(async (command: string) => command.includes('list-sessions')
            ? { stdout: list.join('\n'), stderr: '', code: 0 }
            : { stdout: '', stderr: '', code: 0 });
        const term = {
            creationOptions: optionsOf(profile),
            exitStatus: reason === undefined ? undefined : { code: 0, reason },
        } as unknown as import('vscode').Terminal;
        made.provider.handleTerminalOpened(term);
        made.provider.handleTerminalClosed(term);
        await flush();
        await flush();
        return { ...made, exec };
    }

    it('an absent reason (VS Code < 1.71) never kills, and is logged as unknown', async () => {
        const { exec, log } = await openThenClose(undefined, [row(name(0), false)]);

        expect(exec.mock.calls.some(call => call[0].includes('kill-session'))).toBe(false);
        expect(log.trace).toHaveBeenCalledWith(expect.stringContaining('slot 0 closed (unknown)'));
    });

    it('says the session was kept only when it is still there', async () => {
        const { log, provider } = await openThenClose(2, [row(name(0), false)]);

        expect(log.trace).toHaveBeenCalledWith(expect.stringContaining('session kept'));
        expect(provider.mappedSlots()).toEqual([0]);
    });

    it('says the session ended — and forgets it — when the shell exit took it down', async () => {
        const { log, provider } = await openThenClose(2, []);

        expect(log.trace).toHaveBeenCalledWith(expect.stringContaining('session ended'));
        expect(log.trace).not.toHaveBeenCalledWith(expect.stringContaining('session kept'));
        expect(provider.mappedSlots()).toEqual([]);
    });
});

describe('dispose (05 b: the layer is switched off at runtime)', () => {
    it('opens nothing after dispose, even with a restore still queued', async () => {
        const state = fakeState({ [SLOT_MAPPING_STATE_KEY]: { '0': name(0) } });
        const exec = fakeExec({ list: [row(name(0), false)], existing: [name(0)] });
        const opened: LaunchOptions[] = [];
        const { provider } = makeProvider({ state, exec, opened, reviveGraceMs: 30, reviveDeadlineMs: 60 });

        const init = provider.initialize();
        await provider.initialized;
        provider.dispose();
        await init;

        expect(opened).toEqual([]);
    });

    it('a profile requested after dispose is a plain shell', async () => {
        const { provider } = makeProvider();
        provider.dispose();

        expect(optionsOf(await provider.provideTerminalProfile())).toEqual({});
    });
});

describe('configure (05 b: settings changed without a reload)', () => {
    it('new terminals use the new scrollback limit', async () => {
        const { provider } = makeProvider({ historyLimit: 1000, tmuxVersion: '3.8' });
        provider.configure({ historyLimit: 2000, handOff: 'auto' });

        const args = optionsOf(await provider.provideTerminalProfile()).shellArgs ?? [];

        expect(args.join(' ')).toContain('history-limit 2000');
    });

    it('the next reconcile applies the new hand-off policy', async () => {
        const state = fakeState({ [SLOT_MAPPING_STATE_KEY]: { '0': name(0) } });
        const exec = fakeExec({ list: [owned(name(0), true, OTHER)], existing: [name(0)] });
        const offer = vi.fn(async () => false);
        const { provider } = makeProvider({ state, exec, offerTakeOver: offer, handOff: 'never' });
        provider.configure({ historyLimit: 50000, handOff: 'ask' });

        await provider.initialize({ awaitRevive: false });

        expect(offer).toHaveBeenCalledTimes(1);
    });
});

describe('mappedSessionNames (05 a: what housekeeping must never age out)', () => {
    it('lists the sessions this window maps', async () => {
        const { provider } = makeProvider();
        await provider.provideTerminalProfile();
        await provider.provideTerminalProfile();

        expect(provider.mappedSessionNames()).toEqual([name(0), name(1)]);
    });
});

describe('legacy identity adoption (05 c: alias-keyed sessions move to the canonical name)', () => {
    // Before 05 the session hash was keyed on the alias as typed and the raw folder path.
    // The canonical identity hashes differently, so without adoption an upgrade would leave
    // every running session under a name nothing looks up any more.
    const LEGACY = { hostKey: 'myvps', workspaceKey: '/home/user/proj/' };
    const legacy = (slot: number): string => sessionName(LEGACY.hostKey, LEGACY.workspaceKey, slot);
    const ctx = { hostKey: HOST, workspaceKey: WS, cwd: CWD, legacy: LEGACY };

    /** A fake remote whose sessions really get renamed, so a second pass sees the result. */
    function renamingExec(initial: string[]) {
        const rows = new Map(initial.map(line => [line.split(' ')[0], line]));
        return vi.fn(async (command: string): Promise<ExecResult> => {
            if (command.includes('list-sessions')) {
                return { stdout: [...rows.values()].join('\n'), stderr: '', code: 0 };
            }
            const rename = /rename-session -t ='([^']*)' '([^']*)'/.exec(command);
            if (rename) {
                const line = rows.get(rename[1]);
                if (!line) {
                    return { stdout: '', stderr: `can't find session: ${rename[1]}`, code: 1 };
                }
                rows.delete(rename[1]);
                rows.set(rename[2], line.replace(rename[1], rename[2]));
                return { stdout: '', stderr: '', code: 0 };
            }
            if (command.includes('has-session')) {
                return hasReply(command, target => rows.has(target) ? { code: 0 } : { code: 1, message: `can't find session: ${target}` });
            }
            return { stdout: '', stderr: '', code: 0 };
        });
    }
    const renames = (exec: ReturnType<typeof renamingExec>): string[] =>
        exec.mock.calls.map(call => call[0]).filter(command => command.includes('rename-session'));

    it('renames a detached legacy session to the same canonical slot and restores it', async () => {
        const exec = renamingExec([row(legacy(0), false)]);
        const state = fakeState({ [SLOT_MAPPING_STATE_KEY]: { '0': legacy(0) } });
        const opened: LaunchOptions[] = [];
        const { provider } = makeProvider({ ctx, exec, state, opened });

        await provider.initialize({ awaitRevive: false });

        expect(renames(exec)).toEqual([buildRenameSession(legacy(0), name(0))]);
        expect(opened.map(targetSession)).toEqual([name(0)]);
        expect(state.get(SLOT_MAPPING_STATE_KEY)).toEqual({ '0': name(0) });
    });

    it('adopts once: a later pass renames nothing', async () => {
        const exec = renamingExec([row(legacy(0), false)]);
        const { provider } = makeProvider({ ctx, exec });

        await provider.initialize({ awaitRevive: false });
        await provider.initialize({ awaitRevive: false });

        expect(renames(exec)).toHaveLength(1);
    });

    it('moves to the next free canonical slot when the same slot is already taken', async () => {
        const exec = renamingExec([row(name(0), false), row(legacy(0), false)]);
        const opened: LaunchOptions[] = [];
        const { provider } = makeProvider({ ctx, exec, opened });

        await provider.initialize({ awaitRevive: false });

        expect(renames(exec)).toEqual([buildRenameSession(legacy(0), name(1))]);
        expect(opened.map(targetSession).sort()).toEqual([name(0), name(1)]);
    });

    it('never touches a legacy session another machine\'s client is on — and retries later', async () => {
        const exec = renamingExec([owned(legacy(0), true, OTHER)]);
        const { provider } = makeProvider({ ctx, exec });

        await provider.initialize({ awaitRevive: false });
        expect(renames(exec)).toEqual([]);

        // The other machine let go; the next pass adopts it.
        exec.mockClear();
        const free = renamingExec([owned(legacy(0), false, OTHER)]);
        exec.mockImplementation(free);
        await provider.initialize({ awaitRevive: false });
        expect(renames(exec)).toEqual([buildRenameSession(legacy(0), name(0))]);
    });

    it('adopts our own still-attached legacy session (the reload reconnected its pty) without a second tab', async () => {
        const exec = renamingExec([owned(legacy(0), true, ME)]);
        const opened: LaunchOptions[] = [];
        // The reconnected pty still carries the legacy name in its argv.
        const legacyTerminal = { creationOptions: { shellArgs: ['new-session', '-A', '-s', legacy(0)] }, dispose: vi.fn() } as unknown as import('vscode').Terminal;
        const { provider } = makeProvider({ ctx, exec, opened, listTerminals: () => [legacyTerminal] });

        await provider.initialize({ awaitRevive: false });

        expect(renames(exec)).toEqual([buildRenameSession(legacy(0), name(0))]);
        expect(opened).toEqual([]); // that tab IS slot 0 now
        expect(provider.mappedSlots()).toEqual([0]);
        // And it is recognised when VS Code reports it opening.
        provider.handleTerminalOpened(legacyTerminal);
        expect(legacyTerminal.dispose).not.toHaveBeenCalled();
    });

    it('a legacy session that vanished before the rename is not recreated', async () => {
        const exec = renamingExec([row(legacy(0), false)]);
        const state = fakeState({ [SLOT_MAPPING_STATE_KEY]: { '0': legacy(0) } });
        const opened: LaunchOptions[] = [];
        const { provider } = makeProvider({ ctx, exec, state, opened });
        exec.mockImplementation(async (command: string) => {
            if (command.includes('list-sessions')) {
                return { stdout: command.includes('rename') ? '' : row(legacy(0), false), stderr: '', code: 0 };
            }
            if (command.includes('rename-session')) {
                return { stdout: '', stderr: `can't find session: ${legacy(0)}`, code: 1 };
            }
            if (command.includes('has-session')) {
                return hasReply(command, target => ({ code: 1, message: `can't find session: ${target}` }));
            }
            return { stdout: '', stderr: '', code: 0 };
        });

        await provider.initialize({ awaitRevive: false });

        expect(opened).toEqual([]);
        expect(provider.mappedSlots()).toEqual([]);
    });
});
