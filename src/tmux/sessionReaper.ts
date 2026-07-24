import {
    buildKillSession,
    buildListSessions,
    parseListSessions,
    shouldReap,
    TmuxSession,
} from './tmuxSession';

// Connect-time housekeeping — the anti-zombie backstop that complements the
// terminal provider. On a successful resolve (and on manual refresh) it lists the
// remote's tmux sessions and kills exactly the *empty, detached* ones THIS
// extension owns: the corpses left behind when a terminal's shell exits while the
// client is disconnected, which the provider's create/close path can't clean up
// because no window is around to see them die. The kill DECISION itself lives in
// the session model (`shouldReap`, 02) — this module only orchestrates
// list -> parse -> decide -> kill and keeps a count for one invisible log line, so
// there is no tmux string concatenation outside 02.
//
// Dependency-inverted (D in SOLID) and side-effect-narrow: the remote command
// runner, an epoch-seconds clock (so reap decisions are deterministic and this
// module never calls `Date.now()` — CLAUDE.md), and a narrow logger are all
// injected, so it imports neither `vscode` nor `ssh2`/`ssh` and stays a leaf.
// It is deliberately NOT capability-aware: the wiring (`extension.ts`) constructs
// and invokes it only when the bootstrap probe said tmux is available (03), keeping
// "should tmux run at all?" in one place instead of smeared across collaborators.
//
// Conservative by construction: a foreign session, an attached session, a session
// with a live window (a detached long-running task — the whole point of the fork),
// or a just-created one are all left untouched. Any probe failure degrades to
// "reaped nothing" and never throws — reaping must never break the connect.
// See docs/plans/2026/07/24/101-v1-tmux-release/04-terminal-profile.md (step 5).

/** The single remote-exec capability the reaper needs. Same shape as
 * `SSHConnection#exec`, declared locally (not imported) so this module stays a leaf
 * with no `ssh2`/`ssh` coupling — matching `tmuxBootstrap`/`terminalProvider`. No
 * exit code is surfaced; tmux status is read from stdout/stderr or a rejection. */
export type RemoteExec = (command: string) => Promise<{ stdout: string; stderr: string }>;

/** Epoch-seconds clock, injected so reap decisions are deterministic in tests and
 * this module never calls `Date.now()` inline (CLAUDE.md — a clock for reaping). */
export type Clock = () => number;

/** The narrow slice of `Log` this module uses (ISP): one info line on a non-empty
 * reap, trace for the never-break-the-connect failure paths. */
export interface TmuxLog {
    info(message: string): void;
    trace(message: string): void;
}

/** Collaborators + config for a `SessionReaper`. */
export interface SessionReaperDeps {
    readonly exec: RemoteExec;
    readonly now: Clock;
    readonly log: TmuxLog;
    /** Never reap a session younger than this many seconds — guards a session that
     * is momentarily empty mid-startup from being killed. Defaults to
     * `DEFAULT_REAP_GRACE_SECONDS`; an un-reaped young corpse is simply cleared on
     * the next connect/refresh (deterministic naming means it is never duplicated). */
    readonly minAgeSeconds?: number;
}

/** Default startup grace: an empty owned session must be at least this old before
 * the reaper touches it. Small — our sessions only sit at 0 windows once truly
 * dead — but non-zero to survive a create/list race. */
export const DEFAULT_REAP_GRACE_SECONDS = 10;

/**
 * Kills the empty, detached sessions this extension owns. One public operation,
 * `reap()`, run at connect and on manual refresh.
 */
export class SessionReaper {
    private readonly exec: RemoteExec;
    private readonly now: Clock;
    private readonly log: TmuxLog;
    private readonly minAgeSeconds: number;

    constructor(deps: SessionReaperDeps) {
        this.exec = deps.exec;
        this.now = deps.now;
        this.log = deps.log;
        this.minAgeSeconds = deps.minAgeSeconds ?? DEFAULT_REAP_GRACE_SECONDS;
    }

    /**
     * List -> parse -> decide -> kill. Returns the number of sessions reaped (0 when
     * the list probe fails or nothing qualifies). Never throws: a failed
     * `list-sessions` yields 0 and a trace line; a failed `kill-session` is traced
     * and skipped so one dead target can't abort the rest (nor retry — no kill
     * storm). Logs a single info line only when it actually reaped something
     * (invisible UX — silence otherwise).
     */
    async reap(): Promise<number> {
        const sessions = await this.listSessions();
        if (sessions === undefined) {
            return 0; // list probe failed — already traced; never break the connect
        }

        const now = this.now();
        const doomed = sessions.filter(session => shouldReap(session, now, { minAgeSeconds: this.minAgeSeconds }));

        let reaped = 0;
        for (const session of doomed) {
            if (await this.kill(session.name)) {
                reaped++;
            }
        }

        if (reaped > 0) {
            this.log.info(`tmux reaper: reaped ${reaped} empty session(s)`);
        }
        return reaped;
    }

    /** Snapshot the remote's sessions, or `undefined` if the probe itself failed
     * (distinct from "zero sessions", which is a normal empty array). */
    private async listSessions(): Promise<TmuxSession[] | undefined> {
        try {
            const { stdout } = await this.exec(buildListSessions());
            return parseListSessions(stdout);
        } catch (err) {
            this.log.trace(`tmux reaper: list-sessions failed: ${errorText(err)}`);
            return undefined;
        }
    }

    /** Kill one session; true iff the command was delivered. A rejection (dead
     * channel) is traced and swallowed so the remaining reaps still run. */
    private async kill(name: string): Promise<boolean> {
        try {
            await this.exec(buildKillSession(name));
            return true;
        } catch (err) {
            this.log.trace(`tmux reaper: kill-session ${name} failed: ${errorText(err)}`);
            return false;
        }
    }
}

/** Best-effort message from an unknown thrown value (for trace logs only). */
function errorText(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}
