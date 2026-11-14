import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { buildListSessions, isOurSession, parseListSessions, sessionName } from '../../src/tmux/tmuxSession';
import { describeRig, RigSession, SHELL_USERS } from './rig';

// `parseListSessions` over what a real server prints for `buildListSessions()` — sent
// through the production exec under every login shell (the `-F` format is full of `#{…}`,
// which each shell must pass through untouched). The user's own sessions sit next to ours
// and must never be classed as ours: `isOurSession` is the reaper's kill permit.

const OURS = sessionName('rig-host', '/srv/proj', 0);
const CORPSE = sessionName('rig-host', '/srv/proj', 1);
const FOREIGN = ['dev', 'main', 'code-notes', 'code', 'my notes'];

describeRig('list-sessions parsing (real tmux, every login shell)', target => {
    const sessions = new Map<string, RigSession>();

    beforeAll(async () => {
        for (const user of SHELL_USERS) {
            sessions.set(user, await RigSession.open(target, user));
        }
    });

    afterAll(async () => {
        for (const session of sessions.values()) {
            await session.resetTmux();
            await session.close();
        }
    });

    beforeEach(async () => {
        for (const session of sessions.values()) {
            await session.resetTmux();
        }
    });

    for (const user of SHELL_USERS) {
        it(`${user}: parses every row; only the code-<hash>-<slot> sessions are ours`, async () => {
            const rig = sessions.get(user)!;
            for (const name of [...FOREIGN, OURS]) {
                expect((await rig.tmux('new-session', '-d', '-s', name)).code).toBe(0);
            }
            // A corpse: the pane's process exited but `remain-on-exit` keeps the session.
            expect((await rig.tmux('new-session', '-d', '-s', CORPSE, 'sleep 3600')).code).toBe(0);
            expect((await rig.tmux('set-window-option', '-t', CORPSE, 'remain-on-exit', 'on')).code).toBe(0);
            await rig.ok(`pkill -u "$(id -u)" -x sleep`);
            await rig.waitUntil('the corpse pane to die', async () =>
                (await rig.tmux('display-message', '-p', '-t', CORPSE, '#{pane_dead}')).stdout.trim() === '1');

            const parsed = parseListSessions((await rig.rawExec(buildListSessions())).stdout);

            const byName = new Map(parsed.map(row => [row.name, row]));
            expect([...byName.keys()].sort()).toEqual([...FOREIGN, OURS, CORPSE].sort());
            for (const name of FOREIGN) {
                expect(isOurSession(name), name).toBe(false);
            }
            expect(isOurSession(OURS)).toBe(true);
            expect(byName.get(OURS)).toMatchObject({ attached: false, windows: 1, paneDead: false });
            expect(byName.get(CORPSE)).toMatchObject({ attached: false, windows: 1, paneDead: true });
            expect(byName.get(OURS)!.createdEpoch).toBeGreaterThan(1_700_000_000);
        });
    }

    it('no server running parses as zero sessions', async () => {
        const rig = sessions.get('u-bash')!;

        const { stdout } = await rig.rawExec(buildListSessions());

        expect(parseListSessions(stdout)).toEqual([]);
    });
});
