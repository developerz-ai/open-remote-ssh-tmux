import { withDeadline } from '../common/deadline';
import { escapeShellArg } from '../common/shellQuote';

// The tmux layer's command runner. Upstream's `SSHConnection#exec` resolves only when the
// remote stream closes and reports no exit code, so on a half-dead link it waits forever and
// on a live one it cannot tell "tmux said no" from "tmux never ran". Both are fixed here, on
// top of that unchanged signature (fork hygiene: no upstream hunk):
//
//   * every call is bounded by `withDeadline` — a hung channel becomes a rejection the
//     provider/reaper already treat as "could not ask", never a pending promise;
//   * the command runs as `sh -c '<cmd>; printf …"$?"'`, so the remote shell itself prints
//     the exit status on a final marker line, which is parsed back out of stdout.
//
// `sh -c '…'` is the same wrapping as `PROBE_COMMAND` (`tmuxBootstrap.ts`) for the same
// reason: a csh/tcsh login shell would otherwise parse `;`/`$?` itself. The wrapper is a
// single line with every embedded quote re-escaped, so it adds no injection surface.

/** The raw remote runner this module wraps — the shape of `SSHConnection#exec` (and of
 * `extension.ts`'s `lazyExec`), declared locally so the tmux layer never imports `ssh2`. */
export type RawExec = (command: string) => Promise<{ stdout: string; stderr: string }>;

/** One remote command's outcome. `code` is the command's exit status, or `undefined` when
 * the marker never came back (the command did not run to completion under our shell), which
 * callers must read as "unknown", never as success or as "absent". */
export interface RemoteExecResult {
    readonly stdout: string;
    readonly stderr: string;
    readonly code: number | undefined;
}

/** The command-runner abstraction every remote call in `src/tmux/*` goes through. Rejects on
 * a failed channel or a missed deadline (`DeadlineError`). */
export type RemoteExec = (command: string) => Promise<RemoteExecResult>;

/** Marker prefix of the exit-status line the wrapper appends. */
const RC_MARKER = '__rc=';

/** The marker as the LAST line of stdout: preceded by the wrapper's own newline, optionally
 * followed by trailing whitespace. Anchored at the end so output that merely contains the
 * token (a session called `__rc=0`, a banner) can never be mistaken for it. */
const RC_LINE_RE = new RegExp(`\\n${RC_MARKER}(\\d+)\\s*$`);

/** Wrap `command` so the remote shell prints its exit status on a final marker line. The
 * leading `\n` in the printf keeps the marker on its own line even when the command's
 * output does not end with a newline. */
export function wrapWithExitCode(command: string): string {
    return `sh -c ${escapeShellArg(`${command}; printf '\\n${RC_MARKER}%s\\n' "$?"`)}`;
}

/** Split the exit-status marker off `stdout`. Missing marker → `code: undefined` and stdout
 * untouched. Anything before the marker (login-shell banner noise included) is kept as the
 * command's output — the callers' parsers already skip lines they do not recognise. */
export function parseExitCode(stdout: string): { stdout: string; code: number | undefined } {
    const match = RC_LINE_RE.exec(stdout);
    if (!match) {
        return { stdout, code: undefined };
    }
    return { stdout: stdout.slice(0, match.index), code: parseInt(match[1], 10) };
}

/** Build the tmux layer's {@link RemoteExec} over a raw runner: exit-code marker plus a
 * deadline of `deadlineMs` per call. */
export function createRemoteExec(raw: RawExec, deadlineMs: number): RemoteExec {
    return async (command: string) => {
        const { stdout, stderr } = await withDeadline(raw(wrapWithExitCode(command)), deadlineMs, 'tmux command');
        return { ...parseExitCode(stdout), stderr };
    };
}

// The close watch (bug A of the 2026-11-14 EDH run) — the one remote command the layer leaves
// RUNNING. A window that closes cannot tell the remote so itself: VS Code kills the extension
// host ~4 ms after "terminate", which no round-trip outruns, and disposes the extension's
// subscriptions — the SSH connection among them — without waiting for `deactivate`. Meanwhile
// VS Code's pty host keeps the window's tmux clients alive for its reconnection grace (3 h),
// so another machine found every session still held: a take-over offer, or two minutes of
// waiting, where a hand-off was meant to be instant.
//
// What does reach the remote, every time, is the connection dropping. The watch command
// (`buildCloseWatchCommand`) waits for exactly that and then marks this window's sessions as
// closed; `createCloseWatch` only makes sure each connection carries one. It is started on
// every resolve (a reconnect brings a new connection) and needs no stopping: it ends with the
// connection it watches.

/** What the watch needs, injected so this is testable without ssh2 (D in SOLID). */
export interface CloseWatchDeps<C extends object> {
    /** The SSH connection this window is on right now; `undefined` between connections. */
    current(): C | undefined;
    /** Run `command` on `connection`. Settles when its channel closes — for the watch, when
     * the connection is gone. */
    run(connection: C, command: string): Promise<unknown>;
    readonly log: { trace(message: string): void };
}

/**
 * Returns `ensure(command)`: start the watch `command` (`buildCloseWatchCommand`) on the
 * current connection unless that connection already carries one. Create it once per window,
 * so a layer rebuilt on the same connection (a settings or folder change) does not start a
 * second. Never throws — a watch that cannot start costs only the fallback (the other machine
 * waits out the idle threshold), never the connect.
 */
export function createCloseWatch<C extends object>(deps: CloseWatchDeps<C>): (command: string) => void {
    const watched = new WeakSet<C>();
    return (command: string) => {
        const connection = deps.current();
        if (connection === undefined || watched.has(connection)) {
            return;
        }
        watched.add(connection);
        const failed = (err: unknown): void =>
            deps.log.trace(`Persistent terminals: close watch failed: ${err instanceof Error ? err.message : String(err)}`);
        try {
            deps.run(connection, command).catch(failed);
        } catch (err) {
            failed(err);
        }
    };
}
