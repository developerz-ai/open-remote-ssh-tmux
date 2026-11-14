import { describe, expect, it, vi } from 'vitest';
import { createCloseWatch } from '../../src/tmux/remoteExec';

// Bug A: a closing window cannot reach the remote itself (VS Code kills the extension host
// within milliseconds of "terminate"), so the remote is told by the one thing that does
// happen reliably — the window's SSH connection dropping. The watch is a remote command that
// sits on that connection until it ends; this collaborator only makes sure each connection
// carries exactly one.

const COMMAND = 'sh -c watch';

type Run = (connection: object, command: string) => Promise<unknown>;

function setup(current: () => object | undefined, run = vi.fn<Run>(() => new Promise<unknown>(() => { /* open until the connection ends */ }))) {
    const log = { trace: vi.fn() };
    const watch = createCloseWatch({ current, run, log });
    return { ensure: (): void => watch(COMMAND), run, log };
}

describe('createCloseWatch', () => {
    it('starts the watch on the current connection', () => {
        const connection = {};
        const { ensure, run } = setup(() => connection);

        ensure();

        expect(run).toHaveBeenCalledTimes(1);
        expect(run).toHaveBeenCalledWith(connection, COMMAND);
    });

    // A reconnect of the same window calls it again; a second watch on one connection would
    // only be a second process waiting for the same EOF.
    it('starts it once per connection', () => {
        const connection = {};
        const { ensure, run } = setup(() => connection);

        ensure();
        ensure();

        expect(run).toHaveBeenCalledTimes(1);
    });

    it('starts a fresh one when the window is on a new connection (reconnect)', () => {
        let connection = {};
        const { ensure, run } = setup(() => connection);

        ensure();
        connection = {};
        ensure();

        expect(run).toHaveBeenCalledTimes(2);
        expect(run.mock.calls[1][0]).toBe(connection);
    });

    it('does nothing while there is no connection', () => {
        const { ensure, run } = setup(() => undefined);

        ensure();

        expect(run).not.toHaveBeenCalled();
    });

    it('logs a watch that could not start, and never throws', async () => {
        const run = vi.fn(async () => {
            throw new Error('channel open failure');
        });
        const { ensure, log } = setup(() => ({}), run);

        expect(() => ensure()).not.toThrow();
        await new Promise(res => setTimeout(res, 0));

        expect(log.trace).toHaveBeenCalledWith(expect.stringContaining('channel open failure'));
    });

    it('never throws when starting it throws synchronously', () => {
        const run = vi.fn((): Promise<unknown> => {
            throw new Error('not connected');
        });
        const { ensure, log } = setup(() => ({}), run);

        expect(() => ensure()).not.toThrow();
        expect(log.trace).toHaveBeenCalledWith(expect.stringContaining('not connected'));
    });
});
