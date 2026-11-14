import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DeadlineError, withDeadline } from '../../src/common/deadline';

describe('withDeadline', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('passes a resolution through unchanged', async () => {
        await expect(withDeadline(Promise.resolve(42), 1000, 'probe')).resolves.toBe(42);
    });

    it('passes a rejection through unchanged', async () => {
        const err = new Error('boom');
        await expect(withDeadline(Promise.reject(err), 1000, 'probe')).rejects.toBe(err);
    });

    it('rejects with a labelled DeadlineError when the promise never settles', async () => {
        const pending = withDeadline(new Promise<never>(() => undefined), 500, 'tmux has-session');
        const assertion = expect(pending).rejects.toSatisfy((e: unknown) =>
            e instanceof DeadlineError && e.label === 'tmux has-session' && e.ms === 500 && e.message.includes('tmux has-session'));
        await vi.advanceTimersByTimeAsync(500);
        await assertion;
    });

    it('does not reject before the deadline elapses', async () => {
        let settled = false;
        withDeadline(new Promise<never>(() => undefined), 500, 'x').catch(() => {
            settled = true;
        });
        await vi.advanceTimersByTimeAsync(499);
        expect(settled).toBe(false);
    });

    it('clears its timer once the promise settles', async () => {
        await withDeadline(Promise.resolve('ok'), 1000, 'x');
        expect(vi.getTimerCount()).toBe(0);
        await withDeadline(Promise.reject(new Error('no')), 1000, 'x').catch(() => undefined);
        expect(vi.getTimerCount()).toBe(0);
    });
});
