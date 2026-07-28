import { describe, expect, it } from 'vitest';
import { teardownAttempt, type AttemptTeardown } from '../src/authResolver';

/** Let the microtask queue drain so a rejected `close()` reaches its handler. */
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

// One `RemoteSSHResolver` instance lives for the whole extension lifetime and
// `resolve()` is re-entered on every retry/reconnect (see `context.resolveAttempt`).
// Nothing used to tear the previous attempt's state down: `sshConnection` and
// `proxyCommandProcess` were overwritten, `proxyConnections` and `tunnels` only ever
// grew. A transient `installCodeServer` failure (→ TemporarilyNotAvailable → VS Code
// retries) therefore left attempt 1's authenticated SSH connection open, its local
// forwarding/SOCKS `net.Server`s listening on their random ports, and its
// ProxyCommand child orphaned — `dispose()` only ever killed the *latest* one. Over a
// laptop's suspend/resume cycles that accumulates sockets, listening ports, orphaned
// processes and remote sshd sessions for the window's lifetime.
//
// `teardownAttempt` is that release step, extracted as a structural (ssh2-free,
// child_process-free) seam so the ordering and the failure-isolation are unit-tested.
// It is the single implementation shared by `dispose()` and the top of `resolve()`.
describe('teardownAttempt', () => {
    /** A stand-in resolve state whose effects the assertions can observe. */
    function makeState(overrides: Partial<AttemptTeardown> = {}): { state: AttemptTeardown; log: string[] } {
        const log: string[] = [];
        const state: AttemptTeardown = {
            tunnels: [{ dispose: () => { log.push('tunnel'); } }],
            sshConnection: { close: async () => { log.push('ssh'); } },
            proxyConnections: [{ close: async () => { log.push('hop0'); } }],
            proxyCommandProcess: { kill: () => { log.push('kill'); return true; } },
            ...overrides,
        };
        return { state, log };
    }

    it('releases the tunnels, every connection and the ProxyCommand child', () => {
        const { state, log } = makeState();
        teardownAttempt(state, () => { throw new Error('should not report an error'); });
        expect(log).toEqual(['tunnel', 'ssh', 'hop0', 'kill']);
    });

    it('empties the tunnel array so a retry neither re-disposes nor accumulates', () => {
        const { state } = makeState();
        teardownAttempt(state, () => {});
        expect(state.tunnels).toEqual([]);
    });

    it('closes every ProxyJump hop, not just the first', () => {
        const log: string[] = [];
        const state: AttemptTeardown = {
            tunnels: [],
            sshConnection: { close: async () => { log.push('ssh'); } },
            proxyConnections: [0, 1, 2].map((i) => ({ close: async () => { log.push(`hop${i}`); } })),
            proxyCommandProcess: undefined,
        };
        teardownAttempt(state, () => {});
        expect(log).toEqual(['ssh', 'hop0', 'hop1', 'hop2']);
    });

    it('is a no-op on a resolver that never got as far as connecting', () => {
        const state: AttemptTeardown = { tunnels: [], sshConnection: undefined, proxyConnections: [], proxyCommandProcess: undefined };
        expect(() => teardownAttempt(state, () => { throw new Error('should not report an error'); })).not.toThrow();
    });

    // The retry path is the whole point: a failure while releasing attempt N-1 must
    // never abort attempt N, and must never leave the rest of attempt N-1 behind.
    it('still closes the connections and kills the child when a tunnel dispose throws', () => {
        const { state, log } = makeState({
            tunnels: [{ dispose: () => { throw new Error('tunnel boom'); } }],
        });
        const errors: unknown[] = [];
        teardownAttempt(state, (_message, err) => errors.push(err));
        expect(log).toEqual(['ssh', 'hop0', 'kill']);
        expect(errors).toHaveLength(1);
    });

    it('still kills the child when a connection close throws synchronously', () => {
        const { state, log } = makeState({
            sshConnection: { close: () => { throw new Error('close boom'); } },
        });
        const errors: unknown[] = [];
        teardownAttempt(state, (_message, err) => errors.push(err));
        expect(log).toEqual(['tunnel', 'hop0', 'kill']);
        expect(errors).toHaveLength(1);
    });

    it('reports a rejected close() instead of raising an unhandled rejection', async () => {
        const { state } = makeState({
            sshConnection: { close: async () => { throw new Error('async close boom'); } },
        });
        const errors: unknown[] = [];
        teardownAttempt(state, (_message, err) => errors.push(err));
        await flush();
        expect(errors).toHaveLength(1);
    });

    it('never throws out of the teardown, whatever fails', () => {
        const state: AttemptTeardown = {
            tunnels: [{ dispose: () => { throw new Error('a'); } }],
            sshConnection: { close: () => { throw new Error('b'); } },
            proxyConnections: [{ close: () => { throw new Error('c'); } }],
            proxyCommandProcess: { kill: () => { throw new Error('d'); } },
        };
        const errors: unknown[] = [];
        expect(() => teardownAttempt(state, (_message, err) => errors.push(err))).not.toThrow();
        expect(errors).toHaveLength(4);
    });
});
