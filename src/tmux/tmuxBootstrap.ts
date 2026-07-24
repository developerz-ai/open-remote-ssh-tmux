// Remote capability gate — decides, per connection, whether tmux-backed terminals
// are available: a Unix remote with a tmux binary new enough for the options the
// session model builds (`tmuxSession.ts`). When unavailable the terminal layer
// stays off and the connection behaves exactly like upstream open-remote-ssh — a
// hard requirement: tmux is Unix-only and must never break the base SSH connect.
//
// Dependency-inverted (D in SOLID): `probeTmux` takes an `exec` function rather
// than an `SSHConnection`/`ssh2` handle, so the whole decision is pure and unit-
// testable. It is also side-effect-free by design — no logging here; the caller
// (the resolver wiring) logs one line from `reason`, keeping this module a leaf.
// See docs/plans/2026/07/24/101-v1-tmux-release/03-remote-bootstrap.md.

/** The single remote-exec capability the probe needs. Matches the shape of
 * `SSHConnection#exec` (whose extra optional params are compatible), but named as
 * its own abstraction so this module never imports `ssh2`/`ssh`. */
export type TmuxExec = (command: string) => Promise<{ stdout: string; stderr: string }>;

/** Why tmux terminals are unavailable, when they are. Absent when available. */
export type TmuxUnavailableReason = 'windows' | 'not-installed' | 'too-old';

/** The capability decision for one remote. */
export interface TmuxCapability {
    /** True iff a usable tmux is present (≥ floor, or an exotic build we won't punish). */
    readonly available: boolean;
    /** Reported tmux version token (e.g. `3.2a`) when a numeric version was parsed. */
    readonly version?: string;
    /** Why tmux is unavailable. Absent when `available` is true. */
    readonly reason?: TmuxUnavailableReason;
}

/** Exact remote command: resolve the binary, then print its version. If tmux is
 * absent, `command -v tmux` exits non-zero and `&&` short-circuits, so no version
 * line is printed — that absence is how we detect "not installed" (the real
 * `SSHConnection#exec` surfaces no exit code, so detection is by parsed stdout). */
const PROBE_COMMAND = 'command -v tmux && tmux -V';

/** Minimum tmux the session model's options require. Bumping this is a real
 * compatibility decision — keep it as named constants, not inline magic numbers. */
const FLOOR_MAJOR = 2;
const FLOOR_MINOR = 6;

/**
 * Probe a remote for a usable tmux.
 *
 * Platform gate first: an explicit Windows remote short-circuits to
 * `{available: false, reason: 'windows'}` and `exec` is never called — a
 * `command -v` probe errors noisily on cmd/powershell, and tmux is Unix-only
 * anyway. Only the literal `'windows'` marker (the sole non-Unix value
 * `serverSetup` produces) gates off; an unlabelled/`undefined` platform is a Unix
 * remote and is still probed, so tmux is never silently disabled on Linux/macOS.
 *
 * @param exec dependency-inverted remote command runner.
 * @param platform remote platform as surfaced by `serverSetup` (`'windows'` for a
 *   Windows remote, otherwise a Unix label or `undefined`).
 */
export async function probeTmux(exec: TmuxExec, platform?: string): Promise<TmuxCapability> {
    if (platform === 'windows') {
        return { available: false, reason: 'windows' };
    }

    let stdout: string;
    try {
        ({ stdout } = await exec(PROBE_COMMAND));
    } catch {
        // The probe channel failed — not a tmux problem, but tmux is unusable
        // here. Degrade gracefully (terminals off) rather than break the connect.
        return { available: false, reason: 'not-installed' };
    }

    const version = parseVersionToken(stdout);
    if (version === undefined) {
        return { available: false, reason: 'not-installed' };
    }

    const meetsFloor = versionMeetsFloor(version);
    if (meetsFloor === undefined) {
        // Exotic build (e.g. `tmux master`): can't compare, so don't punish it —
        // assume usable, but report no version since we couldn't parse one.
        return { available: true };
    }
    if (!meetsFloor) {
        return { available: false, version, reason: 'too-old' };
    }
    return { available: true, version };
}

/** Extract the version token `tmux -V` prints (the `<version>` in `tmux <version>`),
 * e.g. `3.2a`. Returns `undefined` when no such line exists (tmux not installed) —
 * the `command -v` path line (`/usr/bin/tmux`) never matches. */
function parseVersionToken(stdout: string): string | undefined {
    return /^tmux (\S+)/m.exec(stdout)?.[1];
}

/** Whether a version token clears the floor. `undefined` when the token has no
 * parseable `major.minor` (an exotic build we choose not to reject). */
function versionMeetsFloor(versionToken: string): boolean | undefined {
    const match = /(\d+)\.(\d+)/.exec(versionToken);
    if (!match) {
        return undefined;
    }
    const major = parseInt(match[1], 10);
    const minor = parseInt(match[2], 10);
    if (major !== FLOOR_MAJOR) {
        return major > FLOOR_MAJOR;
    }
    return minor >= FLOOR_MINOR;
}
