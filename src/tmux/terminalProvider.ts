import * as vscode from 'vscode';
import {
    buildAttachOrCreateArgv,
    buildHasSession,
    buildListSessions,
    parseListSessions,
    sessionName,
    sessionSlot,
} from './tmuxSession';

// The VS Code-facing heart of the fork: a terminal-profile provider that backs
// each integrated terminal with a tmux session (`tmuxSession.ts` — the ONLY place
// tmux command lines are built; this module never concatenates a tmux string).
// Its whole job is deciding *which slot* a terminal maps to, so the two hard
// invariants hold:
//
//   * Invisible — profiles are plain `{shellPath:'tmux', shellArgs, cwd}`, the tab
//     is titled after the workspace folder (never "tmux"); no tmux UI (Route A, see
//     docs/idea/tmux-approach.md). The one settings write in the whole layer —
//     `terminal.integrated.defaultProfile.linux`, Workspace-scoped, only when unset —
//     lives in `extension.ts`'s `setDefaultTerminalProfileIfUnset`, not here.
//   * No zombies / no stealing — a *new* terminal takes the lowest slot not open
//     in this window and not currently attached by another client on the remote,
//     so a second client (laptop while the PC is attached) lands on a fresh slot
//     instead of -A-attaching into the PC's session. On reload we re-attach this
//     client's own mapped survivors and *adopt* detached orphans (hand-off), but
//     never touch a session another client holds.
//
// Everything is dependency-inverted (D in SOLID): the remote command runner
// (`RemoteExec`), the persistence (`vscode.Memento`), the terminal opener, and the
// logger are all injected, so the allocation/restore/adoption logic is pure and
// unit-testable with no real ssh2. Terminal *close* never `kill-session`s: closing
// detaches the tmux client and the session lives on in the tmux server — the whole
// close-PC/open-laptop use case. It does *tombstone* the slot, though, so a terminal
// the user explicitly closed is not auto-resurrected on the next reload (restore and
// adoption both skip tombstoned slots); reopening the slot clears the tombstone and
// -A-attaches the still-live session. Session death is a process exiting
// (`remain-on-exit off`, 02); empty leftovers are cleaned by the reaper
// (`sessionReaper.ts`), not here.

/** The single remote-exec capability the provider needs. Matches the shape of
 * `SSHConnection#exec` (whose extra optional params are compatible) but named as
 * its own abstraction so this module never imports `ssh2`/`ssh`. No exit code is
 * surfaced — command status is read from stdout/stderr, exactly as tmux reports. */
export type RemoteExec = (command: string) => Promise<{ stdout: string; stderr: string }>;

/** Open a VS Code terminal for a restored/adopted session. Injected (rather than
 * calling `vscode.window.createTerminal` inline) so restore/adoption orchestration
 * is unit-testable. The production wiring passes a thin `createTerminal` adapter. */
export type OpenTerminal = (options: vscode.TerminalOptions) => void;

/** The narrow slice of `Log` this module uses (ISP) — one-line invisible-UX logs. */
export interface TmuxLog {
    info(message: string): void;
    trace(message: string): void;
}

/** The resolved (host, workspace) this provider serves. Slot → session name is a
 * pure function of these, so the mapping is stable across reconnects. */
export interface TmuxSessionContext {
    /** Stable host identity (e.g. the resolved hostname) — half of the session hash. */
    readonly hostKey: string;
    /** Remote workspace path — the other half of the session hash. */
    readonly workspaceKey: string;
    /** Remote working directory new sessions start in (workspace folder). */
    readonly cwd: string;
}

/** Collaborators + config for a `TmuxTerminalProvider`. */
export interface TmuxTerminalDeps {
    readonly ctx: TmuxSessionContext;
    readonly exec: RemoteExec;
    /** Client-local persistence — `context.workspaceState` (pattern:
     * `remoteLocationHistory.ts`). Client-local is exactly the wanted semantics:
     * each machine restores *its* terminals, not a shared set. */
    readonly state: vscode.Memento;
    readonly openTerminal: OpenTerminal;
    readonly log: TmuxLog;
    /** Scrollback lines for new sessions (`remote.SSH.tmux.historyLimit`, 05).
     * Undefined → the session model's default (50000). */
    readonly historyLimit?: number;
    /** Absolute path to the remote tmux binary, as resolved by the bootstrap probe
     * (`command -v tmux`, see `tmuxBootstrap.ts`'s `TmuxCapability.path`). Used as
     * the launched terminal's `shellPath` so VS Code invokes tmux by absolute path.
     * VS Code spawns `shellPath` directly, not through a login shell, so a bare
     * `tmux` misses installs off the default PATH (nix profile, `~/.local/bin`) and
     * fails with a tmux-naming spawn error. Undefined → fall back to a bare `tmux`
     * on PATH (probe printed no path line, or an exotic build). */
    readonly tmuxPath?: string;
}

/** workspaceState key holding the client-local `slot → sessionName` mapping.
 * Versioned so the shape can evolve without colliding with old data. */
export const SLOT_MAPPING_STATE_KEY = 'tmux.slotSessions.v1';

/** workspaceState key holding the client-local set of user-closed ("tombstoned")
 * slots — an array of slot numbers. Versioned like {@link SLOT_MAPPING_STATE_KEY}.
 * A tombstoned slot is one the user explicitly closed: its session is kept alive on
 * the remote (close = detach, never kill) but the slot is excluded from connect-time
 * restore *and* adoption, so it stays closed across reloads instead of resurrecting.
 * Cleared when the user opens a new terminal on that slot. */
export const TOMBSTONE_STATE_KEY = 'tmux.tombstonedSlots.v1';

/** Fallback `shellPath` when the probe resolved no absolute tmux path — a bare
 * `tmux` on PATH (see {@link TmuxTerminalDeps.tmuxPath} for why a path is preferred). */
const TMUX_BIN = 'tmux';

/** stderr markers that mean "that session/server is not there" (no exit code is
 * surfaced by `exec`, so existence is read from the message). */
const MISSING_SESSION_RE = /can't find|no server running|no such|error connecting/i;

/** One of this workspace's sessions as seen on the remote right now. */
interface RemoteSession {
    readonly slot: number;
    readonly name: string;
    readonly attached: boolean;
    readonly windows: number;
}

export class TmuxTerminalProvider implements vscode.TerminalProfileProvider {
    private readonly ctx: TmuxSessionContext;
    private readonly exec: RemoteExec;
    private readonly state: vscode.Memento;
    private readonly openTerminal: OpenTerminal;
    private readonly log: TmuxLog;
    private readonly historyLimit?: number;
    /** Resolved `shellPath` for every launched terminal — the probe's absolute tmux
     * path when known, else a bare `tmux` on PATH ({@link TMUX_BIN}). */
    private readonly tmuxPath: string;

    /** Persisted client-local mapping of slot → session name (survives reloads). */
    private readonly mapping: Map<number, string>;
    /** Slots currently backing an open terminal in *this* window. */
    private readonly openSlots = new Set<number>();
    /** Slots a *remote* session is currently attached to (any client) — the
     * no-steal guard, refreshed from `list-sessions` at connect and on each create. */
    private attachedRemoteSlots = new Set<number>();
    /** Slots held for connect-time restore/adoption. Seeded synchronously from the
     * persisted mapping in the constructor — *before* {@link initialize}'s first
     * `await` — so a `provideTerminalProfile` that races (or precedes) `initialize`
     * cannot hand a survivor's slot to a brand-new terminal: that produced a second,
     * mirrored tab on slot 0. Drained once reconciliation has resolved every survivor
     * into `openSlots` (or pruned it), so a later close-then-reopen can still reuse a
     * slot ({@link releaseSlot}). */
    private readonly reservedSlots: Set<number>;
    /** Slots the user explicitly closed — excluded from restore/adoption so a
     * closed terminal is not resurrected on reload (see {@link TOMBSTONE_STATE_KEY}).
     * Seeded from persisted state; a new terminal on the slot clears its tombstone. */
    private readonly tombstones: Set<number>;
    /** Backing store for {@link initialized}. */
    private reconciliation: Promise<void> = Promise.resolve();

    constructor(deps: TmuxTerminalDeps) {
        this.ctx = deps.ctx;
        this.exec = deps.exec;
        this.state = deps.state;
        this.openTerminal = deps.openTerminal;
        this.log = deps.log;
        this.historyLimit = deps.historyLimit;
        this.tmuxPath = deps.tmuxPath ?? TMUX_BIN;
        this.mapping = readMapping(deps.state);
        this.reservedSlots = new Set(this.mapping.keys());
        this.tombstones = readTombstones(deps.state);
    }

    /** Resolves when connect-time reconciliation ({@link initialize}) has settled;
     * an already-resolved promise until `initialize` is first invoked. Awaited by
     * {@link provideTerminalProfile} so a new terminal never allocates a slot that
     * restore/adoption is about to claim (the init race). Assigned synchronously at
     * `initialize` entry, before its first `await`. */
    get initialized(): Promise<void> {
        return this.reconciliation;
    }

    /**
     * Connect/reload reconciliation. Re-attaches this client's mapped survivors,
     * prunes dead mappings, then adopts any detached-but-live orphan session of
     * this workspace that no client holds (hand-off: PC closed → laptop takes over;
     * reconciliation: PC reconnects → its own + the laptop's orphan). Attached
     * sessions of another client are left strictly untouched (no steal, no mirror).
     */
    initialize(): Promise<void> {
        // Publish the gate *before* the first `await` (assignment is synchronous, so
        // extension.ts wiring `initialize()` ahead of registering the provider arms the
        // gate before any `provideTerminalProfile`). Once reconciliation settles, every
        // survivor is in `openSlots` (or pruned), so drop the connect-time reservations
        // — `finally` so a failed probe never wedges them on — letting a later
        // close-then-reopen reuse a slot ({@link releaseSlot}). Callers keep awaiting
        // the returned promise as before.
        this.reconciliation = this.reconcile().finally(() => this.reservedSlots.clear());
        return this.reconciliation;
    }

    private async reconcile(): Promise<void> {
        const remote = await this.refreshRemote();
        const remoteBySlot = new Map(remote.map(s => [s.slot, s]));

        let restored = 0;
        let pruned = 0;
        for (const slot of [...this.mapping.keys()].sort((a, b) => a - b)) {
            const session = this.mapping.get(slot)!;
            // User explicitly closed this terminal: keep the mapping and its still-live
            // session (close = detach, never kill) but do not resurrect it on reload.
            // The tombstone is lifted when the user opens a new terminal on this slot
            // (`provideTerminalProfile`).
            if (this.tombstones.has(slot)) {
                this.log.trace(`tmux terminal: slot ${slot} tombstoned (user-closed) — not restoring`);
                continue;
            }
            // No-steal / no-mirror: if another client already holds this slot's
            // session (we aren't attached yet, so `attached` means "elsewhere"),
            // re-attaching would share the tmux view and mirror keystrokes on
            // hand-off (close PC → open laptop). Existence alone can't tell the two
            // apart, so consult the `attached` flag from the `list-sessions` snapshot
            // above. Leave it strictly untouched and keep the mapping — a later
            // reconnect re-attaches it once the other client detaches.
            if (remoteBySlot.get(slot)?.attached) {
                this.log.trace(`tmux terminal: slot ${slot} attached elsewhere — not re-attaching (no mirror)`);
                continue;
            }
            if (await this.sessionExists(session)) {
                this.reopen(slot);
                restored++;
            } else {
                this.mapping.delete(slot);
                pruned++;
            }
        }

        let adopted = 0;
        for (const session of remote) {
            if (session.attached || session.windows === 0) {
                continue; // held by another client, or an empty corpse the reaper owns
            }
            if (this.tombstones.has(session.slot)) {
                continue; // user explicitly closed this slot — don't re-adopt its session
            }
            if (this.mapping.has(session.slot) || this.openSlots.has(session.slot)) {
                continue; // already this client's (restored above)
            }
            this.mapping.set(session.slot, session.name);
            this.reopen(session.slot);
            adopted++;
        }

        await this.persist();
        if (restored || adopted || pruned) {
            // Invisible UX: nothing louder than one log line, even on adoption.
            this.log.info(`tmux terminals: ${restored} re-attached, ${adopted} adopted, ${pruned} pruned`);
        }
    }

    /**
     * VS Code asks for a profile when a *new* terminal is created. Allocate the
     * lowest slot free both here and on the remote, record it, and return plain
     * terminal options; VS Code spawns the process (on the remote — Route A). The
     * token param is intentionally omitted (nothing to cancel in this cheap path).
     */
    async provideTerminalProfile(): Promise<vscode.TerminalProfile> {
        // Wait out connect-time restore/adoption so a brand-new terminal never races
        // onto a slot it is about to claim (duplicate mirrored tab). A failed restore
        // must not block new terminals, so its rejection is swallowed here.
        await this.initialized.catch(() => { /* restore failure never blocks a new terminal */ });
        await this.refreshRemote(); // no-steal snapshot, refreshed on create
        let slot = this.allocateSlot();
        // Shrink the no-steal TOCTOU: VS Code spawns the tmux process only *after*
        // this returns (a window we can't observe from here), so the snapshot above
        // can go stale — another client could attach our slot in between. Re-probe as
        // the last remote read before committing; if the chosen slot went free →
        // attached-elsewhere since, allocate again against the refreshed set
        // (`allocateSlot` skips `attachedRemoteSlots`). The two probes are kept
        // deliberately (don't collapse to one): the second is what makes the decision
        // reflect the freshest reachable state. This only narrows the race — the
        // return→spawn window is irreducible from here.
        await this.refreshRemote();
        if (this.attachedRemoteSlots.has(slot)) {
            this.log.trace(`tmux terminal: slot ${slot} taken since snapshot — reallocating`);
            slot = this.allocateSlot();
        }
        this.openSlots.add(slot);
        const name = sessionName(this.ctx.hostKey, this.ctx.workspaceKey, slot);
        this.mapping.set(slot, name);
        // Opening a terminal here is a deliberate (re)open — lift any user-closed
        // tombstone so a later reload restores this slot normally again.
        this.tombstones.delete(slot);
        await this.persist();
        this.log.trace(`tmux terminal: new slot ${slot} (${name})`);
        return new vscode.TerminalProfile(this.buildOptions(slot));
    }

    /**
     * A terminal for `slot` closed. Free the slot for reuse *in this window*; its
     * remote session is kept (close = detach, never kill). This is the low-level
     * primitive: the explicit-close path ({@link handleTerminalClosed}) additionally
     * tombstones the slot so a *reload* does not resurrect it. Opening a new terminal
     * still reuses this slot — the same client -A-attaching its own session (not a
     * steal) — which lifts the tombstone.
     */
    releaseSlot(slot: number): void {
        this.openSlots.delete(slot);
        this.log.trace(`tmux terminal: slot ${slot} released (detached, session kept)`);
    }

    /** Mark `slot` as user-closed so connect-time restore and adoption skip it on
     * later reloads, and persist that. The session is *not* killed (close = detach);
     * reopening the slot lifts the tombstone and -A-attaches it. Idempotent. Persist
     * is fire-and-forget — the VS Code close-event handler is synchronous — with the
     * failure swallowed to a trace (mirrors `extension.ts`'s init `.catch`). */
    private tombstone(slot: number): void {
        if (this.tombstones.has(slot)) {
            return;
        }
        this.tombstones.add(slot);
        this.persist().catch(err => this.log.trace(`tmux terminal: tombstone persist failed: ${errorText(err)}`));
    }

    /** Live `vscode.Terminal` -> slot, so a later close can find and release the
     * right slot. VS Code gives the provider no handle to the `Terminal` it
     * eventually constructs from a returned `TerminalProfile` (nor from `reopen`'s
     * `openTerminal` call, which returns `void`) — this is populated instead from
     * `vscode.window.onDidOpenTerminal`, which fires for every terminal with the
     * `creationOptions` this provider gave it. */
    private readonly terminalSlots = new Map<vscode.Terminal, number>();

    /**
     * Wire from `vscode.window.onDidOpenTerminal`. Records the slot (parsed back
     * out of the session name this provider baked into `shellArgs`) so the
     * matching `handleTerminalClosed` can free it. No-op for terminals that
     * aren't ours (no `shellArgs`, or a session name outside this workspace).
     */
    handleTerminalOpened(terminal: vscode.Terminal): void {
        const slot = this.slotFromCreationOptions(terminal.creationOptions);
        if (slot !== undefined) {
            this.terminalSlots.set(terminal, slot);
        }
    }

    /**
     * Wire from `vscode.window.onDidCloseTerminal` — the fix for the real gap
     * `releaseSlot` alone left open: nothing was ever calling it. Without this,
     * closing and reopening a terminal in the same window session never freed a
     * slot, so every "New Terminal" after a close minted a brand-new, ever-growing
     * remote session instead of reattaching the one just detached.
     */
    handleTerminalClosed(terminal: vscode.Terminal): void {
        const slot = this.terminalSlots.get(terminal);
        if (slot !== undefined) {
            this.terminalSlots.delete(terminal);
            this.releaseSlot(slot);
            // Explicit user close: tombstone so a later reload does not resurrect it.
            this.tombstone(slot);
        }
    }

    /** The slot encoded in `options.shellArgs`' `-s <name>` (our `buildAttachOrCreateArgv`
     * shape), resolved via `sessionSlot` so it also filters out anything that isn't
     * one of this workspace's own sessions. `undefined` for anything else. */
    private slotFromCreationOptions(options: vscode.Terminal['creationOptions']): number | undefined {
        if (!options || !('shellArgs' in options) || !Array.isArray(options.shellArgs)) {
            return undefined;
        }
        const flagIndex = options.shellArgs.indexOf('-s');
        const name = flagIndex >= 0 ? options.shellArgs[flagIndex + 1] : undefined;
        return typeof name === 'string' ? sessionSlot(name, this.ctx.hostKey, this.ctx.workspaceKey) : undefined;
    }

    /** Slots this client currently maps — observability for wiring and tests. */
    mappedSlots(): number[] {
        return [...this.mapping.keys()].sort((a, b) => a - b);
    }

    /** Lowest slot not open in this window, not attached elsewhere on the remote, and
     * not reserved for connect-time restore/adoption (the init-race guard). */
    private allocateSlot(): number {
        let slot = 0;
        while (this.openSlots.has(slot) || this.attachedRemoteSlots.has(slot) || this.reservedSlots.has(slot)) {
            slot++;
        }
        return slot;
    }

    /** Open (or re-attach — `-A` is idempotent) a terminal for `slot`. Idempotent
     * across reconnects: a re-resolve re-runs {@link reconcile} over the same mapping,
     * so a slot already backing an open terminal in this window is skipped rather than
     * spawning a second, mirrored tab. Only genuinely-not-open survivors/orphans open. */
    private reopen(slot: number): void {
        if (this.openSlots.has(slot)) {
            return;
        }
        this.openSlots.add(slot);
        this.openTerminal(this.buildOptions(slot));
    }

    private buildOptions(slot: number): vscode.TerminalOptions {
        const name = sessionName(this.ctx.hostKey, this.ctx.workspaceKey, slot);
        return {
            // Invisible UX: title the tab after the workspace folder, never "tmux".
            name: folderName(this.ctx.cwd),
            // Absolute path from the probe (or a bare `tmux` fallback) — see tmuxPath.
            shellPath: this.tmuxPath,
            shellArgs: buildAttachOrCreateArgv(name, this.ctx.cwd, undefined, { historyLimit: this.historyLimit }),
            cwd: this.ctx.cwd,
            // tmux owns persistence — opt this terminal out of VS Code's own revive
            // so a reload does not double it with a plain-shell copy (04 step 3).
            isTransient: true,
        };
    }

    /** Snapshot this workspace's sessions on the remote; also refresh the
     * attached-elsewhere guard. Degrades to "no sessions" if the probe fails —
     * never breaks the connect. */
    private async refreshRemote(): Promise<RemoteSession[]> {
        let result: { stdout: string; stderr: string };
        try {
            result = await this.exec(buildListSessions());
        } catch (err) {
            // Retain the last-known `attachedRemoteSlots` on a *transient* probe
            // failure (network blip): clearing it would silently disarm the no-steal
            // guard, and the next new terminal could -A-attach a slot another client
            // holds (mirrored keystrokes). Erring safe keeps a since-detached slot
            // guarded only until the next *successful* probe re-syncs it — worst case
            // a higher slot number, never a steal. The empty return still means "saw no
            // sessions this round" so restore/adoption don't act on data we don't have.
            this.log.trace(`tmux list-sessions failed: ${errorText(err)}`);
            return [];
        }
        const sessions: RemoteSession[] = [];
        const attached = new Set<number>();
        for (const parsed of parseListSessions(result.stdout)) {
            const slot = sessionSlot(parsed.name, this.ctx.hostKey, this.ctx.workspaceKey);
            if (slot === undefined) {
                continue; // another workspace/user's session — not ours to touch
            }
            sessions.push({ slot, name: parsed.name, attached: parsed.attached, windows: parsed.windows });
            if (parsed.attached) {
                attached.add(slot);
            }
        }
        this.attachedRemoteSlots = attached;
        return sessions;
    }

    /** Whether a named session still exists (`has-session`), read from stderr since
     * `exec` surfaces no exit code. A failed probe counts as "gone" (prune). */
    private async sessionExists(name: string): Promise<boolean> {
        try {
            const { stderr } = await this.exec(buildHasSession(name));
            return !MISSING_SESSION_RE.test(stderr);
        } catch {
            return false;
        }
    }

    private async persist(): Promise<void> {
        const record: Record<string, string> = {};
        for (const [slot, name] of this.mapping) {
            record[String(slot)] = name;
        }
        await this.state.update(SLOT_MAPPING_STATE_KEY, record);
        await this.state.update(TOMBSTONE_STATE_KEY, [...this.tombstones].sort((a, b) => a - b));
    }
}

/** Load the persisted `slot → sessionName` mapping, ignoring malformed entries. */
function readMapping(state: vscode.Memento): Map<number, string> {
    const raw = state.get<Record<string, string>>(SLOT_MAPPING_STATE_KEY) ?? {};
    const mapping = new Map<number, string>();
    for (const [key, value] of Object.entries(raw)) {
        const slot = Number(key);
        if (Number.isInteger(slot) && slot >= 0 && typeof value === 'string') {
            mapping.set(slot, value);
        }
    }
    return mapping;
}

/** Load the persisted set of user-closed slots, ignoring malformed entries. */
function readTombstones(state: vscode.Memento): Set<number> {
    const raw = state.get<unknown>(TOMBSTONE_STATE_KEY) ?? [];
    const tombstones = new Set<number>();
    if (Array.isArray(raw)) {
        for (const value of raw) {
            const slot = Number(value);
            if (Number.isInteger(slot) && slot >= 0) {
                tombstones.add(slot);
            }
        }
    }
    return tombstones;
}

/** Last path segment of a POSIX path (remote paths are Unix — tmux is Unix-only).
 * Used as the invisible tab title; falls back to the whole path for edge inputs. */
function folderName(remotePath: string): string {
    const trimmed = remotePath.replace(/\/+$/, '');
    const slash = trimmed.lastIndexOf('/');
    const base = slash >= 0 ? trimmed.slice(slash + 1) : trimmed;
    return base || remotePath;
}

/** Best-effort message from an unknown thrown value (for trace logs only). */
function errorText(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}
