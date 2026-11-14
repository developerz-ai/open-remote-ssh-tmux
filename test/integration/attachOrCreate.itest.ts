import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { escapeShellArg } from '../../src/common/shellQuote';
import { AttachOrCreateOptions, buildAttachOrCreateArgv, sessionName } from '../../src/tmux/tmuxSession';
import { describeRig, RIG_TMUX, RigSession, WORKERS } from './rig';

// The exact production argv (`buildAttachOrCreateArgv`, what VS Code execs as
// `shellPath tmux` + `shellArgs`) run by a real tmux client on a real pty. This is the
// check that would have caught the `=name` vs `=name:` target bug: every option the chain
// sets is read back from the live server, not from the argv.

const HOST = 'rig-host';

describeRig('attach-or-create argv (real tmux)', target => {
    let rig: RigSession;
    let home: string;

    beforeAll(async () => {
        rig = await RigSession.open(target, WORKERS.attachOrCreate);
        home = await rig.ok('printf %s "$HOME"');
    });

    afterAll(async () => {
        await rig.resetTmux();
        await rig.close();
    });

    beforeEach(async () => {
        await rig.resetTmux();
    });

    /** Launch the production argv the way VS Code's pty host would; wait for the client. */
    async function launch(name: string, cwd: string, opts: AttachOrCreateOptions = {}): Promise<number> {
        const pid = await rig.spawnHeldClient(RIG_TMUX, buildAttachOrCreateArgv(name, cwd, undefined, opts));
        await rig.waitUntil(`a client on ${name}`, async () => (await rig.clientCount(name)) >= 1);
        return pid;
    }

    async function panePid(name: string): Promise<string> {
        return (await rig.tmux('display-message', '-p', '-t', name, '#{pane_pid}')).stdout.trim();
    }

    it('creates the session, and a second launch re-attaches it (one session, same process)', async () => {
        const name = sessionName(HOST, `${home}/proj`, 0);
        await rig.ok(`mkdir -p "$HOME/proj"`);

        const first = await launch(name, `${home}/proj`);
        const pidBefore = await panePid(name);
        expect(await rig.sessionNames()).toEqual([name]);

        await rig.closeHeldClient(first);
        await rig.waitUntil('the first client to detach', async () => (await rig.clientCount(name)) === 0);
        await launch(name, `${home}/proj`);

        expect(await rig.sessionNames()).toEqual([name]);
        expect(await panePid(name)).toBe(pidBefore);
    });

    it('applies status off, mouse on and the configured history-limit to the live pane', async () => {
        const name = sessionName(HOST, home, 0);

        await launch(name, home, { historyLimit: 1234 });

        expect((await rig.tmux('show-options', '-t', name, 'status')).stdout.trim()).toBe('status off');
        expect((await rig.tmux('show-options', '-t', name, 'mouse')).stdout.trim()).toBe('mouse on');
        expect((await rig.tmux('display-message', '-p', '-t', name, '#{history_limit}')).stdout.trim()).toBe('1234');
        expect((await rig.tmux('show-window-options', '-t', name, 'remain-on-exit')).stdout.trim()).toBe('remain-on-exit off');
    });

    const awkwardDirs: ReadonlyArray<readonly [string, string]> = [
        ['a space', 'with space'],
        ['a single quote', `it's`],
        ['a double quote', 'say "hi"'],
        ['a dollar', '$HOME and $(id)'],
        ['unicode', 'ünïcødé ✓ 日本'],
        ['a newline', 'line\nbreak'],
    ];
    for (const [label, dir] of awkwardDirs) {
        it(`starts the shell in a cwd containing ${label}, byte for byte`, async () => {
            const cwd = `${home}/${dir}`;
            await rig.ok(`mkdir -p ${escapeShellArg(cwd)}`);
            const name = sessionName(HOST, cwd, 0);

            await launch(name, cwd);

            const pid = await panePid(name);
            const check = await rig.run(`[ "$(readlink /proc/${pid}/cwd)" = ${escapeShellArg(cwd)} ]`);
            expect(check.code, `pane cwd: ${(await rig.run(`readlink /proc/${pid}/cwd`)).stdout}`).toBe(0);
        });
    }
});
