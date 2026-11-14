import { describe, expect, it } from 'vitest';
import {
    buildAttachOrCreateArgv,
    buildClaimSessionCommand,
    buildDetachClientsCommand,
    buildHasSession,
    buildHasSessionsCommand,
    buildKillSession,
    buildListClientsCommand,
    buildListSessions,
    buildRenameSession,
    canonicalHostKey,
    canonicalWorkspaceKey,
    clampHistoryLimit,
    classifyTmuxFailure,
    escapeShellArg,
    isDuplicateSession,
    isOurSession,
    parseHasSessions,
    parseListClients,
    parseListSessions,
    readListSessionsResult,
    reapVerdict,
    sessionName,
    sessionSlot,
    shouldReap,
    tmuxFeatures,
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
            `'tmux' list-sessions -F `
            + `'#{session_name} #{session_attached} #{session_windows} #{session_created} #{pane_dead} a:#{session_activity} o:#{@orst_owner}'`,
        );
    });

    // The pty launches the probe's absolute path; exec-side commands must address the SAME
    // binary, or a bare `tmux` on a different PATH can talk to a different server.
    it('runs the given tmux binary, quoted', () => {
        expect(buildListSessions(`/home/a b/tmux`)).toMatch(/^'\/home\/a b\/tmux' list-sessions -F /);
    });
});

describe('buildHasSession / buildKillSession', () => {
    it('targets the escaped session name with an exact-match (=) prefix', () => {
        // `-t <name>` is prefix/fuzzy match in tmux: `has-session -t code-<h>-0`
        // would match `code-<h>-01`, and `kill-session` would kill the wrong live
        // session. `=` forces an exact match. The `=` sits outside the quotes so the
        // shell concatenates it onto the (still fully escaped) name.
        expect(buildHasSession(`code-${HASH_PROJ}-0`)).toBe(`'tmux' has-session -t ='code-${HASH_PROJ}-0'`);
        expect(buildKillSession(`code-${HASH_PROJ}-0`)).toBe(`'tmux' kill-session -t ='code-${HASH_PROJ}-0'`);
    });

    it('runs the given tmux binary, quoted', () => {
        expect(buildHasSession('n', `/x/it's/tmux`)).toBe(`'/x/it'\\''s/tmux' has-session -t ='n'`);
        expect(buildKillSession('n', '/usr/local/bin/tmux')).toBe(`'/usr/local/bin/tmux' kill-session -t ='n'`);
    });
});

describe('buildHasSessionsCommand', () => {
    // One remote round-trip for N names instead of N sequential `has-session`s (~400 ms
    // each in the field). Each name gets its own exact `=name` probe, and its exit status
    // and message come back on one tagged line so they can be classified per name.
    const A = `code-${HASH_PROJ}-0`;
    const B = `code-${HASH_PROJ}-1`;

    it('probes every name with an exact-match target and tags each answer by index', () => {
        expect(buildHasSessionsCommand([A, B])).toBe(
            `r=$('tmux' has-session -t ='${A}' 2>&1); printf '__has %s %s %s\\n' 0 "$?" "$r"; `
            + `r=$('tmux' has-session -t ='${B}' 2>&1); printf '__has %s %s %s\\n' 1 "$?" "$r"`,
        );
    });

    it('reuses the single-name builder, so every name is escaped exactly like it', () => {
        expect(buildHasSessionsCommand([A])).toContain(buildHasSession(A));
        expect(buildHasSessionsCommand([A], '/opt/tmux')).toContain(buildHasSession(A, '/opt/tmux'));
    });

    it('keeps a hostile name inert (quoted, never spliced as shell syntax)', () => {
        const hostile = `x'; rm -rf ~; echo '`;
        const command = buildHasSessionsCommand([hostile]);
        expect(command).toContain(`=${escapeShellArg(hostile)}`);
        expect(command).not.toContain(`='x'; rm`);
    });

    it('stays a single line (a csh login shell rejects newlines inside quotes)', () => {
        expect(buildHasSessionsCommand([A, B])).not.toContain('\n');
    });
});

describe('parseHasSessions', () => {
    it('reads each tagged answer back by index', () => {
        const stdout = `__has 0 0 \n__has 1 1 can't find session: x\n`;
        expect(parseHasSessions(stdout, 2)).toEqual([
            { code: 0, message: '' },
            { code: 1, message: `can't find session: x` },
        ]);
    });

    it('reports a name whose line never came back as code undefined', () => {
        expect(parseHasSessions('__has 1 0 \n', 2)).toEqual([
            { code: undefined, message: '' },
            { code: 0, message: '' },
        ]);
    });

    it('ignores banner noise and out-of-range indexes', () => {
        const stdout = `Welcome!\n__has 7 0 \n__has 0 1 no server running on /tmp/tmux-1000/default\n`;
        expect(parseHasSessions(stdout, 1)).toEqual([
            { code: 1, message: 'no server running on /tmp/tmux-1000/default' },
        ]);
    });
});

describe('classifyTmuxFailure', () => {
    // Prune/kill decisions hang on this: only a confirmed `absent` may ever drop a mapping.
    // Anything we cannot positively read as "not there" is `unreachable` (keep, retry later).
    it.each([
        [`can't find session: code-abc-0`, 1, 'absent'],
        [`can't find session code-abc-0`, 1, 'absent'],
        [`session not found: code-abc-0`, 1, 'absent'],
        ['no server running on /tmp/tmux-1000/default', 1, 'absent'],
        // tmux 3.4 says this (verified) when the socket does not exist: no server, so absent.
        ['error connecting to /tmp/tmux-1000/default (No such file or directory)', 1, 'absent'],
        ['error connecting to /tmp/tmux-1000/default (Connection refused)', 1, 'absent'],
        ['error connecting to /tmp/tmux-1000/default (Permission denied)', 1, 'unreachable'],
        ['protocol version mismatch (client 8, server 7)', 1, 'incompatible'],
        ['', 1, 'unreachable'],
        ['sh: 1: tmux: not found', 127, 'unreachable'],
        [`can't find session: x`, undefined, 'unreachable'],
        ['', undefined, 'unreachable'],
        ['', 0, 'present'],
    ] as const)('%j (rc %s) -> %s', (stderr, code, expected) => {
        expect(classifyTmuxFailure(stderr, code)).toBe(expected);
    });
});

describe('clampHistoryLimit', () => {
    // A value tmux rejects (`1.5`, `-1`, `1e10`) used to abort the whole `;` chain before
    // `new-session`, so no terminal could open at all — reproduced on every rig version.
    it.each([
        [1.5, 50000],
        [-1, 50000],
        [1e10, 1_000_000],
        [Number.NaN, 50000],
        [Number.POSITIVE_INFINITY, 50000],
        ['50', 50000],
        [undefined, 50000],
        [0, 0],
        [1_000_000, 1_000_000],
        [2000, 2000],
    ] as const)('%s -> %s', (input, expected) => {
        expect(clampHistoryLimit(input)).toBe(expected);
    });
});

describe('tmuxFeatures', () => {
    // tmux 3.7 ("When history-limit is changed, apply to existing panes") is the only
    // version split the chain needs: from there a session-scoped history-limit reaches
    // the pane, and touching the global would resize every pane of the user's server.
    it.each([
        ['2.6', false],
        ['3.0a', false],
        ['3.4', false],
        ['3.5a', false],
        ['3.6b', false],
        ['3.7', true],
        ['3.8', true],
        ['10.0', true],
        ['next-3.7', true],
        ['master', true],
        [undefined, true],
    ] as const)('%s -> liveHistoryLimit %s', (version, live) => {
        expect(tmuxFeatures(version).liveHistoryLimit).toBe(live);
    });
});

describe('buildAttachOrCreateArgv', () => {
    // The argv form is what a VS Code terminal profile's `shellArgs` carries. The pty host
    // hands it to execve directly — NO shell — so the tmux command separator is a bare `;`
    // element. tmux itself still reads two things in it: formats (`#…`) in `-c` and in its
    // shell jobs, and a trailing `;` on any element (both verified on the rig).
    const NAME = `code-${HASH_PROJ}-0`;
    const TMUX = '/usr/local/bin/tmux';
    const Q = `'${TMUX}'`;

    // The `if-shell -F` predicate guarding the PageUp/PageDown bindings: 1 = the pane's
    // application keeps the key, 0 = it means "scroll" and is ours. Pinned as a literal so
    // a change to the builder's format string has to be made deliberately in both places.
    const PASS_THROUGH = '#{?alternate_on,1,#{?#{m:*sh,#{pane_current_command}},0,1}}';

    const SESSION_TAIL = [
        ';', 'set-window-option', '-t', `=${NAME}`, 'remain-on-exit', 'off',
        ';', 'set-option', '-t', `=${NAME}:`, 'status', 'off',
        ';', 'set-option', '-t', `=${NAME}:`, 'history-limit', '50000',
        ';', 'set-option', '-t', `=${NAME}:`, 'mouse', 'on',
        ';', 'set-option', '-t', `=${NAME}:`, 'prefix', 'None',
        ';', 'set-option', '-t', `=${NAME}:`, 'prefix2', 'None',
        ';', 'if-shell', '-F', '#{==:#{escape-time},500}', 'set-option -s escape-time 10',
        ';', 'if-shell', '-F', '#{==:#{set-clipboard},external}', 'set-option -s set-clipboard on',
        ';', 'if-shell', `${Q} list-keys -T root | grep -Eq -- '-T root +PPage '`, '',
        `bind-key -n PPage if-shell -F '${PASS_THROUGH}' 'send-keys PPage' 'copy-mode -eu'`,
        ';', 'if-shell', `${Q} list-keys -T root | grep -Eq -- '-T root +NPage '`, '',
        `bind-key -n NPage if-shell -F '${PASS_THROUGH}' 'send-keys NPage'`,
    ];

    it('tmux >= 3.7: sets history-limit on the session only — the global is never touched', () => {
        expect(buildAttachOrCreateArgv(NAME, '/home/user/proj', undefined, { tmuxPath: TMUX, tmuxVersion: '3.8' })).toEqual([
            'new-session', '-A', '-s', NAME, '-c', '/home/user/proj',
            ...SESSION_TAIL,
        ]);
    });

    // Before 3.7 `history-limit` is read only when a pane is created, and `new-session`
    // creates the pane before any chained command runs, so the global is the only lever.
    // `set-option -gu` (the old restore) reset it to tmux's built-in 2000, not the user's
    // own value — reproduced on every rig version. So the user's exact global is saved
    // first. `show-options -gv` in a shell job, not a `#{history-limit}` format: a format
    // resolves through the most recent session, so a session-local value there would be
    // "restored" as the global (verified on the rig).
    it('tmux < 3.7: saves the user\'s global, sets ours for the new pane, restores theirs', () => {
        expect(buildAttachOrCreateArgv(NAME, '/home/user/proj', undefined, { tmuxPath: TMUX, tmuxVersion: '3.4' })).toEqual([
            'run-shell', `${Q} set-option -g @orst_saved_hl "$(${Q} show-options -gv history-limit)"`,
            ';', 'set-option', '-g', 'history-limit', '50000',
            ';', 'new-session', '-A', '-s', NAME, '-c', '/home/user/proj',
            ';', 'set-option', '-gF', 'history-limit', '#{@orst_saved_hl}',
            ...SESSION_TAIL,
        ]);
    });

    it('never resets the global history-limit to the built-in default (-gu)', () => {
        for (const tmuxVersion of ['2.6', '3.4', '3.8']) {
            expect(buildAttachOrCreateArgv(NAME, '/p', undefined, { tmuxVersion })).not.toContain('-gu');
        }
    });

    it('restores the global immediately after new-session, before anything that can fail', () => {
        const argv = buildAttachOrCreateArgv(NAME, '/p', undefined, { tmuxVersion: '2.6' });
        const create = argv.indexOf('new-session');
        expect(argv.slice(create + 6, create + 11)).toEqual([';', 'set-option', '-gF', 'history-limit', '#{@orst_saved_hl}']);
    });

    it('defaults to the modern chain and a bare tmux when version/path are unknown', () => {
        const argv = buildAttachOrCreateArgv(NAME, '/p');
        expect(argv[0]).toBe('new-session');
        expect(argv).toContain(`'tmux' list-keys -T root | grep -Eq -- '-T root +PPage '`);
    });

    // tmux's prefix (C-b) is a tmux UI the user never asked for, and it eats a key Claude
    // Code uses. Session-scoped, so the user's own sessions keep theirs.
    it('disables the prefix keys for our session only', () => {
        const argv = buildAttachOrCreateArgv(NAME, '/p');
        for (const option of ['prefix', 'prefix2']) {
            const at = argv.indexOf(option);
            expect(argv.slice(at - 3, at + 2)).toEqual(['set-option', '-t', `=${NAME}:`, option, 'None']);
        }
    });

    // `escape-time`, `set-clipboard` and the root key table are server-wide: each is
    // changed only while it still holds tmux's built-in default / is unbound, so a value
    // the user configured is left alone.
    it('touches server-wide state only where the user left tmux\'s default', () => {
        const argv = buildAttachOrCreateArgv(NAME, '/p', undefined, { tmuxVersion: '3.8' });
        // No unconditional server/global write anywhere in the modern chain...
        expect(argv.filter((arg, i) => arg === 'set-option' && ['-s', '-g'].includes(argv[i + 1]))).toEqual([]);
        expect(argv).not.toContain('bind-key');
        // ...only guarded ones: each runs as the then-branch of a default test.
        expect(argv.slice(argv.indexOf('set-option -s escape-time 10') - 3)[0]).toBe('if-shell');
        expect(argv[argv.indexOf('set-option -s escape-time 10') - 1]).toBe('#{==:#{escape-time},500}');
        expect(argv[argv.indexOf('set-option -s set-clipboard on') - 1]).toBe('#{==:#{set-clipboard},external}');
    });

    it('keeps the user\'s PageUp/PageDown when they bound one (if-shell then-branch is empty)', () => {
        const argv = buildAttachOrCreateArgv(NAME, '/p', undefined, { tmuxPath: TMUX });
        for (const key of ['PPage', 'NPage']) {
            const at = argv.indexOf(`${Q} list-keys -T root | grep -Eq -- '-T root +${key} '`);
            expect(argv[at - 1]).toBe('if-shell');
            expect(argv[at + 1]).toBe('');
            expect(argv[at + 2]).toMatch(new RegExp(`^bind-key -n ${key} if-shell -F `));
        }
    });

    it('quotes the tmux path for the shell jobs and escapes # for tmux formats', () => {
        const argv = buildAttachOrCreateArgv(NAME, '/p', undefined, { tmuxPath: `/opt/it's #1/tmux`, tmuxVersion: '3.4' });
        const quoted = `'/opt/it'\\''s ##1/tmux'`;
        expect(argv[1]).toBe(`${quoted} set-option -g @orst_saved_hl "$(${quoted} show-options -gv history-limit)"`);
        expect(argv).toContain(`${quoted} list-keys -T root | grep -Eq -- '-T root +PPage '`);
    });

    // SECURITY: tmux format-expands `new-session -c`, so a directory named
    // `x#(touch $HOME/pwned)` RAN that command on every rig version, and `#S` changed the
    // directory. `##` is tmux's literal `#`. A trailing `;` on any argv element is read as
    // a command separator; `\;` is its literal form (verified 2.6 … 3.8).
    it.each([
        ['/home/u/x#(touch $HOME/pwned)', '/home/u/x##(touch $HOME/pwned)'],
        ['/home/u/x#S', '/home/u/x##S'],
        ['/home/u/x;', '/home/u/x\\;'],
        ['/home/u/z;;', '/home/u/z;\\;'],
        ['/home/u/y\\;', '/home/u/y\\\\;'],
        ['/home/u/a;b', '/home/u/a;b'],
        [`/tmp/pwn'; rm -rf $HOME'`, `/tmp/pwn'; rm -rf $HOME'`],
    ])('passes cwd %j to tmux as the literal %j', (cwd, expected) => {
        const argv = buildAttachOrCreateArgv(NAME, cwd);
        expect(argv[argv.indexOf('-c') + 1]).toBe(expected);
    });

    // `takeOver` emits `-D`, which with `-A` makes tmux behave like `attach-session -d`:
    // it evicts whatever client is already on the session before attaching. Used only to
    // reclaim a slot THIS client owns (see src/tmux/slotState.ts).
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

    it('enables mouse mode for our session so the wheel scrolls scrollback, not shell history', () => {
        const argv = buildAttachOrCreateArgv(NAME, '/home/user/proj');
        const mouse = argv.indexOf('mouse');
        expect(argv.slice(mouse - 4, mouse + 2)).toEqual([';', 'set-option', '-t', `=${NAME}:`, 'mouse', 'on']);
    });

    it('honours a caller-supplied history limit, clamped', () => {
        const at = (argv: string[]) => argv[argv.lastIndexOf('history-limit') + 1];
        expect(at(buildAttachOrCreateArgv(NAME, '/p', undefined, { historyLimit: 100000 }))).toBe('100000');
        expect(at(buildAttachOrCreateArgv(NAME, '/p', undefined, { historyLimit: -1 }))).toBe('50000');
        expect(at(buildAttachOrCreateArgv(NAME, '/p', undefined, { historyLimit: 1.5, tmuxVersion: '3.4' }))).toBe('50000');
        expect(buildAttachOrCreateArgv(NAME, '/p', undefined, { historyLimit: 1e10, tmuxVersion: '3.4' }).slice(3, 7))
            .toEqual(['set-option', '-g', 'history-limit', '1000000']);
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

    // The documented contract is `name === sessionName(host, ws, slot)`, and the callers
    // depend on it literally: `terminalProvider` decodes a slot from an observed remote
    // name and then re-derives the session name from that slot (adoption, restore-claim).
    // A suffix that decodes to a slot whose `sessionName` is a DIFFERENT string breaks the
    // round trip, and the provider ends up attaching a brand-new empty session while the
    // real one is stranded on the remote with nothing pointing at it — a zombie.
    it('rejects a suffix that does not round-trip back to the same name', () => {
        // Zero-padded: `parseInt('007')` is 7, but `sessionName(..., 7)` ends in `-7`.
        expect(sessionSlot(`code-${HASH_PROJ}-007`, 'example.com', '/home/user/proj')).toBeUndefined();
        expect(sessionSlot(`code-${HASH_PROJ}-00`, 'example.com', '/home/user/proj')).toBeUndefined();
    });

    it('rejects a slot beyond the safe-integer range (parseInt would round it)', () => {
        // `parseInt('99999999999999999999')` is 1e20 — an integer by `Number.isInteger`,
        // so it would sail through `sessionName` and produce a different name again.
        expect(sessionSlot(`code-${HASH_PROJ}-99999999999999999999`, 'example.com', '/home/user/proj'))
            .toBeUndefined();
    });

    it('still accepts every slot we actually mint, round trip included', () => {
        for (const slot of [0, 1, 9, 10, 12, 1234]) {
            const name = sessionName('example.com', '/home/user/proj', slot);
            const decoded = sessionSlot(name, 'example.com', '/home/user/proj');
            expect(decoded).toBe(slot);
            expect(sessionName('example.com', '/home/user/proj', decoded!)).toBe(name);
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

describe('readListSessionsResult', () => {
    const ROW = `code-${HASH_PROJ}-0 0 1 1700000000 0`;

    it('parses a successful list', () => {
        expect(readListSessionsResult({ stdout: ROW, stderr: '', code: 0 })).toHaveLength(1);
    });

    it('reads "no server running" (exit 1) as zero sessions — nothing to list is an answer', () => {
        expect(readListSessionsResult({ stdout: '', stderr: 'no server running on /tmp/tmux-1000/default', code: 1 }))
            .toEqual([]);
    });

    it.each([
        ['tmux not runnable', { stdout: '', stderr: 'sh: 1: tmux: not found', code: 127 }],
        ['exit status never came back', { stdout: ROW, stderr: '', code: undefined }],
        ['client/server skew', { stdout: '', stderr: 'protocol version mismatch (client 8, server 7)', code: 1 }],
    ])('returns undefined (could not list) when %s', (_label, result) => {
        expect(readListSessionsResult(result)).toBeUndefined();
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

    // `isOurSession` is the reaper's kill permit, so it must admit only names this
    // extension could actually have MINTED — not merely names of a similar shape. A
    // wrong hash length or a zero-padded slot is a session someone else created; the
    // conservative rule is to leave it alone.
    it('rejects a hash that is not exactly the length we mint', () => {
        expect(isOurSession('code-a-0')).toBe(false);
        expect(isOurSession(`code-${HASH_PROJ}a-0`)).toBe(false);
        expect(isOurSession(`code-${HASH_PROJ.slice(0, 11)}-0`)).toBe(false);
    });

    it('rejects a zero-padded slot we would never mint', () => {
        expect(isOurSession(`code-${HASH_PROJ}-007`)).toBe(false);
        expect(isOurSession(`code-${HASH_PROJ}-00`)).toBe(false);
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

describe('owner tag (slice 03: who holds a session)', () => {
    const NAME = `code-${HASH_PROJ}-0`;
    const OWNER = '1a2b3c4d-0011aabb';

    // Every attach writes this window's client id into the session, so another machine can
    // tell our stale pty from its own live one. Session-scoped (`=name:`), right after the
    // create, so it is set before anything later in the chain can fail.
    it('sets @orst_owner on our session right after new-session', () => {
        const argv = buildAttachOrCreateArgv(NAME, '/home/user/proj', undefined, { owner: OWNER });
        const create = argv.indexOf('new-session');
        const tag = argv.indexOf('@orst_owner');
        expect(argv.slice(tag - 3, tag + 2)).toEqual(['set-option', '-t', `=${NAME}:`, '@orst_owner', OWNER]);
        expect(tag).toBeGreaterThan(create);
        expect(argv.slice(create, tag).filter(token => token === ';')).toHaveLength(1);
    });

    it('sets it after the history-limit restore on the legacy chain', () => {
        const argv = buildAttachOrCreateArgv(NAME, '/p', undefined, { owner: OWNER, tmuxVersion: '2.6' });
        expect(argv.indexOf('@orst_owner')).toBeGreaterThan(argv.indexOf('-gF'));
    });

    it('omits the tag when no owner is given', () => {
        expect(buildAttachOrCreateArgv(NAME, '/p')).not.toContain('@orst_owner');
    });

    it.each(['x;', 'a b', '#{session_name}', ''])('refuses a malformed owner %j (it is a tmux argv element)', owner => {
        expect(() => buildAttachOrCreateArgv(NAME, '/p', undefined, { owner })).toThrow();
    });
});

describe('parseListSessions with the owner field', () => {
    it('reads the owner tag', () => {
        expect(parseListSessions('code-x-0 1 1 1700000000 0 o:1a2b3c4d-0011aabb')[0]).toEqual({
            name: 'code-x-0', attached: true, windows: 1, paneDead: false, createdEpoch: 1700000000, owner: '1a2b3c4d-0011aabb',
        });
    });

    it('reads an untagged session (created before tags) as owner unknown', () => {
        expect(parseListSessions('code-x-0 1 1 1700000000 0 o:')[0].owner).toBeUndefined();
    });

    it('still parses the old five-field shape (owner unknown)', () => {
        expect(parseListSessions('code-x-0 1 1 1700000000 0')[0]).toMatchObject({ name: 'code-x-0', owner: undefined });
    });

    it('keeps a name with spaces intact alongside the owner', () => {
        expect(parseListSessions('my session 0 1 1700000000 0 o:')[0].name).toBe('my session');
    });
});

describe('buildListClientsCommand / parseListClients (staleness evidence)', () => {
    it('prints the remote clock, then every client\'s session and last input time', () => {
        expect(buildListClientsCommand()).toBe(
            `printf '__now %s\\n' "$(date +%s)"; 'tmux' list-clients -F '#{client_session} #{client_activity}'`,
        );
    });

    it('runs the given tmux binary, quoted', () => {
        expect(buildListClientsCommand('/home/a b/tmux')).toContain(`'/home/a b/tmux' list-clients`);
    });

    it('parses the clock and the clients (session names read from the left of the epoch)', () => {
        expect(parseListClients('__now 1800000100\ncode-x-0 1800000000\nmy session 1799999000\n')).toEqual({
            now: 1800000100,
            clients: [
                { session: 'code-x-0', activity: 1800000000 },
                { session: 'my session', activity: 1799999000 },
            ],
        });
    });

    it('skips noise and reports a missing clock as undefined', () => {
        expect(parseListClients('banner\nno server running on /tmp/x\n')).toEqual({ now: undefined, clients: [] });
    });
});

describe('buildDetachClientsCommand (explicit detach on window close)', () => {
    const OWNER = '1a2b3c4d-0011aabb';
    const A = `code-${HASH_PROJ}-0`;
    const B = `code-${HASH_PROJ}-1`;

    // Only detach where the owner tag is still ours: if another machine took the session over
    // a moment ago, its client is the one on it now, and `detach-client -s` would evict it.
    it('detaches each session only while its owner tag is ours, with exact = targets', () => {
        const command = buildDetachClientsCommand([A, B], OWNER);
        for (const name of [A, B]) {
            expect(command).toContain(
                `[ "$('tmux' display-message -p -t ='${name}': '#{@orst_owner}' 2>/dev/null)" = '${OWNER}' ] `
                + `&& 'tmux' detach-client -s ='${name}' 2>/dev/null`,
            );
        }
        expect(command.split('; ')).toHaveLength(2);
    });

    it('runs the given tmux binary, quoted', () => {
        expect(buildDetachClientsCommand([A], OWNER, '/opt/my tmux')).toContain(`'/opt/my tmux' detach-client`);
    });

    it('refuses a malformed owner', () => {
        expect(() => buildDetachClientsCommand([A], 'x;y')).toThrow();
    });
});

describe('parseListSessions with the activity field (05: orphan aging)', () => {
    it('reads #{session_activity} as activityEpoch', () => {
        expect(parseListSessions('code-x-0 0 1 1700000000 0 a:1700000500 o:')[0]).toMatchObject({
            name: 'code-x-0', createdEpoch: 1700000000, activityEpoch: 1700000500, owner: undefined,
        });
    });

    it('reads activity alongside an owner tag, and a name with spaces', () => {
        expect(parseListSessions('my s 0 1 1700000000 0 a:1700000001 o:1a2b3c4d-0011aabb')[0]).toMatchObject({
            name: 'my s', activityEpoch: 1700000001, owner: '1a2b3c4d-0011aabb',
        });
    });

    it('leaves activityEpoch undefined for rows without it, or with a non-numeric value', () => {
        expect(parseListSessions('code-x-0 0 1 1700000000 0 o:')[0].activityEpoch).toBeUndefined();
        expect(parseListSessions('code-x-0 0 1 1700000000 0 a: o:')[0].activityEpoch).toBeUndefined();
    });
});

describe('shouldReap / reapVerdict: orphan aging (05)', () => {
    const DAY = 86400;
    const NOW = 1_800_000_000;
    // Ours by name, detached, live pane, last touched `idleDays` ago.
    const orphan = (idleDays: number, over: Partial<Parameters<typeof shouldReap>[0]> = {}) => ({
        name: `code-${HASH_PROJ}-0`,
        attached: false,
        windows: 1,
        paneDead: false,
        createdEpoch: NOW - 100 * DAY,
        activityEpoch: NOW - idleDays * DAY,
        ...over,
    });

    it('reaps a detached session of ours idle past the limit', () => {
        expect(shouldReap(orphan(15), NOW, { orphanMaxAgeDays: 14 })).toBe(true);
        expect(reapVerdict(orphan(15), NOW, { orphanMaxAgeDays: 14 })).toBe('reap-orphan');
    });

    it('keeps one active within the limit, counted as an orphan', () => {
        expect(shouldReap(orphan(13), NOW, { orphanMaxAgeDays: 14 })).toBe(false);
        expect(reapVerdict(orphan(13), NOW, { orphanMaxAgeDays: 14 })).toBe('orphan');
    });

    it('never reaps an attached session, however old', () => {
        expect(shouldReap(orphan(400, { attached: true }), NOW, { orphanMaxAgeDays: 14 })).toBe(false);
        expect(reapVerdict(orphan(400, { attached: true }), NOW, { orphanMaxAgeDays: 14 })).toBe('keep');
    });

    it('never reaps a foreign name, however old', () => {
        for (const name of ['main', 'code', 'code-notes', `code-${HASH_PROJ}-007`]) {
            expect(shouldReap(orphan(400, { name }), NOW, { orphanMaxAgeDays: 14 })).toBe(false);
            expect(reapVerdict(orphan(400, { name }), NOW, { orphanMaxAgeDays: 14 })).toBe('keep');
        }
    });

    it('0 (or no setting) disables aging — the session is only counted', () => {
        expect(shouldReap(orphan(400), NOW, { orphanMaxAgeDays: 0 })).toBe(false);
        expect(shouldReap(orphan(400), NOW)).toBe(false);
        expect(reapVerdict(orphan(400), NOW, { orphanMaxAgeDays: 0 })).toBe('orphan');
    });

    it('rejects a nonsensical limit (negative, fractional, NaN) as disabled', () => {
        for (const days of [-1, 1.5, Number.NaN]) {
            expect(shouldReap(orphan(400), NOW, { orphanMaxAgeDays: days })).toBe(false);
        }
    });

    it('keeps a session whose activity could not be read (no evidence of age)', () => {
        expect(shouldReap(orphan(400, { activityEpoch: undefined }), NOW, { orphanMaxAgeDays: 14 })).toBe(false);
    });

    it('an owner tag naming another machine does not protect a detached, aged session', () => {
        expect(shouldReap(orphan(15, { owner: '1a2b3c4d-0011aabb' }), NOW, { orphanMaxAgeDays: 14 })).toBe(true);
    });

    it('a corpse is still a corpse (dead pane wins, no aging needed)', () => {
        expect(reapVerdict(orphan(0, { paneDead: true }), NOW)).toBe('reap-corpse');
    });
});

describe('canonicalHostKey / canonicalWorkspaceKey (05: one identity per real target)', () => {
    it('an alias and the address it resolves to give the same key', () => {
        // `myvps` with HostName 203.0.113.7 in ~/.ssh/config, versus typing the address.
        expect(canonicalHostKey({ hostName: '203.0.113.7', user: 'dev', port: 22 }))
            .toBe(canonicalHostKey({ hostName: '203.0.113.7', user: 'dev', port: 22 }));
    });

    it('is case-insensitive in the host name (DNS is)', () => {
        expect(canonicalHostKey({ hostName: 'MyVPS.Example.com', user: 'dev', port: 22 }))
            .toBe(canonicalHostKey({ hostName: 'myvps.example.com', user: 'dev', port: 22 }));
    });

    it('a different user or port is a different target', () => {
        const base = canonicalHostKey({ hostName: 'h', user: 'dev', port: 22 });
        expect(canonicalHostKey({ hostName: 'h', user: 'root', port: 22 })).not.toBe(base);
        expect(canonicalHostKey({ hostName: 'h', user: 'dev', port: 2222 })).not.toBe(base);
    });

    it('spells the key as user@host:port', () => {
        expect(canonicalHostKey({ hostName: 'h.example', user: 'dev', port: 2222 })).toBe('dev@h.example:2222');
    });

    it('strips trailing slashes and collapses repeated ones', () => {
        expect(canonicalWorkspaceKey('/home/dev/proj/')).toBe('/home/dev/proj');
        expect(canonicalWorkspaceKey('/home//dev///proj//')).toBe('/home/dev/proj');
        expect(canonicalWorkspaceKey('/home/dev/proj')).toBe('/home/dev/proj');
    });

    it('keeps the root as /', () => {
        expect(canonicalWorkspaceKey('/')).toBe('/');
        expect(canonicalWorkspaceKey('//')).toBe('/');
    });
});

describe('buildRenameSession (05: legacy identity adoption)', () => {
    it('renames an exact target, both names quoted', () => {
        expect(buildRenameSession(`code-${HASH_PROJ}-0`, `code-${HASH_OTHER_WS}-1`)).toBe(
            `'tmux' rename-session -t ='code-${HASH_PROJ}-0' 'code-${HASH_OTHER_WS}-1'`,
        );
    });

    it('runs the given tmux binary', () => {
        expect(buildRenameSession('a', `code-${HASH_PROJ}-1`, '/opt/t mux')).toMatch(/^'\/opt\/t mux' rename-session /);
    });

    it('refuses to rename to a name we could not have minted', () => {
        expect(() => buildRenameSession(`code-${HASH_PROJ}-0`, 'main; kill-server')).toThrow();
    });
});

describe('buildClaimSessionCommand (05 l: a new slot is claimed on the remote before it is handed out)', () => {
    const NAME = `code-${HASH_PROJ}-0`;
    const OWNER = '1a2b3c4d-0011aabb';

    it('is the attach chain with a detached create (-d, no -A), every word shell-quoted', () => {
        const argv = buildAttachOrCreateArgv(NAME, '/srv/p', undefined, { tmuxVersion: '3.8', owner: OWNER, detached: true });
        expect(argv.slice(0, 6)).toEqual(['new-session', '-d', '-s', NAME, '-c', '/srv/p']);
        expect(argv).not.toContain('-A');
        expect(buildClaimSessionCommand(NAME, '/srv/p', { tmuxVersion: '3.8', owner: OWNER }))
            .toBe(`'tmux' ${argv.map(escapeShellArg).join(' ')}`);
    });

    it('below 3.7 puts the borrowed global history-limit back when the create fails (a duplicate)', () => {
        const command = buildClaimSessionCommand(NAME, '/srv/p', { tmuxVersion: '3.4', owner: OWNER, tmuxPath: '/opt/tmux' });
        expect(command).toContain(`'new-session' '-d' '-s' '${NAME}'`);
        expect(command).toMatch(/ \|\| \{ rc=\$\?; '\/opt\/tmux' set-option -gF history-limit '#\{@orst_saved_hl\}'; \(exit \$rc\); \}$/);
    });

    it('has no restore fallback where nothing global is borrowed', () => {
        expect(buildClaimSessionCommand(NAME, '/srv/p', { tmuxVersion: '3.8' })).not.toContain('||');
    });

    it('keeps a hostile path inert (single argv word, format chars escaped)', () => {
        const command = buildClaimSessionCommand(NAME, '/srv/x\'; rm -rf ~; \'#(id)', { tmuxVersion: '3.8' });
        expect(command).toContain(escapeShellArg('/srv/x\'; rm -rf ~; \'##(id)'));
    });
});

describe('isDuplicateSession', () => {
    it('recognises tmux\'s duplicate-session refusal and nothing else', () => {
        expect(isDuplicateSession('duplicate session: code-abc-0')).toBe(true);
        expect(isDuplicateSession('can\'t find session: x')).toBe(false);
        expect(isDuplicateSession('')).toBe(false);
    });
});
