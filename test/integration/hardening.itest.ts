import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { escapeShellArg } from '../../src/common/shellQuote';
import { probeTmux } from '../../src/tmux/tmuxBootstrap';
import { AttachOrCreateOptions, buildAttachOrCreateArgv, sessionName } from '../../src/tmux/tmuxSession';
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

    describeKeys(target, () => rig, () => home);
});

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
