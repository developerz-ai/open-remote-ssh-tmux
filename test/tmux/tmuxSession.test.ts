import { describe, expect, it } from 'vitest';
import {
    buildAttachOrCreateArgv,
    buildHasSession,
    buildKillSession,
    buildListSessions,
    escapeShellArg,
    isOurSession,
    parseListSessions,
    sessionName,
    sessionSlot,
    shouldReap,
} from '../../src/tmux/tmuxSession';

// The session model is the ONLY place tmux command lines are built, and the
// heart of the "no zombies" guarantee. These are pure functions: deterministic
// naming, POSIX-safe escaping, exact command strings, tolerant parsing, and a
// conservative reap decision with the clock injected. No `vscode`/`ssh2`/`ssh`
// imports — so the whole contract is unit-testable here.

// sha1-12 of `host + ' ' + workspacePath`, computed once and pinned so the name
// is proven stable across machines/runs (not just self-consistent).
const HASH_PROJ = '92fc6cc41565';   // 'example.com /home/user/proj'
const HASH_OTHER_WS = '447f5fdaae19'; // 'example.com /home/user/other'
const HASH_OTHER_HOST = 'b1014c3573f1'; // 'other.com /home/user/proj'

describe('sessionName', () => {
    it('derives code-<sha1_12>-<slot> from host + workspace + slot', () => {
        expect(sessionName('example.com', '/home/user/proj', 0)).toBe(`code-${HASH_PROJ}-0`);
    });

    it('is deterministic — same inputs always produce the same name', () => {
        expect(sessionName('example.com', '/home/user/proj', 3))
            .toBe(sessionName('example.com', '/home/user/proj', 3));
    });

    it('differs across workspaces, hosts, and slots', () => {
        expect(sessionName('example.com', '/home/user/other', 0)).toBe(`code-${HASH_OTHER_WS}-0`);
        expect(sessionName('other.com', '/home/user/proj', 0)).toBe(`code-${HASH_OTHER_HOST}-0`);
        expect(sessionName('example.com', '/home/user/proj', 1)).toBe(`code-${HASH_PROJ}-1`);
    });

    it('matches ^code-[a-z0-9]+-\\d+$ with no tmux-forbidden . or : characters', () => {
        for (const slot of [0, 1, 7, 42]) {
            const name = sessionName('example.com', '/home/user/proj', slot);
            expect(name).toMatch(/^code-[a-z0-9]+-\d+$/);
            expect(name).not.toContain('.');
            expect(name).not.toContain(':');
        }
    });

    it('rejects a non-integer or negative slot (protects the naming invariant)', () => {
        expect(() => sessionName('example.com', '/home/user/proj', -1)).toThrow();
        expect(() => sessionName('example.com', '/home/user/proj', 1.5)).toThrow();
    });
});

describe('escapeShellArg', () => {
    it('wraps a plain word in single quotes', () => {
        expect(escapeShellArg('abc')).toBe(`'abc'`);
    });

    it('closes/escapes/reopens an embedded single quote (POSIX \'\\\'\')', () => {
        expect(escapeShellArg(`a'b`)).toBe(`'a'\\''b'`);
    });

    it('keeps spaces as one word', () => {
        expect(escapeShellArg('a b')).toBe(`'a b'`);
    });

    it('neutralises $ so the shell cannot expand it', () => {
        expect(escapeShellArg('$HOME')).toBe(`'$HOME'`);
    });

    it('neutralises backticks (command substitution)', () => {
        expect(escapeShellArg('`id`')).toBe(`'\`id\`'`);
    });

    it('keeps a newline literal inside the quotes', () => {
        expect(escapeShellArg('a\nb')).toBe(`'a\nb'`);
    });

    it('neutralises a command separator', () => {
        expect(escapeShellArg('a;b')).toBe(`'a;b'`);
    });

    it('preserves UTF-8 bytes verbatim', () => {
        expect(escapeShellArg('café ☕')).toBe(`'café ☕'`);
    });
});

describe('buildListSessions', () => {
    it('uses a stable -F format — never parses human output', () => {
        // `#{pane_dead}` (of the session's active pane) is the corpse signal the reaper
        // gates on: a session whose process exited but lingers under `remain-on-exit`.
        // `#{session_windows}` alone can never be 0 for a live session, so it is not it.
        expect(buildListSessions()).toBe(
            'tmux list-sessions -F '
            + `'#{session_name} #{session_attached} #{session_windows} #{session_created} #{pane_dead}'`,
        );
    });
});

describe('buildHasSession / buildKillSession', () => {
    it('targets the escaped session name with an exact-match (=) prefix', () => {
        // `-t <name>` is prefix/fuzzy match in tmux: `has-session -t code-<h>-0`
        // would match `code-<h>-01`, and `kill-session` would kill the wrong live
        // session. `=` forces an exact match. The `=` sits outside the quotes so the
        // shell concatenates it onto the (still fully escaped) name.
        expect(buildHasSession(`code-${HASH_PROJ}-0`)).toBe(`tmux has-session -t ='code-${HASH_PROJ}-0'`);
        expect(buildKillSession(`code-${HASH_PROJ}-0`)).toBe(`tmux kill-session -t ='code-${HASH_PROJ}-0'`);
    });
});

describe('buildAttachOrCreateArgv', () => {
    // The argv form is what a VS Code terminal profile's `shellArgs` carries
    // (shellPath 'tmux'). The pty host hands it to execve directly — NO shell —
    // so there is no quoting and no injection surface; the tmux command separator
    // is a bare `;` element (the shell form writes `\;` only to survive the shell).
    const NAME = `code-${HASH_PROJ}-0`;

    // The `if-shell -F` predicate guarding the PageUp/PageDown bindings: 1 = the pane's
    // application keeps the key, 0 = it means "scroll" and is ours. Pinned here as a
    // literal (not imported) so a change to the builder's format string has to be made
    // deliberately in both places. Every arm verified against a real tmux 3.4 server:
    // bash prompt → 0; `node` in the foreground → 1; `seq 1 500 | less` → 1 through the
    // alternate-screen arm, because a piped pager still reports
    // `pane_current_command=bash` — which is why the command test extends the
    // `alternate_on` test rather than replacing it.
    const PASS_THROUGH = '#{?alternate_on,1,#{?#{m:*sh,#{pane_current_command}},0,1}}';

    it('emits attach-or-create argv with per-session hardening/cosmetics', () => {
        // `-s` names the NEW session (exact by construction); `set-window-option`'s
        // `-t` is target-session and accepts bare `=<name>`. `set-option`'s `-t` is
        // target-WINDOW syntax (confirmed against real tmux 3.4): a bare `=<name>`
        // there is NOT recognised as exact-match-session-default-window and fails
        // silently with "no such session" — status/history-limit never applied
        // (status bar leaked, a hard Invisible-UX violation). The trailing `:`
        // (`=<name>:`) is required to get exact-match session + default window.
        expect(buildAttachOrCreateArgv(NAME, '/home/user/proj')).toEqual([
            'set-option', '-g', 'history-limit', '50000',
            ';', 'new-session', '-A', '-s', NAME, '-c', '/home/user/proj',
            ';', 'set-option', '-gu', 'history-limit',
            ';', 'set-window-option', '-t', `=${NAME}`, 'remain-on-exit', 'off',
            ';', 'set-option', '-t', `=${NAME}:`, 'status', 'off',
            ';', 'set-option', '-t', `=${NAME}:`, 'history-limit', '50000',
            ';', 'set-option', '-t', `=${NAME}:`, 'mouse', 'on',
            ';', 'set-option', '-s', 'set-clipboard', 'on',
            ';', 'bind-key', '-n', 'PPage', 'if-shell', '-F', PASS_THROUGH,
            'send-keys PPage', 'copy-mode -eu',
            ';', 'bind-key', '-n', 'NPage', 'if-shell', '-F', PASS_THROUGH,
            'send-keys NPage',
        ]);
    });

    // Same class of bug as the scroll wheel: with no root-table binding, PageUp is
    // just bytes for the shell, and a stock `/etc/inputrc` (and most zsh setups) maps
    // it to history-search-backward — so PageUp "scrolls" the COMMAND above instead of
    // the screen, and the 50000-line scrollback is again reachable only through tmux's
    // own `prefix + [`. Binding PageUp to `copy-mode -u` makes the key do what every
    // terminal user means by it. `-e` (exit-on-bottom) is what makes PageDown's other
    // half work: paging back down to the last line leaves copy mode on its own, so the
    // user never has to know they were in a tmux mode at all.
    it('binds PageUp to copy-mode so it scrolls the screen, not shell history', () => {
        const argv = buildAttachOrCreateArgv(NAME, '/home/user/proj');
        const at = argv.indexOf('PPage');
        expect(at, 'PageUp unbound — it would run history-search-backward').toBeGreaterThan(-1);
        expect(argv.slice(at - 3, at)).toEqual([';', 'bind-key', '-n']);
        expect(argv[argv.length - 1 - argv.slice().reverse().indexOf('copy-mode -eu')])
            .toBe('copy-mode -eu');
    });

    // The keys are OURS only at a bare shell prompt — the one place PageUp has no other
    // meaning and readline would run history-search-backward. Everything else keeps them:
    //   - alternate screen on  → vim/htop/a pager owns the keys, and there is no
    //     scrollback to page into anyway;
    //   - foreground command is not a shell → a TUI on the NORMAL screen, which is
    //     exactly how Claude Code (and any other Ink/React app) runs. Gating on
    //     `alternate_on` alone would steal PageUp from it.
    // `-F` is a format test, so no shell is spawned per keypress.
    it('takes the keys only at a shell prompt — a normal-screen TUI keeps them', () => {
        const argv = buildAttachOrCreateArgv(NAME, '/home/user/proj');
        for (const [key, send] of [['PPage', 'send-keys PPage'], ['NPage', 'send-keys NPage']]) {
            const at = argv.indexOf(key);
            expect(argv.slice(at + 1, at + 5)).toEqual(['if-shell', '-F', PASS_THROUGH, send]);
        }
    });

    // PageDown gets no else-branch on purpose. In copy mode tmux's own copy-mode table
    // already pages down (and `-e` drops out at the bottom), so the root binding is only
    // consulted when the pane is NOT in a mode — where there is nothing below the live
    // screen to scroll to and the only thing the key could do is the history-search-forward
    // this whole binding exists to stop. `if-shell` with no else command is the no-op.
    it('swallows PageDown at a shell prompt instead of recalling the next command', () => {
        const argv = buildAttachOrCreateArgv(NAME, '/home/user/proj');
        const at = argv.indexOf('NPage');
        expect(argv.slice(at + 1)).toEqual(['if-shell', '-F', PASS_THROUGH, 'send-keys NPage']);
    });

    // The key table is server-global — tmux has no per-session bindings — so these two
    // MUST come after the `-gu` restore, like every other fallible command in the chain.
    it('binds keys only after the global history-limit has been restored', () => {
        const argv = buildAttachOrCreateArgv(NAME, '/home/user/proj');
        expect(argv.indexOf('bind-key')).toBeGreaterThan(argv.indexOf('-gu'));
    });

    // THE BUG THIS ORDERING EXISTS FOR. `history-limit` is consumed when a PANE is
    // created, not when the option is set — and `new-session` has already created the
    // session's one and only pane before any chained `set-option` runs. So the old form
    // (set the option at session scope after new-session) left every terminal on tmux's
    // 2000-line default while `show-options` cheerfully reported 50000, making the
    // advertised `remote.SSH.tmux.historyLimit` setting a complete no-op. Verified on the
    // live server: `show-options history-limit` = 50000 on all six real sessions, while
    // `display-message '#{history_limit}'` = 2000 on every one of them.
    //
    // The only lever tmux gives is the GLOBAL option, read at pane creation. So set it,
    // create, then immediately restore with `-gu`. Verified end-to-end on real tmux 3.4:
    // new pane = 50000, the user's global back to 2000, pre-existing sessions untouched.
    it('sets the global history-limit BEFORE new-session, since panes read it at creation', () => {
        const argv = buildAttachOrCreateArgv(NAME, '/home/user/proj', undefined, { historyLimit: 12345 });
        expect(argv.slice(0, 4)).toEqual(['set-option', '-g', 'history-limit', '12345']);
        expect(argv.indexOf('new-session')).toBeGreaterThan(argv.indexOf('-g'));
    });

    // The global belongs to the user's whole tmux server, so it must not stay changed.
    // Restoring immediately after `new-session` (and before the cosmetic options) is
    // deliberate: tmux aborts a `;` chain at the first failing command, so anything that
    // can fail must come AFTER the restore or a failure would leak our value.
    it('restores the global with -gu immediately after new-session, before anything fallible', () => {
        const argv = buildAttachOrCreateArgv(NAME, '/home/user/proj');
        const restore = argv.indexOf('-gu');
        expect(restore).toBeGreaterThan(argv.indexOf('new-session'));
        expect(restore).toBeLessThan(argv.indexOf('set-window-option'));
        expect(argv[restore + 1]).toBe('history-limit');
    });

    // Invisible UX: without `mouse on`, tmux leaves mouse reporting off, so the wheel
    // emits arrow keys straight into the shell — scrolling "scrolls commands" (bash
    // history) instead of the screen, and the 50000-line history-limit we configure is
    // reachable ONLY via tmux's own `prefix + [` keybinding. That is a tmux UI the user
    // must never need to know about, so mouse mode is not optional and not a setting.
    it('enables mouse mode so the wheel scrolls scrollback, not shell history', () => {
        const argv = buildAttachOrCreateArgv(NAME, '/home/user/proj');
        const mouse = argv.indexOf('mouse');
        expect(mouse, 'mouse option missing — wheel would cycle shell history').toBeGreaterThan(-1);
        expect(argv[mouse + 1]).toBe('on');
        // Scoped to this session (`-t =<name>:`), never a global `-g` that would
        // reconfigure the user's own tmux sessions on the same server.
        expect(argv.slice(mouse - 4, mouse)).toEqual([';', 'set-option', '-t', `=${NAME}:`]);
    });

    // `set-clipboard on` makes tmux emit OSC52 when text is copied, so a drag-select
    // inside the remote tmux lands in the LOCAL clipboard across the SSH link (tmux's
    // default `external` only forwards OSC52 from apps, never for tmux's own copies).
    // This is what keeps mouse mode from degrading copy/paste: with mouse reporting on,
    // selection belongs to tmux, so tmux has to be the one to reach the clipboard.
    //
    // `-s` (server scope) is deliberate and load-bearing: `set-clipboard` IS a server
    // option, so a session-targeted `-t =<name>:` set is silently promoted to server
    // scope anyway (verified against real tmux 3.4). Writing `-s` makes the real scope
    // legible at the call site instead of hiding a global write behind session syntax.
    it('enables OSC52 clipboard forwarding at its true (server) scope', () => {
        const argv = buildAttachOrCreateArgv(NAME, '/home/user/proj');
        const clip = argv.indexOf('set-clipboard');
        expect(clip).toBeGreaterThan(-1);
        expect(argv[clip + 1]).toBe('on');
        expect(argv.slice(clip - 3, clip)).toEqual([';', 'set-option', '-s']);
    });

    // `takeOver` emits `-D`, which with `-A` makes tmux behave like `attach-session -d`:
    // it evicts whatever client is already on the session before attaching. Verified
    // against a real tmux 3.4 server — the old client's pty disappears from
    // `list-clients`, the new one appears, and the pane's running process is untouched.
    // Used only to reclaim a slot THIS client owns whose pty VS Code kept alive past the
    // window close (the 3h reconnection grace); never to take a session another machine
    // holds. See src/tmux/slotState.ts.
    it('emits -D right after -A when taking a slot back from a stale client', () => {
        const argv = buildAttachOrCreateArgv(NAME, '/home/user/proj', undefined, { takeOver: true });
        const at = argv.indexOf('new-session');
        expect(argv.slice(at, at + 7)).toEqual([
            'new-session', '-A', '-D', '-s', NAME, '-c', '/home/user/proj',
        ]);
    });

    it('omits -D by default so a normal attach never evicts anyone', () => {
        expect(buildAttachOrCreateArgv(NAME, '/home/user/proj')).not.toContain('-D');
        expect(buildAttachOrCreateArgv(NAME, '/home/user/proj', undefined, { takeOver: false })).not.toContain('-D');
    });

    it('keeps the shell argument last when taking over', () => {
        const argv = buildAttachOrCreateArgv(NAME, '/home/user/proj', '/bin/zsh', { takeOver: true });
        const at = argv.indexOf('new-session');
        expect(argv.slice(at, at + 8)).toEqual([
            'new-session', '-A', '-D', '-s', NAME, '-c', '/home/user/proj', '/bin/zsh',
        ]);
    });

    it('carries -A and never destroy-unattached', () => {
        const argv = buildAttachOrCreateArgv(NAME, '/home/user/proj');
        expect(argv).toContain('-A');
        expect(argv).not.toContain('destroy-unattached');
    });

    it('appends the shell command as its own argv element when given', () => {
        const argv = buildAttachOrCreateArgv(NAME, '/home/user/proj', '/bin/zsh');
        const at = argv.indexOf('new-session');
        expect(argv.slice(at, at + 7)).toEqual([
            'new-session', '-A', '-s', NAME, '-c', '/home/user/proj', '/bin/zsh',
        ]);
    });

    it('honours a caller-supplied history limit', () => {
        expect(buildAttachOrCreateArgv(NAME, '/home/user/proj', undefined, { historyLimit: 100000 }))
            .toContain('100000');
    });

    it('needs no escaping — a hostile cwd is one inert argv element (no shell)', () => {
        const hostile = `/tmp/pwn'; rm -rf $HOME'`;
        const argv = buildAttachOrCreateArgv(NAME, hostile);
        // Passed verbatim: no quotes added, no separators split. execve, not a shell.
        expect(argv[argv.indexOf('-c') + 1]).toBe(hostile);
    });
});

describe('sessionSlot', () => {
    it('extracts the slot from one of THIS (host, workspace)\'s session names', () => {
        expect(sessionSlot(sessionName('example.com', '/home/user/proj', 0), 'example.com', '/home/user/proj'))
            .toBe(0);
        expect(sessionSlot(sessionName('example.com', '/home/user/proj', 12), 'example.com', '/home/user/proj'))
            .toBe(12);
    });

    it('rejects another workspace or host (hash mismatch), not a bare code- prefix', () => {
        // Right shape, wrong workspace/host → not ours-this-workspace.
        expect(sessionSlot(`code-${HASH_OTHER_WS}-0`, 'example.com', '/home/user/proj')).toBeUndefined();
        expect(sessionSlot(`code-${HASH_OTHER_HOST}-0`, 'example.com', '/home/user/proj')).toBeUndefined();
    });

    it('rejects foreign and malformed names', () => {
        for (const name of ['main', 'code', `code-${HASH_PROJ}`, `code-${HASH_PROJ}-x`, `code-${HASH_PROJ}-`]) {
            expect(sessionSlot(name, 'example.com', '/home/user/proj')).toBeUndefined();
        }
    });
});

describe('parseListSessions', () => {
    it('parses the happy path into typed sessions', () => {
        const out = 'code-92fc6cc41565-0 1 2 1700000000 0\ncode-92fc6cc41565-1 0 1 1700000100 1';
        expect(parseListSessions(out)).toEqual([
            { name: 'code-92fc6cc41565-0', attached: true, windows: 2, paneDead: false, createdEpoch: 1700000000 },
            { name: 'code-92fc6cc41565-1', attached: false, windows: 1, paneDead: true, createdEpoch: 1700000100 },
        ]);
    });

    it('treats attached as a boolean (client count > 0)', () => {
        expect(parseListSessions('code-x-0 3 1 1700000000 0')[0].attached).toBe(true);
        expect(parseListSessions('code-x-0 0 1 1700000000 0')[0].attached).toBe(false);
    });

    it('treats pane_dead as a boolean corpse flag (1 = dead pane)', () => {
        expect(parseListSessions('code-x-0 0 1 1700000000 1')[0].paneDead).toBe(true);
        expect(parseListSessions('code-x-0 0 1 1700000000 0')[0].paneDead).toBe(false);
    });

    it('returns [] for empty output', () => {
        expect(parseListSessions('')).toEqual([]);
        expect(parseListSessions('   \n  \n')).toEqual([]);
    });

    it('treats "no server running" as zero sessions, not an error', () => {
        expect(parseListSessions('no server running on /tmp/tmux-1000/default')).toEqual([]);
    });

    it('skips garbage lines but keeps valid ones', () => {
        // `foo bar baz qux quux` has five tokens but a non-numeric trailing field, so
        // it fails the numeric guard rather than the field-count one.
        const out = 'garbage-without-numbers\nfoo bar baz qux quux\ncode-x-0 1 1 1700000000 0';
        expect(parseListSessions(out)).toEqual([
            { name: 'code-x-0', attached: true, windows: 1, paneDead: false, createdEpoch: 1700000000 },
        ]);
    });

    it('tolerates a foreign session name containing spaces (parses fields from the right)', () => {
        expect(parseListSessions('my session 1 2 1700000000 0')).toEqual([
            { name: 'my session', attached: true, windows: 2, paneDead: false, createdEpoch: 1700000000 },
        ]);
    });
});

describe('isOurSession', () => {
    it('matches our code-<hash>-<slot> namespace', () => {
        expect(isOurSession(`code-${HASH_PROJ}-0`)).toBe(true);
        expect(isOurSession(`code-${HASH_PROJ}-12`)).toBe(true);
    });

    it('rejects foreign names, including near-misses', () => {
        for (const name of ['main', 'code', 'codex-x', 'code-XYZ-0', 'code-abc', 'vscode-1']) {
            expect(isOurSession(name)).toBe(false);
        }
    });
});

describe('shouldReap', () => {
    // A reapable corpse: OURS, detached, and its pane is dead — the process exited
    // but the session lingers under `remain-on-exit`. `windows` is ≥1 even for a
    // corpse (tmux destroys a zero-window session), so it is never the reap signal;
    // `paneDead` is.
    const corpse = (over: Partial<Parameters<typeof shouldReap>[0]> = {}) => ({
        name: `code-${HASH_PROJ}-0`,
        attached: false,
        windows: 1,
        paneDead: true,
        createdEpoch: 1000,
        ...over,
    });

    it('reaps an ours + detached + dead-pane corpse', () => {
        expect(shouldReap(corpse(), 5000)).toBe(true);
    });

    it('never reaps an attached session, even a dead-pane one (someone is viewing it)', () => {
        expect(shouldReap(corpse({ attached: true }), 5000)).toBe(false);
    });

    it('never reaps a live detached session (a detached Claude Code run must survive)', () => {
        // A non-dead pane is left alone regardless of window count — the point of the fork.
        expect(shouldReap(corpse({ paneDead: false }), 5000)).toBe(false);
        expect(shouldReap(corpse({ paneDead: false, windows: 3 }), 5000)).toBe(false);
    });

    it('never reaps on window count alone — windows === 0 is unreachable, not a signal', () => {
        // tmux destroys a session when its last window closes (`remain-on-exit off`),
        // so a live-pane / zero-window row is a shape real tmux never emits. Guards the
        // old dead predicate (`windows === 0`) from creeping back.
        expect(shouldReap(corpse({ paneDead: false, windows: 0 }), 5000)).toBe(false);
    });

    it('never reaps a foreign session, even a detached dead-pane one', () => {
        const foreign = (name: string) => ({ name, attached: false, windows: 1, paneDead: true, createdEpoch: 1000 });
        expect(shouldReap(foreign('main'), 5000)).toBe(false);
        expect(shouldReap(foreign('code'), 5000)).toBe(false);
        expect(shouldReap(foreign('codex-x'), 5000)).toBe(false);
    });

    it('respects a minimum-age grace window (guards create/list races)', () => {
        expect(shouldReap(corpse({ createdEpoch: 1000 }), 1005, { minAgeSeconds: 10 })).toBe(false);
        expect(shouldReap(corpse({ createdEpoch: 1000 }), 1020, { minAgeSeconds: 10 })).toBe(true);
    });
});
