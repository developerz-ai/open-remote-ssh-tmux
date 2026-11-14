import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { probeTmux } from '../../src/tmux/tmuxBootstrap';
import { SLOT_MAPPING_STATE_KEY } from '../../src/tmux/terminalProvider';
import { sessionName } from '../../src/tmux/tmuxSession';
import { describeRig, RigSession, WORKERS } from './rig';
import { MachineState, RigWindow } from './window';

// Remote exec under failure: a remote that cannot answer must never hang the connect and
// must never be read as "your sessions are gone". The spec slice 02 (02-exec-deadlines.md)
// turns green — tagged (02).
//
// Not covered: a client/server *protocol version mismatch*. Every matrix release (2.6 to
// 3.8) speaks PROTOCOL_VERSION 8, so no pair of rig binaries can produce it.

const CTX = { hostKey: 'rig-host', workspaceKey: '/home/w6', cwd: '/home/w6' };

describeRig('remote exec deadlines and failure classification (real tmux)', target => {
    let rig: RigSession;

    beforeAll(async () => {
        rig = await RigSession.open(target, WORKERS.deadlines);
    });

    afterAll(async () => {
        await rig.resetTmux();
        await rig.close();
    });

    beforeEach(async () => {
        await rig.run('chmod 0700 "/tmp/tmux-$(id -u)/default" 2>/dev/null; true');
        await rig.resetTmux();
    });

    it('(02) an unreachable tmux socket keeps the slot mapping and opens no terminal', async () => {
        const name = sessionName(CTX.hostKey, CTX.workspaceKey, 0);
        expect((await rig.tmux('new-session', '-d', '-s', name)).code).toBe(0);
        const machine = new MachineState();
        await machine.update(SLOT_MAPPING_STATE_KEY, { 0: name });
        // The server is alive but this client cannot reach it: tmux answers
        // "error connecting to /tmp/tmux-<uid>/default (Permission denied)".
        await rig.ok('chmod 0000 "/tmp/tmux-$(id -u)/default"');
        try {
            const window = new RigWindow(rig, machine, CTX);

            await window.connect();

            expect(window.provider.mappedSlots()).toEqual([0]);
            expect(window.opened).toEqual([]);
        } finally {
            await rig.ok('chmod 0700 "/tmp/tmux-$(id -u)/default"');
        }
        expect(await rig.sessionNames()).toEqual([name]);
    });

    it('(02) the tmux probe settles within its deadline when the sshd serving it is SIGSTOPped', async () => {
        const victim = await RigSession.open(target, WORKERS.deadlines);
        // `$PPID` of the login shell running the exec is this connection's sshd process.
        const sshdPid = Number((await victim.rawExec('echo $PPID')).stdout.trim());
        expect(sshdPid).toBeGreaterThan(1);
        await rig.ok(`kill -STOP ${sshdPid}`);
        try {
            const started = Date.now();
            const settled = await Promise.race([
                probeTmux(victim.rawExec, 'linux').then(capability => capability.available),
                new Promise<'hung'>(resolve => setTimeout(() => resolve('hung'), 15_000)),
            ]);

            expect(settled, 'probeTmux never settled').toBe(false);
            expect(Date.now() - started).toBeLessThan(10_000);
        } finally {
            await rig.ok(`kill -CONT ${sshdPid}`);
            await victim.close();
        }
    });

    it('(02) a tmux command settles within its deadline when the sshd serving it is SIGSTOPped', async () => {
        const victim = await RigSession.open(target, WORKERS.deadlines);
        const sshdPid = Number((await victim.rawExec('echo $PPID')).stdout.trim());
        await rig.ok(`kill -STOP ${sshdPid}`);
        try {
            const started = Date.now();
            const settled = await Promise.race([
                victim.exec('tmux list-sessions').then(() => 'resolved', () => 'rejected'),
                new Promise<'hung'>(resolve => setTimeout(() => resolve('hung'), 15_000)),
            ]);

            expect(settled).toBe('rejected');
            expect(Date.now() - started).toBeLessThan(12_000);
        } finally {
            await rig.ok(`kill -CONT ${sshdPid}`);
            await victim.close();
        }
    });
});
