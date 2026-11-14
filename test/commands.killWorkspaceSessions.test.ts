import { beforeEach, describe, expect, it, vi } from 'vitest';
import { KILL_SESSIONS_CONFIRM_LABEL, killWorkspaceSessions, type WorkspaceKillTarget } from '../src/commands';
import { messageResponses, shownMessages } from './mocks/vscode';

/** Terminology check: the confirm/result messages must stay operator-facing
 * ("persistent terminal sessions"), never leak the implementation detail
 * ("tmux") to the user. */
const TMUX_JARGON = /tmux/i;

// The kill command is the manual zombie escape hatch (docs/idea/tmux-approach.md):
// a modal confirm, then delegate the force-kill to the reaper. This handler is thin
// — it owns no tmux/session logic — so these tests pin exactly the branching that is
// its responsibility: confirm -> delegate, cancel -> nothing, no remote -> no-op.

const HOST = 'example.com';
const WS = '/home/user/proj';

/** What the reaper reports back: kill counts, or `undefined` when it could not list. */
type Outcome = { killed: number; failed: number } | undefined;

/** A target whose reaper records how it was invoked. */
function fakeTarget(outcome: Outcome = { killed: 3, failed: 0 }) {
    const kill = vi.fn(async (): Promise<Outcome> => outcome);
    const target: WorkspaceKillTarget = { reaper: { killWorkspaceSessions: kill }, hostKey: HOST, workspaceKey: WS };
    return { target, kill };
}

beforeEach(() => {
    messageResponses.warning = undefined;
    shownMessages.warning.length = 0;
    shownMessages.information.length = 0;
    shownMessages.error.length = 0;
});

describe('killWorkspaceSessions command handler', () => {
    it('force-kills this workspace, keyed to (host, workspace), after the user confirms', async () => {
        const { target, kill } = fakeTarget();
        messageResponses.warning = KILL_SESSIONS_CONFIRM_LABEL; // user clicks the confirm button

        await killWorkspaceSessions(() => target);

        expect(shownMessages.warning).toHaveLength(1); // a confirm dialog was shown
        expect(kill).toHaveBeenCalledWith(HOST, WS);
    });

    it('does nothing when the user dismisses/cancels the confirm', async () => {
        const { target, kill } = fakeTarget();
        messageResponses.warning = undefined; // dialog dismissed

        await killWorkspaceSessions(() => target);

        expect(shownMessages.warning).toHaveLength(1);
        expect(kill).not.toHaveBeenCalled();
    });

    it('no-ops without a confirm dialog when not connected to a remote', async () => {
        await killWorkspaceSessions(() => undefined);

        expect(shownMessages.warning).toHaveLength(0);
        expect(shownMessages.information).toHaveLength(1); // told the user why nothing happened
    });

    it('surfaces a plain-language error instead of an unhandled rejection when the reaper call rejects', async () => {
        const kill = vi.fn(async () => {
            throw new Error('ssh channel closed');
        });
        const target: WorkspaceKillTarget = { reaper: { killWorkspaceSessions: kill }, hostKey: HOST, workspaceKey: WS };
        messageResponses.warning = KILL_SESSIONS_CONFIRM_LABEL;

        await expect(killWorkspaceSessions(() => target)).resolves.toBeUndefined();

        expect(shownMessages.error).toHaveLength(1);
        expect(shownMessages.information).toHaveLength(0); // no false "killed N" success message
        expect(String(shownMessages.error[0][0])).not.toMatch(TMUX_JARGON);
    });

    it('reports the number actually killed', async () => {
        const { target } = fakeTarget({ killed: 3, failed: 0 });
        messageResponses.warning = KILL_SESSIONS_CONFIRM_LABEL;

        await killWorkspaceSessions(() => target);

        expect(shownMessages.information).toHaveLength(1);
        expect(String(shownMessages.information[0][0])).toContain('Killed 3 ');
    });

    it('says how many could not be killed instead of claiming success for them', async () => {
        const { target } = fakeTarget({ killed: 1, failed: 2 });
        messageResponses.warning = KILL_SESSIONS_CONFIRM_LABEL;

        await killWorkspaceSessions(() => target);

        expect(shownMessages.information).toHaveLength(0);
        expect(shownMessages.warning).toHaveLength(2); // the confirm, then the partial result
        const message = String(shownMessages.warning[1][0]);
        expect(message).toContain('Killed 1 ');
        expect(message).toContain('2 ');
        expect(message).not.toMatch(TMUX_JARGON);
    });

    it('reports an error, not "killed 0", when the sessions could not be listed', async () => {
        const unreachable: Outcome = undefined;
        const target: WorkspaceKillTarget = {
            reaper: { killWorkspaceSessions: vi.fn(async () => unreachable) },
            hostKey: HOST,
            workspaceKey: WS,
        };
        messageResponses.warning = KILL_SESSIONS_CONFIRM_LABEL;

        await killWorkspaceSessions(() => target);

        expect(shownMessages.information).toHaveLength(0);
        expect(shownMessages.error).toHaveLength(1);
        expect(String(shownMessages.error[0][0])).not.toMatch(TMUX_JARGON);
    });
});
