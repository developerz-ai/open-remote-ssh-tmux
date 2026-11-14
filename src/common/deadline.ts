/**
 * Raised by {@link withDeadline} when the wrapped promise has not settled in time.
 * `label` names the operation so a log line says *what* hung, not just that something did.
 */
export class DeadlineError extends Error {
    constructor(readonly label: string, readonly ms: number) {
        super(`${label} did not finish within ${ms}ms`);
        this.name = 'DeadlineError';
    }
}

/**
 * Settle with `promise`, or reject with a {@link DeadlineError} after `ms`.
 *
 * Every remote round-trip (an `exec` over SSH, a tunnel open) can hang forever on a
 * half-dead link: the stream simply never closes. Bounding the wait is the caller's only
 * defence. The underlying operation is not cancelled — it is abandoned; the timer is
 * always cleared so a settled promise leaves nothing scheduled.
 */
export function withDeadline<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new DeadlineError(label, ms)), ms);
    });
    return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}
