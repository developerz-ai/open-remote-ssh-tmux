import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { escapeShellArg } from '../../src/common/shellQuote';
import { probeTmux } from '../../src/tmux/tmuxBootstrap';
import { AttachOrCreateOptions, buildAttachOrCreateArgv, buildClaimSessionCommand, sessionName } from '../../src/tmux/tmuxSession';
import { describeRig, PtyClient, RIG_TMUX, RigSession, RigTarget, versionAtLeast, WORKERS } from './rig';

// What the attach-or-create chain does to the user's tmux server and to the bytes typed
// into the terminal. The baseline at the top must hold today; the `it.fails` cases are the
// spec slice 04 (04-tmux-command-hardening.md) turns green, each tagged with its finding.

const HOST = 'rig-host';

describeRig('argv chain hardening (real tmux)', target => {
    let rig: RigSession;
    let home: string;

    beforeAll(async () => {
        rig = await RigSession.open(target, WORKERS.hardening);
        home = await rig.ok('printf %s "$HOME"');
    });

    afterAll(async () => {
        await rig.resetTmux();
        await rig.close();
    });

    beforeEach(async () => {
        await rig.resetTmux();
        await rig.run('rm -f "$HOME"/pwned*');
    });

    /** What production passes: the probed path and version (`TmuxCapability`). */
    const probed: AttachOrCreateOptions = { tmuxPath: RIG_TMUX, tmuxVersion: target.version };

    async function launch(name: string, cwd: string, opts: AttachOrCreateOptions = {}): Promise<void> {
        await rig.spawnHeldClient(RIG_TMUX, buildAttachOrCreateArgv(name, cwd, undefined, { ...probed, ...opts }));
        await rig.waitUntil(`a client on ${name}`, async () => (await rig.clientCount(name)) >= 1);
    }

    /** Value-only `show-options` line, e.g. `history-limit 2000` → `2000`. */
    async function option(...args: string[]): Promise<string> {
        return (await rig.tmux('show-options', ...args)).stdout.trim().split(/\s+/).slice(1).join(' ');
    }

    it('baseline: the chain runs to its last command (root PPage/NPage bound, set-clipboard on)', async () => {
        await launch(sessionName(HOST, home, 0), home);

        const rootKeys = (await rig.tmux('list-keys', '-T', 'root')).stdout;
        expect(rootKeys).toMatch(/\bPPage\b.*if-shell/);
        expect(rootKeys).toMatch(/\bNPage\b.*if-shell/);
        expect(await option('-s', 'set-clipboard')).toBe('on');
    });

    it('(04b) a user\'s own global history-limit is unchanged after our attach', async () => {
        expect((await rig.tmux('new-session', '-d', '-s', 'main')).code).toBe(0);
        expect((await rig.tmux('set-option', '-g', 'history-limit', '100000')).code).toBe(0);
        // A session-local value on the user's most recent session must not leak into the
        // global either (a `#{history-limit}` format would have read this one).
        expect((await rig.tmux('set-option', '-t', '=main:', 'history-limit', '777')).code).toBe(0);
        const name = sessionName(HOST, home, 0);

        await launch(name, home, { historyLimit: 1234 });

        expect(await option('-g', 'history-limit')).toBe('100000');
        expect((await rig.tmux('display-message', '-p', '-t', `=${name}:`, '#{history_limit}')).stdout.trim()).toBe('1234');
    });

    it('(04c) server-wide settings the user configured survive our attach', async () => {
        expect((await rig.tmux('new-session', '-d', '-s', 'main')).code).toBe(0);
        expect((await rig.tmux('set-option', '-s', 'set-clipboard', 'off')).code).toBe(0);
        expect((await rig.tmux('set-option', '-s', 'escape-time', '42')).code).toBe(0);
        expect((await rig.tmux('bind-key', '-n', 'PPage', 'display-message', 'mine')).code).toBe(0);

        await launch(sessionName(HOST, home, 0), home);

        expect(await option('-s', 'set-clipboard')).toBe('off');
        expect(await option('-s', 'escape-time')).toBe('42');
        const rootKeys = (await rig.tmux('list-keys', '-T', 'root')).stdout;
        expect(rootKeys).toMatch(/\bPPage\b.*display-message mine/);
        expect(rootKeys).toMatch(/\bNPage\b.*if-shell/);
        expect(await option('-g', 'prefix')).toBe('C-b');
    });

    const hostileDirs: ReadonlyArray<readonly [string, string]> = [
        ['a #(command) format', 'x#(touch $HOME/pwned)'],
        ['a #S format', 'x#S'],
        ['a trailing ;', 'x;'],
    ];
    for (const [label, dir] of hostileDirs) {
        it(`(04f) cwd containing ${label}: no command runs, cwd exact`, async () => {
            const cwd = `${home}/${dir}`;
            await rig.ok(`mkdir -p ${escapeShellArg(cwd)}`);
            const name = sessionName(HOST, cwd, 0);

            await launch(name, cwd);

            const pid = (await rig.tmux('display-message', '-p', '-t', name, '#{pane_pid}')).stdout.trim();
            expect((await rig.run('ls "$HOME"/pwned*')).code, 'a #() in the cwd ran a command').not.toBe(0);
            const actual = (await rig.run(`readlink /proc/${pid}/cwd`)).stdout.trim();
            expect(actual).toBe(cwd);
        });
    }

    for (const historyLimit of [1.5, -1, 1e10]) {
        it(`(04a) historyLimit ${historyLimit}: the session is still created`, async () => {
            const name = sessionName(HOST, home, 0);
            await rig.spawnHeldClient(RIG_TMUX, buildAttachOrCreateArgv(name, home, undefined, { ...probed, historyLimit }));

            await rig.waitUntil(`a client on ${name}`, async () => (await rig.clientCount(name)) >= 1, 5000);
        });
    }

    it('(04g) a login shell that prints a banner still yields the absolute tmux path', async () => {
        await rig.ok('cp "$HOME/.bashrc" "$HOME/.bashrc.rig" && { echo "echo Welcome to the rig"; cat "$HOME/.bashrc.rig"; } > "$HOME/.bashrc"');
        try {
            const capability = await probeTmux(rig.rawExec, 'linux');

            expect(capability).toMatchObject({ available: true, path: RIG_TMUX });
        } finally {
            await rig.ok('mv "$HOME/.bashrc.rig" "$HOME/.bashrc"');
        }
    });

    // ---- what the client is told about VS Code's terminal (xterm.js) ----

    /** `show-options -s <option>` reduced to its values, sorted — one string to compare. */
    async function serverOption(name: string): Promise<string> {
        return (await rig.tmux('show-options', '-s', name)).stdout.split('\n').map(line => line.trim()).filter(Boolean).sort().join('\n');
    }

    // Below 3.2 the only lever for 24-bit colour is the `Tc` terminal override, a SERVER
    // option: it is appended once per server, never once per attach. From 3.2 the client's
    // own `-T` carries it and nothing at all is written to the server.
    it('repeated attaches and claims never grow the user\'s terminal-overrides / terminal-features', async () => {
        expect((await rig.tmux('new-session', '-d', '-s', 'main')).code).toBe(0);
        const before = { overrides: await serverOption('terminal-overrides'), features: await serverOption('terminal-features') };

        for (const slot of [0, 1, 2]) {
            await launch(sessionName(HOST, home, slot), home);
        }
        expect((await rig.exec(buildClaimSessionCommand(sessionName(HOST, home, 3), home, probed))).code).toBe(0);
        await launch(sessionName(HOST, home, 0), home); // a second client on an existing session

        const overrides = await serverOption('terminal-overrides');
        expect(await serverOption('terminal-features')).toBe(before.features);
        if (versionAtLeast(target.version, '3.2')) {
            expect(overrides).toBe(before.overrides);
        } else {
            expect(overrides.match(/xterm\*:Tc/g)).toHaveLength(1);
            expect(overrides.replace(/^.*xterm\*:Tc.*$/m, '').trim()).toBe(before.overrides);
        }
    });

    it('a user who already has the Tc override keeps exactly their own', async () => {
        expect((await rig.tmux('new-session', '-d', '-s', 'main')).code).toBe(0);
        expect((await rig.tmux('set-option', '-as', 'terminal-overrides', ',xterm*:Tc:smcup@')).code).toBe(0);
        const before = await serverOption('terminal-overrides');

        await launch(sessionName(HOST, home, 0), home);

        expect(await serverOption('terminal-overrides')).toBe(before);
    });

    describeClient(target, () => home);
    describeKeys(target, () => rig, () => home);
    describePaging(target, () => rig, () => home);
});

/** What reaches the terminal (the tmux client's pty) and the pane (its environment) when the
 * attach argv is run the way VS Code's pty host runs it: `TERM=xterm-256color`, and here a
 * `C` locale on purpose — the terminal renders UTF-8 whatever the locale claims. */
function describeClient(target: RigTarget, home: () => string): void {
    const INNER = [
        `printf 'CT=[%s]\\n' "$COLORTERM"`,
        `printf '\\033[38;2;10;200;30mRGB\\033[0m \\342\\234\\273 \\033]8;;https://example.com/x\\033\\\\LINK\\033]8;;\\033\\\\\\n'`,
        'exec sleep 600',
    ].join('; ');

    const ESC = '\x1b';

    async function openTerminal(slot: number): Promise<PtyClient> {
        const name = sessionName(HOST, `${home()}/client`, slot);
        const client = await PtyClient.open(target, WORKERS.hardening, 'env', [
            'LC_ALL=C', RIG_TMUX,
            ...buildAttachOrCreateArgv(name, home(), INNER, { tmuxPath: RIG_TMUX, tmuxVersion: target.version }),
        ]);
        await client.waitFor(/RGB/, 5000);
        return client;
    }

    it('24-bit colour reaches the terminal as 24-bit colour (not the 256 palette)', async () => {
        const terminal = await openTerminal(0);
        try {
            await terminal.waitFor(new RegExp(`${ESC}\\[38;2;10;200;30m`), 3000);
            expect(terminal.text).not.toMatch(new RegExp(`${ESC}\\[38;5;\\d+m`));
        } finally {
            terminal.close();
        }
    });

    it('non-ASCII output survives a non-UTF-8 client locale (-u)', async () => {
        const terminal = await openTerminal(1);
        try {
            await terminal.waitFor(/\u273b/, 3000);
        } finally {
            terminal.close();
        }
    });

    it.runIf(versionAtLeast(target.version, '3.2'))('tmux >= 3.2: the pane is told COLORTERM=truecolor', async () => {
        const terminal = await openTerminal(2);
        try {
            await terminal.waitFor(/CT=\[truecolor\]/, 3000);
        } finally {
            terminal.close();
        }
    });

    it.runIf(versionAtLeast(target.version, '3.4'))('tmux >= 3.4: OSC 8 hyperlinks reach the terminal', async () => {
        const terminal = await openTerminal(3);
        try {
            await terminal.waitFor(new RegExp(`${ESC}\\]8;[^;]*;https://example\\.com/x`), 3000);
        } finally {
            terminal.close();
        }
    });
}

/** PageUp is bound in the root key table, which is SERVER-global: it must scroll only at a
 * shell prompt of one of our sessions and reach the program everywhere else — the user's
 * own sessions above all. The pane runs `cat -v` under a name of our choosing, since the
 * binding decides on `#{pane_current_command}`; a key that reached it shows as `^[[5~`. */
function describePaging(target: RigTarget, rig: () => RigSession, home: () => string): void {
    const PAGE_UP = '\x1b[5~';
    const OLD_BINDING = `if-shell -F '#{?alternate_on,1,#{?#{m:*sh,#{pane_current_command}},0,1}}' 'send-keys PPage' 'copy-mode -eu'`;
    const ours = (): string => sessionName(HOST, `${home()}/paging`, 0);

    /** `stty raw; exec <a copy of cat named programName> -v` — a pane whose current command
     * is `programName`. Copied once: a running copy cannot be overwritten (ETXTBSY). */
    const inner = (programName: string): string =>
        `mkdir -p "$HOME/pg" && { [ -x "$HOME/pg/${programName}" ] || cp "$(command -v cat)" "$HOME/pg/${programName}"; }`
        + ` && stty raw -echo && exec "$HOME/pg/${programName}" -v`;

    async function paneRuns(session: string, programName: string): Promise<void> {
        await rig().waitUntil(`${session} to run ${programName}`, async () =>
            (await rig().tmux('display-message', '-p', '-t', `=${session}:`, '#{pane_current_command}')).stdout.trim() === programName);
    }

    const inCopyMode = async (session: string): Promise<boolean> =>
        (await rig().tmux('display-message', '-p', '-t', `=${session}:`, '#{pane_in_mode}')).stdout.trim() === '1';

    async function openOurs(programName: string): Promise<PtyClient> {
        const client = await PtyClient.open(target, WORKERS.hardening, RIG_TMUX,
            buildAttachOrCreateArgv(ours(), home(), inner(programName), { tmuxPath: RIG_TMUX, tmuxVersion: target.version }));
        await paneRuns(ours(), programName);
        return client;
    }

    it('PageUp at a shell prompt of OUR session scrolls (copy mode)', async () => {
        const terminal = await openOurs('fakesh');
        try {
            terminal.write(PAGE_UP);

            await rig().waitUntil('copy mode', () => inCopyMode(ours()));
        } finally {
            terminal.close();
        }
    });

    it('PageUp under ssh in our session reaches the program', async () => {
        const terminal = await openOurs('ssh');
        try {
            terminal.write(PAGE_UP);

            await terminal.waitFor(/\^\[\[5~/, 3000);
            expect(await inCopyMode(ours())).toBe(false);
        } finally {
            terminal.close();
        }
    });

    // `main`, and the near misses of our own naming: a short hash, a non-numeric slot, a
    // trailing letter, a leading zero. A loose `code-*` glob took the keys in these too.
    const theirNames = (): string[] =>
        ['main', 'code-a-0', ours().replace(/-0$/, '-x'), ours().replace(/-0$/, '-0x'), ours().replace(/-0$/, '-007')];

    it.each([0, 1, 2, 3, 4])('PageUp at a shell prompt of the USER\'s own session reaches their shell — never our copy mode (name %i)', async index => {
        const theirName = theirNames()[index];
        (await openOurs('fakesh')).close(); // our attach has bound the keys on the shared server
        expect((await rig().tmux('new-session', '-d', '-s', theirName, inner('fakesh'))).code).toBe(0);
        await paneRuns(theirName, 'fakesh');
        const theirs = await PtyClient.open(target, WORKERS.hardening, RIG_TMUX, ['attach-session', '-t', `=${theirName}`]);
        try {
            await rig().waitUntil('their client', async () => (await rig().clientCount(theirName)) === 1);
            theirs.write(PAGE_UP);

            await theirs.waitFor(/\^\[\[5~/, 3000);
            expect(await inCopyMode(theirName)).toBe(false);
        } finally {
            theirs.close();
        }
    });

    /** The chain's own "has the USER bound this key?" test, as the shell runs it: the
     * `if-shell` job of the argv with tmux's `##` escapes undone. Exit 0 = the user has. */
    async function userHasBound(key: string): Promise<boolean> {
        const argv = buildAttachOrCreateArgv(ours(), home(), undefined, { tmuxPath: RIG_TMUX, tmuxVersion: target.version });
        const job = argv.find(arg => arg.includes(`-T root +${key} `) && arg.includes('list-keys'))!;
        return (await rig().run(job.replace(/##/g, '#'))).code === 0;
    }

    // Our own binding is told from the user's by its COMPLETE predicate as `list-keys`
    // prints it back on this tmux version — which is only true if tmux prints it verbatim.
    it('recognises its own current binding as ours, on this version\'s list-keys output', async () => {
        (await openOurs('fakesh')).close();

        expect(await userHasBound('PPage')).toBe(false);
        expect(await userHasBound('NPage')).toBe(false);
    });

    // Our exact predicate, the user's own actions (they copied ours and changed what it does):
    // it is not our binding, and matching the predicate alone overwrote it.
    it('a user\'s binding that reuses our predicate with their own actions is left exactly as they made it', async () => {
        expect((await rig().tmux('new-session', '-d', '-s', 'main')).code).toBe(0);
        const argv = buildAttachOrCreateArgv(ours(), home(), undefined, { tmuxPath: RIG_TMUX, tmuxVersion: target.version });
        const theirs = argv.find(arg => arg.startsWith('bind-key -n PPage '))!.replace(`'copy-mode -eu'`, `'copy-mode -u'`);
        expect(theirs).toContain(`'copy-mode -u'`);
        expect((await rig().run(`${RIG_TMUX} ${theirs}`)).code).toBe(0);
        const pageUp = async (): Promise<string[]> =>
            (await rig().tmux('list-keys', '-T', 'root')).stdout.split('\n').filter(line => /PPage/.test(line));
        const before = await pageUp();
        expect(before).toHaveLength(1);
        expect(await userHasBound('PPage')).toBe(true);

        (await openOurs('fakesh')).close();

        expect(await pageUp()).toEqual(before);
        // PageDown was unbound, so that one is ours now — the two keys are decided apart.
        expect(await userHasBound('NPage')).toBe(false);
        expect((await rig().tmux('list-keys', '-T', 'root')).stdout).toMatch(/NPage.*session_name/);
    });

    // A user's own binding built the same way ours starts — test `alternate_on`, pass the key
    // or scroll — carried the substring an earlier check looked for, and was overwritten.
    it('a user\'s own binding that also tests alternate_on is left exactly as they made it', async () => {
        expect((await rig().tmux('new-session', '-d', '-s', 'main')).code).toBe(0);
        const theirs = `if-shell -F '#{?alternate_on,1,0}' 'send-keys PPage' 'copy-mode -eu'`;
        expect((await rig().run(`${RIG_TMUX} bind-key -n PPage ${theirs}`)).code).toBe(0);
        expect((await rig().run(`${RIG_TMUX} bind-key -n NPage if-shell -F '#{?alternate_on,1,0}' 'send-keys NPage'`)).code).toBe(0);
        const before = (await rig().tmux('list-keys', '-T', 'root')).stdout.split('\n').filter(line => /Page/.test(line)).sort();
        expect(await userHasBound('PPage')).toBe(true);

        (await openOurs('fakesh')).close();

        const after = (await rig().tmux('list-keys', '-T', 'root')).stdout.split('\n').filter(line => /Page/.test(line)).sort();
        expect(after).toEqual(before);
        expect(after.join('\n')).not.toContain('session_name');
    });

    // A long-lived server still carries the binding an earlier version made, which has no
    // session guard. It is ours to replace; a binding the user made is not (04c, above).
    it('an attach replaces the unguarded binding an earlier version left on the server', async () => {
        expect((await rig().tmux('new-session', '-d', '-s', 'main', inner('fakesh'))).code).toBe(0);
        expect((await rig().run(`${RIG_TMUX} bind-key -n PPage ${OLD_BINDING}`)).code).toBe(0);
        expect((await rig().tmux('list-keys', '-T', 'root')).stdout).not.toMatch(/PPage.*session_name/);

        (await openOurs('fakesh')).close();

        expect((await rig().tmux('list-keys', '-T', 'root')).stdout).toMatch(/PPage.*session_name/);
    });
}

/** Bytes typed into the terminal must reach the program inside unmodified and promptly:
 * the inner program is `cat -v` on a raw tty, so a byte shows up as its caret form. */
function describeKeys(target: RigTarget, rig: () => RigSession, home: () => string): void {
    const INNER = 'stty raw -echo; exec cat -v';

    async function openTerminal(): Promise<PtyClient> {
        const name = sessionName(HOST, `${home()}/keys`, 0);
        const client = await PtyClient.open(target, WORKERS.hardening, RIG_TMUX,
            buildAttachOrCreateArgv(name, home(), INNER, { tmuxPath: RIG_TMUX, tmuxVersion: target.version }));
        await rig().waitUntil('the pane to run cat', async () =>
            (await rig().tmux('display-message', '-p', '-t', name, '#{pane_current_command}')).stdout.trim() === 'cat');
        return client;
    }

    it('(04d) Ctrl-B reaches the program inside (no tmux prefix)', async () => {
        const terminal = await openTerminal();
        try {
            terminal.write('\x02z');

            await terminal.waitFor(/\^Bz/, 2000);
        } finally {
            terminal.close();
        }
    });

    // tmux holds a lone Esc for `escape-time` to tell it from an Alt- sequence: 500 ms by
    // default before 3.5 (the chain lowers that default to 10 ms), 10 ms from 3.5. From 3.6
    // the delay is also stretched to 500 ms while tmux's own queries to the outer terminal
    // are unanswered (CHANGES 3.6: "extended escape-time"), and this rig's bare pty answers
    // none — measured 500 ms on 3.8 even with `escape-time 0`. That is a rig artefact (a real
    // xterm.js answers the queries), so 3.6+ stays an expected failure here. Measured against
    // an ordinary key so link latency cancels out.
    const escFast = !versionAtLeast(target.version, '3.6');
    (escFast ? it : it.fails)(`(04d) Esc reaches the program within 50 ms of a normal key`, async () => {
        const terminal = await openTerminal();
        try {
            const started = Date.now();
            terminal.write('a');
            await terminal.waitFor(/a/, 2000);
            const plain = Date.now() - started;
            const escStarted = Date.now();
            terminal.write('\x1b');
            await terminal.waitFor(/\^\[/, 2000);
            const esc = Date.now() - escStarted;

            expect(esc - plain, `Esc took ${esc} ms, a plain key ${plain} ms`).toBeLessThan(50);
        } finally {
            terminal.close();
        }
    });
}
