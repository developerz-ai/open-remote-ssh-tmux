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
// unit-testable with no real ssh2. Terminal *close* is deliberately a no-op here:
// closing detaches the tmux client (the session lives on in the tmux server); we
// never `kill-session` on close — that is the whole close-PC/open-laptop use case.
// Session death is a process exiting (`remain-on-exit off`, 02); empty leftovers
// are cleaned by the reaper (`sessionReaper.ts`), not here.

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
}

/** workspaceState key holding the client-local `slot → sessionName` mapping.
 * Versioned so the shape can evolve without colliding with old data. */
export const SLOT_MAPPING_STATE_KEY = 'tmux.slotSessions.v1';

/** The remote shell binary a tmux-backed terminal launches. */
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

    /** Persisted client-local mapping of slot → session name (survives reloads). */
    private readonly mapping: Map<number, string>;
    /** Slots currently backing an open terminal in *this* window. */
    private readonly openSlots = new Set<number>();
    /** Slots a *remote* session is currently attached to (any client) — the
     * no-steal guard, refreshed from `list-sessions` at connect and on each create. */
    private attachedRemoteSlots = new Set<number>();

    constructor(deps: TmuxTerminalDeps) {
        this.ctx = deps.ctx;
        this.exec = deps.exec;
        this.state = deps.state;
        this.openTerminal = deps.openTerminal;
        this.log = deps.log;
        this.historyLimit = deps.historyLimit;
        this.mapping = readMapping(deps.state);
    }

    /**
     * Connect/reload reconciliation. Re-attaches this client's mapped survivors,
     * prunes dead mappings, then adopts any detached-but-live orphan session of
     * this workspace that no client holds (hand-off: PC closed → laptop takes over;
     * reconciliation: PC reconnects → its own + the laptop's orphan). Attached
     * sessions of another client are left strictly untouched (no steal, no mirror).
     */
    async initialize(): Promise<void> {
        const remote = await this.refreshRemote();

        let restored = 0;
        let pruned = 0;
        for (const slot of [...this.mapping.keys()].sort((a, b) => a - b)) {
            const session = this.mapping.get(slot)!;
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
        await this.refreshRemote(); // no-steal snapshot, refreshed on create
        const slot = this.allocateSlot();
        this.openSlots.add(slot);
        const name = sessionName(this.ctx.hostKey, this.ctx.workspaceKey, slot);
        this.mapping.set(slot, name);
        await this.persist();
        this.log.trace(`tmux terminal: new slot ${slot} (${name})`);
        return new vscode.TerminalProfile(this.buildOptions(slot));
    }

    /**
     * A terminal for `slot` closed. Free the slot for reuse *in this window* but
     * keep its mapping and its remote session: close = detach, never kill. On a
     * later reload the mapping re-attaches it; opening a new terminal now reuses
     * this slot (the same client -A-attaching its own session — not a steal).
     */
    releaseSlot(slot: number): void {
        this.openSlots.delete(slot);
        this.log.trace(`tmux terminal: slot ${slot} released (detached, session kept)`);
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

    /** Lowest slot not open in this window and not attached elsewhere on the remote. */
    private allocateSlot(): number {
        let slot = 0;
        while (this.openSlots.has(slot) || this.attachedRemoteSlots.has(slot)) {
            slot++;
        }
        return slot;
    }

    /** Open (or re-attach — `-A` is idempotent) a terminal for `slot`. */
    private reopen(slot: number): void {
        this.openSlots.add(slot);
        this.openTerminal(this.buildOptions(slot));
    }

    private buildOptions(slot: number): vscode.TerminalOptions {
        const name = sessionName(this.ctx.hostKey, this.ctx.workspaceKey, slot);
        return {
            // Invisible UX: title the tab after the workspace folder, never "tmux".
            name: folderName(this.ctx.cwd),
            shellPath: TMUX_BIN,
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
            this.log.trace(`tmux list-sessions failed: ${errorText(err)}`);
            this.attachedRemoteSlots = new Set();
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
