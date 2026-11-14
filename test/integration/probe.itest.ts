import { afterAll, beforeAll, expect, it } from 'vitest';
import { probeTmux } from '../../src/tmux/tmuxBootstrap';
import { describeRig, RIG_TMUX, RigSession, SHELL_USERS } from './rig';

// `probeTmux` against real tmux under every login shell a remote might run. The probe is
// wrapped in `sh -c` precisely because csh/tcsh lack `command`; fish and zsh differ again
// in quoting. Each shell must yield the same verdict: available, real version, absolute
// path (the terminal's `shellPath` — a bare `tmux` misses off-PATH installs).

describeRig('probeTmux (real tmux, every login shell)', target => {
    const sessions = new Map<string, RigSession>();

    beforeAll(async () => {
        for (const user of SHELL_USERS) {
            sessions.set(user, await RigSession.open(target, user));
        }
    });

    afterAll(async () => {
        for (const session of sessions.values()) {
            await session.close();
        }
    });

    for (const user of SHELL_USERS) {
        it(`${user}: available, version ${target.version}, absolute path`, async () => {
            const capability = await probeTmux(sessions.get(user)!.rawExec, 'linux');

            expect(capability).toEqual({ available: true, version: target.version, path: RIG_TMUX });
        });
    }
});
