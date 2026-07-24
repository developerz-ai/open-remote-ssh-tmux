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

    it('emits attach-or-create argv with per-session hardening/cosmetics', () => {
        // `-s` names the NEW session (exact by construction); `set-window-option`'s
        // `-t` is target-session and accepts bare `=<name>`. `set-option`'s `-t` is
        // target-WINDOW syntax (confirmed against real tmux 3.4): a bare `=<name>`
        // there is NOT recognised as exact-match-session-default-window and fails
        // silently with "no such session" — status/history-limit never applied
        // (status bar leaked, a hard Invisible-UX violation). The trailing `:`
        // (`=<name>:`) is required to get exact-match session + default window.
        expect(buildAttachOrCreateArgv(NAME, '/home/user/proj')).toEqual([
            'new-session', '-A', '-s', NAME, '-c', '/home/user/proj',
            ';', 'set-window-option', '-t', `=${NAME}`, 'remain-on-exit', 'off',
            ';', 'set-option', '-t', `=${NAME}:`, 'status', 'off',
            ';', 'set-option', '-t', `=${NAME}:`, 'history-limit', '50000',
        ]);
    });

    it('carries -A and never destroy-unattached', () => {
        const argv = buildAttachOrCreateArgv(NAME, '/home/user/proj');
        expect(argv).toContain('-A');
        expect(argv).not.toContain('destroy-unattached');
    });

    it('appends the shell command as its own argv element when given', () => {
        expect(buildAttachOrCreateArgv(NAME, '/home/user/proj', '/bin/zsh').slice(0, 7)).toEqual([
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
