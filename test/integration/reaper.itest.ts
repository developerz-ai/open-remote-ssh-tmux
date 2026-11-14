import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { SessionReaper } from '../../src/tmux/sessionReaper';
import { buildAttachOrCreateArgv, sessionName } from '../../src/tmux/tmuxSession';
import { describeRig, RIG_TMUX, RigSession, WORKERS } from './rig';

// `SessionReaper` against a real server holding every kind of session it can meet. Its
// one job is to remove our dead, detached corpses; everything else — the user's own
// sessions (even dead ones), a detached session with a live process (a long Claude Code
// run, the reason this fork exists), an attached one — must survive.

const HOST = 'rig-host';
const WS = '/srv/proj';
const LIVE_DETACHED = sessionName(HOST, WS, 0);
const ATTACHED = sessionName(HOST, WS, 1);
const CORPSE = sessionName(HOST, WS, 2);
const SIBLING = sessionName(HOST, '/srv/other', 0);

const silentLog = { info: (): void => undefined, trace: (): void => undefined };

describeRig('SessionReaper (real tmux)', target => {
    let rig: RigSession;

    beforeAll(async () => {
        rig = await RigSession.open(target, WORKERS.reaper);
    });

    afterAll(async () => {
        await rig.resetTmux();
        await rig.close();
    });

    beforeEach(async () => {
        await rig.resetTmux();
        for (const name of ['dev', 'main', LIVE_DETACHED, SIBLING]) {
            expect((await rig.tmux('new-session', '-d', '-s', name)).code).toBe(0);
        }
        // Dead panes kept by remain-on-exit: one of ours, one of the user's.
        for (const name of [CORPSE, 'dead-but-foreign']) {
            expect((await rig.tmux('new-session', '-d', '-s', name, 'sleep 3600')).code).toBe(0);
            expect((await rig.tmux('set-window-option', '-t', name, 'remain-on-exit', 'on')).code).toBe(0);
        }
        await rig.ok(`pkill -u "$(id -u)" -x sleep`);
        for (const name of [CORPSE, 'dead-but-foreign']) {
            await rig.waitUntil(`${name} pane to die`, async () =>
                (await rig.tmux('display-message', '-p', '-t', name, '#{pane_dead}')).stdout.trim() === '1');
        }
        await rig.spawnHeldClient(RIG_TMUX, buildAttachOrCreateArgv(ATTACHED, '/'));
        await rig.waitUntil('the attached session', async () => (await rig.clientCount(ATTACHED)) === 1);
    });

    it('reap() kills only our dead detached corpse', async () => {
        const reaper = new SessionReaper({ exec: rig.exec, now: () => Math.floor(Date.now() / 1000), log: silentLog, minAgeSeconds: 0 });

        const reaped = await reaper.reap();

        expect(reaped).toBe(1);
        expect((await rig.sessionNames()).sort()).toEqual(
            ['dev', 'main', 'dead-but-foreign', LIVE_DETACHED, ATTACHED, SIBLING].sort(),
        );
        expect(await rig.clientCount(ATTACHED)).toBe(1);
    });

    it('reap() inside the grace window kills nothing', async () => {
        const reaper = new SessionReaper({ exec: rig.exec, now: () => Math.floor(Date.now() / 1000), log: silentLog, minAgeSeconds: 3600 });

        expect(await reaper.reap()).toBe(0);
        expect(await rig.sessionNames()).toHaveLength(7);
    });

    it('killWorkspaceSessions() kills this workspace only — never a sibling or the user\'s', async () => {
        const reaper = new SessionReaper({ exec: rig.exec, now: () => Math.floor(Date.now() / 1000), log: silentLog });

        const outcome = await reaper.killWorkspaceSessions(HOST, WS);

        expect(outcome).toEqual({ killed: 3, failed: 0 });
        expect((await rig.sessionNames()).sort()).toEqual(['dev', 'main', 'dead-but-foreign', SIBLING].sort());
    });
});
