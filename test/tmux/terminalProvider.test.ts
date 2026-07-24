import { describe, expect, it, vi } from 'vitest';
import { SLOT_MAPPING_STATE_KEY, TmuxTerminalProvider } from '../../src/tmux/terminalProvider';
import { buildAttachOrCreateArgv, escapeShellArg, sessionName } from '../../src/tmux/tmuxSession';

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

/** A `list-sessions` stdout line for a session. */
const row = (sessionId: string, attached: boolean, windows = 1, created = 1700000000): string =>
    `${sessionId} ${attached ? 1 : 0} ${windows} ${created}`;

/**
 * An exec that answers `list-sessions` with the given rows and `has-session`
 * against a set of existing names (empty stderr = present; not-found stderr =
 * absent), mirroring how the real tmux CLI reports over `SSHConnection#exec`
 * (no exit code surfaced — status is read from stdout/stderr).
 *
 * `has-session` is matched on the EXACT `-t =<name>` target the real tmux uses,
 * not a loose substring of the whole command: a bare `includes(name)` mimicked the
 * very prefix-match bug the `=` fix removes (it would report `code-<h>-01` present
 * when only `code-<h>-0` exists). The `=` + trailing quote bound the token.
 */
function fakeExec(opts: { list?: string[]; existing?: string[] } = {}) {
    const listOut = (opts.list ?? []).join('\n');
    const existing = new Set(opts.existing ?? []);
    return vi.fn(async (command: string) => {
        if (command.includes('list-sessions')) {
            return { stdout: listOut, stderr: '' };
        }
        if (command.includes('has-session')) {
            const present = [...existing].some(n => command.includes(`=${escapeShellArg(n)}`));
            return present ? { stdout: '', stderr: '' } : { stdout: '', stderr: `can't find session` };
        }
        return { stdout: '', stderr: '' };
    });
}

function makeProvider(over: {
    exec?: ReturnType<typeof fakeExec>;
    state?: ReturnType<typeof fakeState>;
    opened?: LaunchOptions[];
    historyLimit?: number;
} = {}) {
    const opened = over.opened ?? [];
    const exec = over.exec ?? fakeExec();
    const state = over.state ?? fakeState();
    const provider = new TmuxTerminalProvider({
        ctx: { hostKey: HOST, workspaceKey: WS, cwd: CWD },
        exec,
        state,
        openTerminal: (options: LaunchOptions): number => opened.push(options),
        log: { info: vi.fn(), trace: vi.fn() },
        historyLimit: over.historyLimit,
    });
    return { provider, opened, exec, state };
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

    it('does not adopt a detached-but-empty session (a corpse the reaper owns)', async () => {
        const exec = fakeExec({ list: [row(name(1), false, 0)] }); // 0 windows
        const opened: LaunchOptions[] = [];
        const { provider } = makeProvider({ exec, opened });

        await provider.initialize();

        expect(opened).toEqual([]);
        expect(provider.mappedSlots()).toEqual([]);
    });
});

describe('profile options (invisible + argv, no injection surface)', () => {
    it('returns tmux shellPath, the 02 argv builder output, cwd, and isTransient', async () => {
        const { provider } = makeProvider({ historyLimit: 50000 });
        const options = optionsOf(await provider.provideTerminalProfile());
        expect(options.shellPath).toBe('tmux');
        expect(options.shellArgs).toEqual(
            buildAttachOrCreateArgv(name(0), CWD, undefined, { historyLimit: 50000 }),
        );
        expect(options.cwd).toBe(CWD);
        expect(options.isTransient).toBe(true);
    });

    it('defaults the history limit through to the 02 builder when unset', async () => {
        const { provider } = makeProvider();
        const options = optionsOf(await provider.provideTerminalProfile());
        expect(options.shellArgs).toEqual(buildAttachOrCreateArgv(name(0), CWD));
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
