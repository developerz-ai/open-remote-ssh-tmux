import { createHash } from 'crypto';
import { escapeShellArg } from '../common/shellQuote';

// Re-exported for existing callers/tests that import `escapeShellArg` from
// this module — the implementation now lives in `common/shellQuote.ts` so
// `src/ssh/sshConnection.ts` (a lower layer this module must not be imported
// by) can share it without a tmux→ssh dependency inversion.
export { escapeShellArg };

// The session model — pure logic, the heart of the "no zombies" guarantee. It
// owns the session/list/has/kill/new-session command-line builders (and the pure
// reading of their answers, `classifyTmuxFailure`); the only
// other tmux command sites are `tmuxBootstrap.ts`'s PROBE_COMMAND and the
// `shellPath` (probed path, or {@link TMUX_BIN}) in `terminalProvider.ts`. No `vscode`/`ssh2`/`ssh` imports
// so it is fully unit-testable. Every user-influenced string routed into a
// command goes through `escapeShellArg` (these command lines run on the remote
// via a shell; unescaped a hostile workspace path would be arbitrary code
// execution). See docs/idea/tmux-approach.md and docs/plans/.../02-session-model.md.

/** Namespace prefix for the sessions this extension owns. Reaping only ever
 * touches `code-*` sessions; the user's own sessions (e.g. `main`) are untouched. */
export const SESSION_PREFIX = 'code-';

/** Length of the workspace hash embedded in a session name (sha1 hex chars). */
const HASH_LENGTH = 12;

/** Default scrollback (lines) applied per session (`remote.SSH.tmux.historyLimit`). */
const DEFAULT_HISTORY_LIMIT = 50000;

/** Largest scrollback we pass to tmux. tmux itself accepts up to INT_MAX, but every line
 * of every pane is kept in server memory, so a typo like `1e10` must not become a
 * multi-gigabyte buffer; a million lines is far past any real use. */
const MAX_HISTORY_LIMIT = 1_000_000;

/** The tmux binary a command line runs when the probe resolved no absolute path — a bare
 * `tmux` on PATH. Shared with `terminalProvider.ts`'s `shellPath` fallback. */
export const TMUX_BIN = 'tmux';

/** Server user option holding the user's own global `history-limit` while the legacy chain
 * borrows the global for our new pane (see {@link buildAttachOrCreateArgv}). It is left set
 * afterwards on purpose: `set-option -gu @…` on a user option CRASHES the tmux 2.6 server
 * (verified on the rig — every session on it is lost). */
const SAVED_HISTORY_OPTION = '@orst_saved_hl';

/** `escape-time` tmux shipped as its default before 3.5 (500 ms — Esc felt laggy in every
 * TUI) and the value 3.5 made the new default. Ours only replaces the old default. */
const LEGACY_ESCAPE_TIME = '500';
const ESCAPE_TIME = '10';

/**
 * Coerce `remote.SSH.tmux.historyLimit` into a value tmux accepts. tmux rejects a
 * fractional, negative or out-of-range `history-limit`, and that error aborted the whole
 * `;` chain before `new-session` — no terminal could open at all (reproduced on tmux 2.6 …
 * 3.8 with 1.5, -1 and 1e10). Integers are capped at {@link MAX_HISTORY_LIMIT}; anything
 * else that is not a non-negative integer (NaN, Infinity, a string from a hand-edited
 * settings.json) falls back to the default.
 */
export function clampHistoryLimit(value: unknown): number {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
        return DEFAULT_HISTORY_LIMIT;
    }
    return Math.min(value, MAX_HISTORY_LIMIT);
}

/** The behaviour differences between tmux releases that the attach chain has to know
 * about. Everything else it uses was verified to behave the same on 2.6 (the floor),
 * 3.0a, 3.4, 3.5a and 3.8 by the real-tmux rig (`test/rig`). */
export interface TmuxFeatures {
    /** tmux ≥ 3.7 applies a changed `history-limit` to existing panes ("When
     * history-limit is changed, apply to existing panes", CHANGES 3.7; verified 3.5a no,
     * 3.8 yes). There a session-scoped value reaches our pane — and, conversely, touching
     * the GLOBAL would resize every pane on the user's server. */
    readonly liveHistoryLimit: boolean;
}

/**
 * Feature table for a probed tmux version token (`3.4`, `3.0a`, `next-3.7`). An
 * unparseable or missing version (an exotic `tmux master` build) is treated as modern:
 * the modern chain never touches the user's global, so on an old tmux the worst case is
 * our scrollback setting not applying — never a changed server.
 */
export function tmuxFeatures(version: string | undefined): TmuxFeatures {
    const match = version === undefined ? null : /(\d+)\.(\d+)/.exec(version);
    if (!match) {
        return { liveHistoryLimit: true };
    }
    const major = parseInt(match[1], 10);
    const minor = parseInt(match[2], 10);
    return { liveHistoryLimit: major > 3 || (major === 3 && minor >= 7) };
}

/** Session name shape this extension produces and is allowed to reap:
 * `code-<sha1_12>-<slot>`. Hex + digits only — no `.`/`:` (both forbidden by
 * tmux in session names). Matching this, not a bare `code-` prefix, keeps the
 * reaper conservative: a foreign `code`, `codex-x`, or `code-notes` is ignored.
 *
 * The hash length is pinned to exactly {@link HASH_LENGTH} and the slot may not carry
 * leading zeros, so this admits only names this extension could actually have MINTED.
 * A loose `[0-9a-f]+-\d+` also matched `code-a-0` and `code-<hash>-007` — shapes we
 * never produce, i.e. someone else's sessions — and this regex is the reaper's kill
 * permit (`shouldReap`). Erring wide there means killing a stranger's session; erring
 * narrow means leaving one corpse for the next connect. Only one of those is recoverable. */
const OWNED_SESSION_RE = new RegExp(`^${SESSION_PREFIX}[0-9a-f]{${HASH_LENGTH}}-(?:0|[1-9]\\d*)$`);

/**
 * The `if-shell -F` predicate guarding the PageUp/PageDown bindings below: expands to
 * `1` when the pane's application must receive the key untouched, `0` when the pane is
 * a bare shell prompt — the one situation where the key can only mean "scroll".
 *
 * Two arms, and both are load-bearing (each verified against a real tmux 3.4 server):
 *  - `alternate_on` — vim/htop/a pager draws on the alternate screen, which has no
 *    scrollback to page into. Note `seq 1 500 | less` reports
 *    `pane_current_command=bash` (tmux names the pipeline's leader), so this arm, not
 *    the command test, is what saves a piped pager;
 *  - `#{m:*sh,#{pane_current_command}}` — a foreground command that is NOT a shell is a
 *    TUI on the NORMAL screen, which is exactly how Claude Code runs (`claude`, or
 *    `node` when installed through npm). Gating on `alternate_on` alone would steal
 *    PageUp from it. Nearly every shell name ends in `sh` (bash/zsh/fish/dash/ksh/tcsh),
 *    so the glob is the whole test; an exotic shell (`nu`, `xonsh`) simply keeps its keys.
 */
const PASS_KEYS_THROUGH = '#{?alternate_on,1,#{?#{m:*sh,#{pane_current_command}},0,1}}';

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
    /** Emit `-D`, which alongside `-A` makes tmux behave like `attach-session -d`: evict
     * whatever client is already attached, then attach this one. Set ONLY when reclaiming
     * a slot this client owns whose pty VS Code kept alive past the window close (its
     * reconnection grace is 3h by default), never for a session another machine holds —
     * see `slotState.ts` for the ownership rule that gates it. Verified on a real tmux
     * 3.4 server: the stale client is dropped and the pane's process is untouched.
     * Default false. */
    readonly takeOver?: boolean;
    /** Scrollback lines for the session's pane. Clamped by {@link clampHistoryLimit};
     * default 50000. */
    readonly historyLimit?: number;
    /** The tmux binary the pty launches (the probe's absolute path). The chain's own shell
     * jobs run it too, so they talk to the same build. Default {@link TMUX_BIN}. */
    readonly tmuxPath?: string;
    /** The probed tmux version; selects the chain variant via {@link tmuxFeatures}.
     * Unknown → the modern chain. */
    readonly tmuxVersion?: string;
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
    if (!/^\d+$/.test(suffix)) {
        return undefined;
    }
    const slot = parseInt(suffix, 10);
    // Enforce the round trip the doc comment promises, rather than trusting `\d+`.
    // `parseInt` is lossy in two ways that both break `name === sessionName(…, slot)`:
    // a zero-padded `007` decodes to 7, and a suffix past 2^53 (`9999…`) rounds to a
    // value that is still `Number.isInteger`, so it would sail straight through
    // `sessionName`. Either way the caller re-derives a DIFFERENT name from the slot —
    // `TmuxTerminalProvider` does exactly that when it adopts a remote session or claims
    // a restore — and attaches a brand-new empty session while the real one is left on
    // the remote with nothing pointing at it. That is the zombie this fork exists to
    // prevent, so a name we could not have minted is simply not ours.
    return String(slot) === suffix ? slot : undefined;
}

/** True iff the name matches the `code-<hash>-<slot>` namespace this extension owns. */
export function isOurSession(name: string): boolean {
    return OWNED_SESSION_RE.test(name);
}

/**
 * `cwd` as tmux must receive it to land in exactly that directory. Two parts of tmux read
 * an argv element even though no shell does (both verified on 2.6 … 3.8 by the rig):
 *  - `new-session -c` is FORMAT-EXPANDED: a directory named `x#(touch $HOME/pwned)` ran
 *    that command, and `x#S` became the session name. `##` is tmux's literal `#`.
 *  - an element ending in `;` is a command separator: `x;` was split off and the shell
 *    started in $HOME. `\;` is the literal; tmux drops just that one backslash, so a path
 *    already ending in `\;` becomes `\\;` and survives too.
 */
function tmuxLiteralPath(path: string): string {
    const escaped = path.replace(/#/g, '##');
    return escaped.endsWith(';') ? `${escaped.slice(0, -1)}\\;` : escaped;
}

/** The tmux binary as a word inside a tmux shell job (`run-shell` / `if-shell`): shell-quoted,
 * and with `#` doubled because tmux format-expands the job's command before the shell sees it. */
function jobTmux(tmuxPath: string): string {
    return escapeShellArg(tmuxPath).replace(/#/g, '##');
}

/** `if-shell` test that succeeds when the user's server already has `key` bound in the root
 * table — by them, or by an earlier attach of ours. `list-keys -T root <key>` does not exist
 * at 2.6, hence the grep; the line shape `… -T root <key> …` is the same on 2.6 … 3.8. */
function rootKeyBound(tmux: string, key: string): string {
    return `${tmux} list-keys -T root | grep -Eq -- '-T root +${key} '`;
}

/**
 * The argv form for attach-or-create — the array a VS Code terminal profile
 * carries as `shellArgs` (with `shellPath` the probed tmux). The pty host hands argv to
 * `execve` **directly, with no intervening shell**, so elements are not shell-escaped and
 * the tmux command separator is a bare `;` element. tmux itself still interprets parts of
 * it (formats in `-c` and in shell jobs, a trailing `;`), which {@link tmuxLiteralPath}
 * and {@link jobTmux} neutralise.
 *
 * Every write here is either scoped to OUR session (`-t =<name>:`) or applied only while
 * the user's server still holds tmux's default, so a setting the user configured is never
 * overwritten. The one global we borrow, `history-limit` on tmux < 3.7, is put back to
 * the user's exact value before anything that can fail.
 */
export function buildAttachOrCreateArgv(
    name: string,
    cwd: string,
    shell?: string,
    opts: AttachOrCreateOptions = {},
): string[] {
    const historyLimit = String(clampHistoryLimit(opts.historyLimit ?? DEFAULT_HISTORY_LIMIT));
    const tmux = jobTmux(opts.tmuxPath ?? TMUX_BIN);
    // `-D` must sit with the other `new-session` flags, before `-s`: it is a flag of the
    // attach behaviour `-A` selects, not a standalone command.
    const create = opts.takeOver
        ? ['new-session', '-A', '-D', '-s', name, '-c', tmuxLiteralPath(cwd)]
        : ['new-session', '-A', '-s', name, '-c', tmuxLiteralPath(cwd)];
    if (shell !== undefined) {
        create.push(shell);
    }
    // Before 3.7, `history-limit` is read only when a PANE is created, and `new-session`
    // creates the session's one pane before any chained command runs, so a session-scoped
    // value set afterwards never reached it (pane stayed at 2000 while `show-options` said
    // 50000). The global is the only lever there: save the user's value, set ours, create,
    // put theirs back. The save is a shell job reading `show-options -gv`, because a
    // `#{history-limit}` format resolves through the most recent session and would pick up a
    // session-local value as if it were the global (verified on the rig). The old restore,
    // `set-option -gu`, reset the global to tmux's built-in 2000 instead of the user's value.
    // `run-shell` blocks the chain until the job is done, and nothing between the save and
    // the restore yields, so a concurrent attach cannot observe our value.
    const borrowGlobal = !tmuxFeatures(opts.tmuxVersion).liveHistoryLimit;
    const head = borrowGlobal
        ? [
            'run-shell', `${tmux} set-option -g ${SAVED_HISTORY_OPTION} "$(${tmux} show-options -gv history-limit)"`,
            ';', 'set-option', '-g', 'history-limit', historyLimit,
            ';', ...create,
            ';', 'set-option', '-gF', 'history-limit', `#{${SAVED_HISTORY_OPTION}}`,
        ]
        : create;
    // `set-option`'s `-t` is target-WINDOW syntax (unlike `set-window-option`'s,
    // which accepts a bare `=<name>` exact-match session target fine): confirmed
    // against a real tmux 3.4 server that a bare `=<name>` there is NOT resolved
    // as "exact-match session, default window" and fails with "no such session"
    // — `status`/`history-limit` silently never applied. `=<name>:` (trailing colon =
    // exact session, empty/default window) is the form `set-option` actually accepts.
    const session = `=${name}:`;
    return [
        ...head,
        ';', 'set-window-option', '-t', `=${name}`, 'remain-on-exit', 'off',
        ';', 'set-option', '-t', session, 'status', 'off',
        // On ≥ 3.7 this is what sizes the pane; before that it only covers windows created
        // later, and is harmless.
        ';', 'set-option', '-t', session, 'history-limit', historyLimit,
        // Invisible UX, not a nicety: tmux defaults `mouse` to off, which leaves mouse
        // reporting disabled, so the scroll wheel emits arrow keys straight into the
        // shell — the wheel "scrolls commands" (bash history) instead of the screen.
        // Trade-off (accepted deliberately): with mouse reporting on, drag-selection
        // belongs to tmux rather than VS Code — hence `set-clipboard` below. Alt+drag
        // remains the escape hatch to VS Code's own selection.
        ';', 'set-option', '-t', session, 'mouse', 'on',
        // No tmux prefix in our sessions: C-b was swallowed as tmux's prefix on every
        // version (Claude Code uses it), and a prefix is tmux UI the user never asked for.
        // Session-scoped, so the user's own sessions keep theirs. `None` verified at 2.6.
        ';', 'set-option', '-t', session, 'prefix', 'None',
        ';', 'set-option', '-t', session, 'prefix2', 'None',
        // A lone Esc is held for `escape-time` to tell it from an Alt- sequence: 500 ms by
        // default before 3.5, which makes Esc lag in every TUI. It is a SERVER option, so
        // lower it only while it still holds that old default — a value the user chose
        // stays. (3.5+ defaults to 10 already, so this is a no-op there.)
        ';', 'if-shell', '-F', `#{==:#{escape-time},${LEGACY_ESCAPE_TIME}}`, `set-option -s escape-time ${ESCAPE_TIME}`,
        // Makes tmux emit OSC52 on copy, so a drag-select inside the remote tmux reaches
        // the LOCAL clipboard over the SSH link; tmux's default `external` forwards OSC52
        // only for apps running *inside* tmux, never for tmux's own copy-mode. Without
        // this, `mouse on` above would trade a broken wheel for broken copy/paste.
        // `set-clipboard` is a SERVER option (a session-targeted write is silently promoted
        // — verified on 3.4), so it is changed only from tmux's default: a user who set
        // `off` keeps it. (An explicit `external` is indistinguishable from the default.)
        ';', 'if-shell', '-F', '#{==:#{set-clipboard},external}', 'set-option -s set-clipboard on',
        // The keyboard half of the same Invisible-UX problem `mouse on` fixes for the
        // wheel. tmux binds nothing to PageUp in the root table, so the key reaches the
        // shell as bytes — and readline's stock `/etc/inputrc` (plus most zsh setups)
        // maps it to history-search-backward, so PageUp "scrolls" to the COMMAND above
        // instead of the screen. `copy-mode -u` enters copy mode already paged up one
        // screen; `-e` makes it exit by itself once PageDown reaches the bottom.
        //
        // The inner `if-shell -F` is a format test (no shell per keypress) against
        // `PASS_KEYS_THROUGH`: the binding takes the key ONLY at a bare shell prompt, so
        // vim/less/htop and normal-screen TUIs like Claude Code keep their own keys.
        // PageDown deliberately has no else-branch: outside copy mode there is nothing
        // below the live screen.
        //
        // Key tables are SERVER-global (tmux has no per-session bindings), so each key is
        // bound only when the root table has nothing on it yet: a user's own PageUp binding
        // wins, and so does ours from an earlier attach. That test needs a shell job (no
        // format can see bindings): one short `list-keys | grep` per key, per attach. The
        // then-branch is empty — "already bound, leave it".
        ';', 'if-shell', rootKeyBound(tmux, 'PPage'), '',
        `bind-key -n PPage if-shell -F '${PASS_KEYS_THROUGH}' 'send-keys PPage' 'copy-mode -eu'`,
        ';', 'if-shell', rootKeyBound(tmux, 'NPage'), '',
        `bind-key -n NPage if-shell -F '${PASS_KEYS_THROUGH}' 'send-keys NPage'`,
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
export function buildListSessions(tmuxPath = TMUX_BIN): string {
    return `${escapeShellArg(tmuxPath)} list-sessions -F `
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
export function buildHasSession(name: string, tmuxPath = TMUX_BIN): string {
    return `${escapeShellArg(tmuxPath)} has-session -t =${escapeShellArg(name)}`;
}

/** `tmux kill-session -t =<name>`. */
export function buildKillSession(name: string, tmuxPath = TMUX_BIN): string {
    return `${escapeShellArg(tmuxPath)} kill-session -t =${escapeShellArg(name)}`;
}

/** Tag on each answer line of {@link buildHasSessionsCommand}. */
const HAS_TAG = '__has';

/**
 * One remote round-trip that asks `has-session` for every name — reconcile used to pay one
 * sequential round-trip per mapped slot (~400 ms each in the field). Each name is probed
 * with {@link buildHasSession} (exact `=name` target, escaped), its output captured, and its
 * exit status and message printed on one line tagged with the name's INDEX, so the answer
 * never depends on echoing a name back. Joined with `; ` rather than newlines: the whole
 * line travels inside a single-quoted `sh -c` argument, and a csh login shell rejects a
 * newline inside quotes. Parse with {@link parseHasSessions}.
 */
export function buildHasSessionsCommand(names: readonly string[], tmuxPath = TMUX_BIN): string {
    return names
        .map((name, index) => `r=$(${buildHasSession(name, tmuxPath)} 2>&1); printf '${HAS_TAG} %s %s %s\\n' ${index} "$?" "$r"`)
        .join('; ');
}

/** One name's answer from {@link buildHasSessionsCommand}: tmux's exit status (`undefined`
 * when no line came back for it) and its first line of output (empty on success). */
export interface HasSessionAnswer {
    readonly code: number | undefined;
    readonly message: string;
}

/** Read {@link buildHasSessionsCommand} output back into one answer per name, in the order
 * the names were given. Untagged lines (login banners, a multi-line error's tail) and
 * out-of-range indexes are ignored; a name with no line reads as `code: undefined`. */
export function parseHasSessions(stdout: string, count: number): HasSessionAnswer[] {
    const answers: HasSessionAnswer[] = Array.from({ length: count }, () => ({ code: undefined, message: '' }));
    const lineRe = new RegExp(`^${HAS_TAG} (\\d+) (\\d+) ?(.*)$`);
    for (const line of stdout.split('\n')) {
        const match = lineRe.exec(line);
        if (!match) {
            continue;
        }
        const index = parseInt(match[1], 10);
        if (index < count) {
            answers[index] = { code: parseInt(match[2], 10), message: match[3].trim() };
        }
    }
    return answers;
}

/** What one tmux targeting command's outcome says about its session. Only `absent` is
 * proof the session is gone; `unreachable` (could not ask / unexplained failure) and
 * `incompatible` (client and server tmux disagree) say nothing about it. */
export type TmuxTargetVerdict = 'present' | 'absent' | 'unreachable' | 'incompatible';

/** tmux's "that session / that server is not there" messages. `error connecting … (No such
 * file or directory)` is how tmux 3.4 reports a missing socket (verified) — no server, so
 * nothing to find — and `Connection refused` a dead server's stale socket. Any other
 * `error connecting` (e.g. `Permission denied`) is a reachability problem, not absence. */
const ABSENT_RE = /can't find session|session not found|no server running|error connecting to .*\((?:No such file or directory|Connection refused)\)/;

/** A client/server protocol skew (the tmux binary was upgraded under a running server). */
const INCOMPATIBLE_RE = /protocol version mismatch/;

/**
 * Classify a tmux targeting command (`has-session`, `kill-session`) by exit status and
 * message. Pure. Errs towards `unreachable`: a missing exit status, an empty message, or
 * an unrecognised error (tmux not on PATH, a shell error) never reads as `absent`, because
 * `absent` is what licenses dropping a mapping — dropping one wrongly strands a live session.
 */
export function classifyTmuxFailure(stderr: string, code: number | undefined): TmuxTargetVerdict {
    if (code === undefined) {
        return 'unreachable';
    }
    if (code === 0) {
        return 'present';
    }
    if (ABSENT_RE.test(stderr)) {
        return 'absent';
    }
    if (INCOMPATIBLE_RE.test(stderr)) {
        return 'incompatible';
    }
    return 'unreachable';
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
 * Read a `buildListSessions` run by its exit status: the sessions when tmux answered (exit 0,
 * or a "no server running" style failure — no server simply means no sessions), `undefined`
 * when the list could not be read at all. Callers must keep the two apart: treating "could
 * not list" as "zero sessions" clears the no-steal guard and hides a dead link.
 */
export function readListSessionsResult(result: {
    readonly stdout: string;
    readonly stderr: string;
    readonly code: number | undefined;
}): TmuxSession[] | undefined {
    if (result.code === 0 || classifyTmuxFailure(result.stderr, result.code) === 'absent') {
        return parseListSessions(result.stdout);
    }
    return undefined;
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
