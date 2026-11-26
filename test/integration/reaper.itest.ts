import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { SessionReaper } from '../../src/tmux/sessionReaper';
import type { RemoteExec } from '../../src/tmux/remoteExec';
import { buildAttachOrCreateArgv, buildListSessions, parseListSessions, sessionName } from '../../src/tmux/tmuxSession';
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

        // The corpse is killed; the live detached one is a recent orphan — kept, counted.
        expect(reaped).toEqual({ killed: 1, orphansKept: 2, orphansTotal: 2 });
        expect((await rig.sessionNames()).sort()).toEqual(
            ['dev', 'main', 'dead-but-foreign', LIVE_DETACHED, ATTACHED, SIBLING].sort(),
        );
        expect(await rig.clientCount(ATTACHED)).toBe(1);
    });

    it('reap() inside the grace window kills nothing', async () => {
        const reaper = new SessionReaper({ exec: rig.exec, now: () => Math.floor(Date.now() / 1000), log: silentLog, minAgeSeconds: 3600 });

        expect((await reaper.reap()).killed).toBe(0);
        expect(await rig.sessionNames()).toHaveLength(7);
    });

    it('killWorkspaceSessions() kills this workspace only — never a sibling or the user\'s', async () => {
        const reaper = new SessionReaper({ exec: rig.exec, now: () => Math.floor(Date.now() / 1000), log: silentLog });

        const outcome = await reaper.killWorkspaceSessions([{ hostKey: HOST, workspaceKey: WS }]);

        expect(outcome).toEqual({ killed: 3, failed: 0 });
        expect((await rig.sessionNames()).sort()).toEqual(['dev', 'main', 'dead-but-foreign', SIBLING].sort());
    });
});

describeRig('SessionReaper orphan aging (real tmux, 05)', target => {
    let rig: RigSession;
    const DAY = 86400;
    const realNow = (): number => Math.floor(Date.now() / 1000);

    beforeAll(async () => {
        rig = await RigSession.open(target, WORKERS.reaper);
    });

    afterAll(async () => {
        await rig.resetTmux();
        await rig.close();
    });

    beforeEach(async () => {
        await rig.resetTmux();
        for (const name of ['main', LIVE_DETACHED, SIBLING]) {
            expect((await rig.tmux('new-session', '-d', '-s', name)).code).toBe(0);
        }
        await rig.spawnHeldClient(RIG_TMUX, buildAttachOrCreateArgv(ATTACHED, '/'));
        await rig.waitUntil('the attached session', async () => (await rig.clientCount(ATTACHED)) === 1);
    });

    /** `rig.exec` with the REMOTE clock the list command reports moved `seconds` ahead.
     * Waiting 14 days is not an option, and the reaper ages on the remote's clock, so that
     * is the clock that moves; every other byte is what the real server printed. */
    const remoteClockAhead = (seconds: number): RemoteExec => async command => {
        const result = await rig.exec(command);
        return { ...result, stdout: result.stdout.replace(/^__now (\d+)$/m, (_line, now: string) => `__now ${Number(now) + seconds}`) };
    };

    // The sessions' real `#{session_activity}` / `#{window_activity}` are read from tmux and
    // compared against a remote "now" fifteen days ahead. What this proves on every tmux
    // version is that the fields are read (missing ones would keep everything) and that only
    // detached sessions of ours go.
    it('ages out detached sessions of ours; never the attached one or the user\'s', async () => {
        const reaper = new SessionReaper({ exec: remoteClockAhead(15 * DAY), now: realNow, log: silentLog, orphanMaxAgeDays: 14 });

        expect(await reaper.reap()).toEqual({ killed: 2, orphansKept: 0, orphansTotal: 2 });
        expect((await rig.sessionNames()).sort()).toEqual(['main', ATTACHED].sort());
        expect(await rig.clientCount(ATTACHED)).toBe(1);
    });

    it('keeps them while they are younger than the limit, and when aging is off', async () => {
        const recent = new SessionReaper({ exec: remoteClockAhead(13 * DAY), now: realNow, log: silentLog, orphanMaxAgeDays: 14 });
        expect(await recent.reap()).toEqual({ killed: 0, orphansKept: 2, orphansTotal: 2 });

        const off = new SessionReaper({ exec: remoteClockAhead(400 * DAY), now: realNow, log: silentLog, orphanMaxAgeDays: 0 });
        expect(await off.reap()).toEqual({ killed: 0, orphansKept: 2, orphansTotal: 2 });
        expect(await rig.sessionNames()).toHaveLength(4);
    });

    it('never ages out a session the window is about to restore', async () => {
        const reaper = new SessionReaper({ exec: remoteClockAhead(15 * DAY), now: realNow, log: silentLog, orphanMaxAgeDays: 14 });

        expect((await reaper.reap({ protect: [LIVE_DETACHED] })).killed).toBe(1);
        expect(await rig.sessionNames()).toContain(LIVE_DETACHED);
    });

    // The rows' epochs are the remote's, so the local clock has no say: a laptop whose clock
    // runs 20 days ahead used to reap sessions that were minutes old.
    it('a local clock 20 days ahead reaps nothing — ages are measured on the remote clock', async () => {
        const reaper = new SessionReaper({ exec: rig.exec, now: () => realNow() + 20 * DAY, log: silentLog, orphanMaxAgeDays: 14 });

        expect(await reaper.reap()).toEqual({ killed: 0, orphansKept: 2, orphansTotal: 2 });
        expect(await rig.sessionNames()).toHaveLength(4);
    });

    // The reason this fork exists: a long task left running detached. `#{session_activity}`
    // only moves on client input and attach, so a task that prints for weeks and is never
    // typed into looked idle since the day it was started — and was reaped. The age is taken
    // from the later of that and `#{window_activity}`, which output does move.
    //
    // In WHICHEVER window: a row's own `#{window_activity}` is the session's current window
    // only, and a program in the pane can open a second one (`tmux new-window -d`) and print
    // there while the current window sits idle.
    it.each(['current', 'background'] as const)('a detached session still printing in its %s window is not idle, however long ago it was last typed into', async where => {
        const busy = sessionName(HOST, WS, 5);
        const printer = 'while :; do date; sleep 0.2; done';
        if (where === 'current') {
            expect((await rig.tmux('new-session', '-d', '-s', busy, printer)).code).toBe(0);
        } else {
            expect((await rig.tmux('new-session', '-d', '-s', busy)).code).toBe(0);
            expect((await rig.tmux('new-window', '-d', '-t', `=${busy}:`, printer)).code).toBe(0);
            // The idle shell's window is still the current one.
            expect((await rig.tmux('display-message', '-p', '-t', `=${busy}:`, '#{window_index} #{pane_current_command}')).stdout.trim())
                .toMatch(/^0 \S*sh$/);
        }
        const row = async (): Promise<{ input: number; latest: number }> => {
            const { stdout } = await rig.exec(buildListSessions(RIG_TMUX));
            const input = Number(new RegExp(`^${busy} .* a:(\\d+) `, 'm').exec(stdout)?.[1]);
            return { input, latest: parseListSessions(stdout).find(session => session.name === busy)!.activityEpoch! };
        };
        // Output moves the session's age forward; nobody typing leaves `a:` where it was.
        await rig.waitUntil('output to outrun the last input by 6 s', async () => {
            const { input, latest } = await row();
            return latest - input >= 6;
        }, 20_000);

        // Three seconds short of 14 days after "now": by input alone the session has been
        // idle for 14 days and 3 s (reaped); by its output, 14 days less 3 s (kept).
        const reaper = new SessionReaper({ exec: remoteClockAhead(14 * DAY - 3), now: realNow, log: silentLog, orphanMaxAgeDays: 14 });
        await reaper.reap({ protect: [LIVE_DETACHED, SIBLING] });

        expect(await rig.sessionNames()).toContain(busy);
    });
});
