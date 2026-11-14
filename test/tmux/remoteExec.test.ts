import { afterEach, describe, expect, it, vi } from 'vitest';
import { DeadlineError } from '../../src/common/deadline';
import { createRemoteExec, parseExitCode, wrapWithExitCode } from '../../src/tmux/remoteExec';

// `SSHConnection#exec` (upstream, unchanged) resolves only on stream close and surfaces no
// exit code. The tmux layer's runner adds both without touching that signature: a deadline
// around the raw call, and an exit-code marker printed by the remote shell after the command.

const MARKER_LINE = (code: number): string => `\n__rc=${code}\n`;

afterEach(() => {
    vi.useRealTimers();
});

describe('wrapWithExitCode', () => {
    it('runs the command under POSIX sh with a trailing exit-code marker', () => {
        expect(wrapWithExitCode('tmux ls')).toBe(`sh -c 'tmux ls; printf '\\''\\n__rc=%s\\n'\\'' "$?"'`);
    });

    it('keeps an already-quoted argument inert (single quotes re-escaped)', () => {
        const wrapped = wrapWithExitCode(`tmux has-session -t ='a;b'`);
        expect(wrapped.startsWith(`sh -c 'tmux has-session -t ='\\''a;b'\\''; `)).toBe(true);
    });
});

describe('parseExitCode', () => {
    it('reads the exit code and strips the marker from stdout', () => {
        // The wrapper prints its own leading newline, so the command's trailing one survives.
        expect(parseExitCode(`one\ntwo\n${MARKER_LINE(0)}`)).toEqual({ stdout: 'one\ntwo\n', code: 0 });
    });

    it('reads a non-zero exit code', () => {
        expect(parseExitCode(`${MARKER_LINE(1)}`)).toEqual({ stdout: '', code: 1 });
    });

    it('keeps output that did not end with a newline intact', () => {
        expect(parseExitCode(`partial${MARKER_LINE(0)}`)).toEqual({ stdout: 'partial', code: 0 });
    });

    it('tolerates login-shell banner noise before the marker', () => {
        const stdout = `Welcome to host!\nLast login: today\nrow 1${MARKER_LINE(2)}`;
        expect(parseExitCode(stdout)).toEqual({ stdout: 'Welcome to host!\nLast login: today\nrow 1', code: 2 });
    });

    it('reports code undefined when the marker is missing (stdout untouched)', () => {
        expect(parseExitCode('row 1\n')).toEqual({ stdout: 'row 1\n', code: undefined });
    });

    it('ignores a marker-looking token that is not the final line', () => {
        expect(parseExitCode('__rc=0\nmore output\n').code).toBeUndefined();
    });
});

describe('createRemoteExec', () => {
    it('sends the wrapped command and returns stdout, stderr and the exit code', async () => {
        const raw = vi.fn(async () => ({ stdout: `out${MARKER_LINE(0)}`, stderr: 'warn' }));
        const exec = createRemoteExec(raw, 1000);

        expect(await exec('tmux ls')).toEqual({ stdout: 'out', stderr: 'warn', code: 0 });
        expect(raw).toHaveBeenCalledWith(wrapWithExitCode('tmux ls'));
    });

    it('surfaces a missing marker as code undefined (the command never reported)', async () => {
        const exec = createRemoteExec(async () => ({ stdout: '', stderr: '' }), 1000);
        expect((await exec('tmux ls')).code).toBeUndefined();
    });

    it('passes a channel failure through as a rejection', async () => {
        const exec = createRemoteExec(async () => { throw new Error('channel closed'); }, 1000);
        await expect(exec('tmux ls')).rejects.toThrow('channel closed');
    });

    it('rejects with a DeadlineError when the remote never answers', async () => {
        vi.useFakeTimers();
        const exec = createRemoteExec(() => new Promise(() => { /* never settles */ }), 8000);

        const pending = exec('tmux ls');
        const assertion = expect(pending).rejects.toBeInstanceOf(DeadlineError);
        await vi.advanceTimersByTimeAsync(8000);
        await assertion;
    });
});
