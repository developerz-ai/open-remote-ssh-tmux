import { createHash } from 'crypto';
import { escapeShellArg } from '../common/shellQuote';

// Re-exported for existing callers/tests that import `escapeShellArg` from
// this module — the implementation now lives in `common/shellQuote.ts` so
// `src/ssh/sshConnection.ts` (a lower layer this module must not be imported
// by) can share it without a tmux→ssh dependency inversion.
export { escapeShellArg };

// The session model — pure logic, the heart of the "no zombies" guarantee and
// the ONLY place tmux command lines are built. No `vscode`/`ssh2`/`ssh` imports
// so it is fully unit-testable. Every user-influenced string routed into a
// command goes through `escapeShellArg` (these command lines run on the remote
// via a shell; unescaped a hostile workspace path would be arbitrary code
// execution). See docs/idea/tmux-approach.md and docs/plans/.../02-session-model.md.

/** Namespace prefix for the sessions this extension owns. Reaping only ever
 * touches `code-*` sessions; the user's own sessions (e.g. `main`) are untouched. */
export const SESSION_PREFIX = 'code-';

/** Length of the workspace hash embedded in a session name (sha1 hex chars). */
const HASH_LENGTH = 12;

/** Default scrollback (lines) applied per session. Wired to a user setting by
 * the terminal provider; `historyLimit` applies to windows created after it is
 * set — see the create-options note below. */
const DEFAULT_HISTORY_LIMIT = 50000;

/** Session name shape this extension produces and is allowed to reap:
 * `code-<sha1_12>-<slot>`. Hex + digits only — no `.`/`:` (both forbidden by
 * tmux in session names). Matching this, not a bare `code-` prefix, keeps the
 * reaper conservative: a foreign `code`, `codex-x`, or `code-notes` is ignored. */
const OWNED_SESSION_RE = new RegExp(`^${SESSION_PREFIX}[0-9a-f]+-\\d+$`);

/** A parsed row from `tmux list-sessions` (see `buildListSessions` `-F`). */
export interface TmuxSession {
    /** `#{session_name}` */
    readonly name: string;
    /** `#{session_attached}` as a boolean (client count > 0). */
    readonly attached: boolean;
    /** `#{session_windows}` — window count. Always ≥ 1 for a live session: tmux
     * destroys a session when its last window closes (we set `remain-on-exit off`),
     * so this never reaches 0 and is NOT a corpse signal — see `paneDead`. */
    readonly windows: number;
    /** `#{pane_dead}` of the session's active pane — true when the pane's process
     * exited but the session lingers (a `remain-on-exit on` corpse). This, not
     * `windows`, is the reapable-corpse signal `shouldReap` gates on. */
    readonly paneDead: boolean;
    /** `#{session_created}` — unix epoch seconds. */
    readonly createdEpoch: number;
}

/** Per-session options applied at create time. */
export interface AttachOrCreateOptions {
    /** Scrollback lines for windows created after the session starts. Default 50000. */
    readonly historyLimit?: number;
}

/** Inputs to the reap decision beyond the session itself. */
export interface ReapOptions {
    /** Never reap a session younger than this many seconds — guards a session in a
     * create/list race (a pane that dies the instant it spawns) from being killed
     * before it stabilises. Default 0. */
    readonly minAgeSeconds?: number;
}

/**
 * Deterministic session name for a (host, workspace, terminal-slot) triple:
 * `code-<sha1_12(host + ' ' + workspacePath)>-<slot>`. Same inputs always yield
 * the same name, so re-opening a workspace re-attaches the SAME session instead
 * of spawning a duplicate (`tmux new-session -A`). The `code-` prefix is the
 * namespace the reaper is allowed to touch.
 */
export function sessionName(hostKey: string, workspaceKey: string, slot: number): string {
    if (!Number.isInteger(slot) || slot < 0) {
        throw new Error(`tmux session slot must be a non-negative integer, got: ${slot}`);
    }
    return `${SESSION_PREFIX}${workspaceHash(hostKey, workspaceKey)}-${slot}`;
}

/** The sha1-12 of `host + ' ' + workspacePath` embedded in every session name for
 * a (host, workspace). Shared by `sessionName` (build) and `sessionSlot` (parse)
 * so the two can never drift. */
function workspaceHash(hostKey: string, workspaceKey: string): string {
    return createHash('sha1').update(`${hostKey} ${workspaceKey}`).digest('hex').slice(0, HASH_LENGTH);
}

/**
 * The slot encoded in `name` iff it is one of THIS (host, workspace)'s sessions —
 * i.e. `name === sessionName(hostKey, workspaceKey, slot)`. Returns `undefined`
 * for anything else: a different workspace/host's session (hash mismatch), a
 * foreign session, or a malformed suffix. This maps a remote `list-sessions` row
 * back to a local slot by matching the full `code-<hash>-` prefix — never a bare
 * `code-`, so a sibling workspace on the same host can't collide with our slots.
 */
export function sessionSlot(name: string, hostKey: string, workspaceKey: string): number | undefined {
    const prefix = `${SESSION_PREFIX}${workspaceHash(hostKey, workspaceKey)}-`;
    if (!name.startsWith(prefix)) {
        return undefined;
    }
    const suffix = name.slice(prefix.length);
    return /^\d+$/.test(suffix) ? parseInt(suffix, 10) : undefined;
}

/** True iff the name matches the `code-<hash>-<slot>` namespace this extension owns. */
export function isOurSession(name: string): boolean {
    return OWNED_SESSION_RE.test(name);
}

/**
 * The argv form for attach-or-create — the array a VS Code terminal profile
 * carries as `shellArgs` (with `shellPath: 'tmux'`). The pty host hands argv to
 * `execve` **directly, with no intervening shell**, so — unlike the shell-string
 * builder — elements are NOT escaped and there is no injection surface: a hostile
 * workspace path is simply one inert argv element. The tmux command separator is a
 * bare `;` element (the shell form writes `\;` only to stop the shell from eating
 * the `;`). Same per-session hardening/cosmetics as the shell form, kept in lockstep.
 */
export function buildAttachOrCreateArgv(
    name: string,
    cwd: string,
    shell?: string,
    opts: AttachOrCreateOptions = {},
): string[] {
    const historyLimit = opts.historyLimit ?? DEFAULT_HISTORY_LIMIT;
    const create = ['new-session', '-A', '-s', name, '-c', cwd];
    if (shell !== undefined) {
        create.push(shell);
    }
    return [
        ...create,
        ';', 'set-window-option', '-t', `=${name}`, 'remain-on-exit', 'off',
        ';', 'set-option', '-t', `=${name}`, 'status', 'off',
        ';', 'set-option', '-t', `=${name}`, 'history-limit', String(historyLimit),
    ];
}

/**
 * `tmux list-sessions` with a stable `-F` format — the reap/restore paths must
 * parse machine output, never the localised human table. `#{pane_dead}` reports the
 * session's active pane's dead state (tmux resolves a session format against its
 * current window's active pane); for our single-window sessions that is the corpse
 * signal `shouldReap` needs — `#{session_windows}` can never fall to 0 on a live
 * session (tmux destroys it with its last window). It expands to `0`/`1`, so it is
 * always a token and safe as the right-anchored final field.
 */
export function buildListSessions(): string {
    return 'tmux list-sessions -F '
        + escapeShellArg('#{session_name} #{session_attached} #{session_windows} #{session_created} #{pane_dead}');
}

// `-t <name>` is prefix/fuzzy target matching in tmux — `has-session -t code-<h>-0`
// would report `code-<h>-01` as present, and `kill-session -t code-<h>-0` would kill
// that neighbour (a live session). `=` forces an exact-name target. It sits OUTSIDE
// the quotes so the shell concatenates it onto the still-escaped name; the argv form
// (`buildAttachOrCreateArgv`) prepends it to the inert element instead. Every builder
// that takes a `-t` target uses `=`; `new-session -s` is exempt (it names the new
// session, exact by construction).

/** `tmux has-session -t =<name>`. */
export function buildHasSession(name: string): string {
    return `tmux has-session -t =${escapeShellArg(name)}`;
}

/** `tmux kill-session -t =<name>`. */
export function buildKillSession(name: string): string {
    return `tmux kill-session -t =${escapeShellArg(name)}`;
}

/**
 * Parse `buildListSessions` output into typed rows. Tolerant by design: empty
 * output, whitespace-only, and the `no server running …` message all mean "zero
 * sessions" (not an error); malformed lines are skipped. The four trailing fields
 * are numeric, so fields are read from the right — a foreign session name containing
 * spaces still parses.
 */
export function parseListSessions(stdout: string): TmuxSession[] {
    const sessions: TmuxSession[] = [];
    for (const rawLine of stdout.split('\n')) {
        const line = rawLine.trim();
        if (line === '' || line.startsWith('no server running')) {
            continue;
        }
        const tokens = line.split(/\s+/);
        if (tokens.length < 5) {
            continue;
        }
        const paneDeadFlag = toNonNegativeInt(tokens[tokens.length - 1]);
        const createdEpoch = toNonNegativeInt(tokens[tokens.length - 2]);
        const windows = toNonNegativeInt(tokens[tokens.length - 3]);
        const attachedCount = toNonNegativeInt(tokens[tokens.length - 4]);
        if (paneDeadFlag === undefined || createdEpoch === undefined
            || windows === undefined || attachedCount === undefined) {
            continue;
        }
        sessions.push({
            name: tokens.slice(0, tokens.length - 4).join(' '),
            attached: attachedCount > 0,
            windows,
            paneDead: paneDeadFlag > 0,
            createdEpoch,
        });
    }
    return sessions;
}

/**
 * Conservative reap decision — pure, with the clock injected (`now`, epoch
 * seconds; no `Date.now()` inside). Reap iff the session is one of OURS, is not
 * attached, is a genuine corpse (its active pane is dead — the process exited but
 * the session lingers under `remain-on-exit`), and has cleared the startup grace
 * window. When in doubt, keep: a foreign session, an attached session, or any
 * session with a live pane (a detached long-running task) is never touched.
 *
 * The gate is `paneDead`, NOT `windows`: gating on `windows === 0` was a no-op,
 * because tmux destroys a session when its last window closes (we set
 * `remain-on-exit off`), so an owned session never appears with 0 windows — a
 * corpse surfaces as a live-window/dead-pane session instead. That unreachable
 * predicate is what left the reaper doing nothing; `paneDead` is what makes it fire.
 */
export function shouldReap(session: TmuxSession, now: number, opts: ReapOptions = {}): boolean {
    if (!isOurSession(session.name)) {
        return false;
    }
    if (session.attached) {
        return false;
    }
    if (!session.paneDead) {
        return false;
    }
    const minAgeSeconds = opts.minAgeSeconds ?? 0;
    if (now - session.createdEpoch < minAgeSeconds) {
        return false;
    }
    return true;
}

/** Parse a token as a non-negative integer, or `undefined` if it is not one. */
function toNonNegativeInt(token: string): number | undefined {
    if (!/^\d+$/.test(token)) {
        return undefined;
    }
    return parseInt(token, 10);
}
