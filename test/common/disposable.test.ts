import { describe, expect, it, vi } from 'vitest';
import { Disposable, disposeAll } from '../../src/common/disposable';

// `disposeAll` is the teardown spine for every `Disposable` in the extension *and*
// for the tmux wiring's failure rollback, and it had no coverage at all.

describe('disposeAll', () => {
    // RAII order: teardown runs in reverse registration order, so a collaborator is
    // always released before whatever it was built on top of.
    it('disposes every entry in reverse registration order and empties the array', () => {
        const order: number[] = [];
        const list = [0, 1, 2].map(n => ({ dispose: () => void order.push(n) }));
        disposeAll(list);
        expect(order).toEqual([2, 1, 0]);
        expect(list).toHaveLength(0);
    });

    it('tolerates an empty array', () => {
        expect(() => disposeAll([])).not.toThrow();
    });

    // The reason this test exists: teardown is exactly when one collaborator is most
    // likely to be in a bad state, and popping-then-calling meant one throw abandoned
    // every disposable still in the list — leaking the listeners and handles that a
    // rollback or a deactivate was called to release. Everything must be released; the
    // failure is then reported rather than swallowed, so a broken dispose is still loud.
    it('disposes the rest even when one dispose throws, then reports the failure', () => {
        const disposed: string[] = [];
        const list = [
            { dispose: () => void disposed.push('a') },
            { dispose: () => { throw new Error('boom'); } },
            { dispose: () => void disposed.push('c') },
        ];
        expect(() => disposeAll(list)).toThrow('boom');
        expect(disposed).toEqual(['c', 'a']);
        expect(list).toHaveLength(0);
    });

    it('reports the first failure encountered when several throw', () => {
        const list = [
            { dispose: () => { throw new Error('registered-first'); } },
            { dispose: () => { throw new Error('registered-last'); } },
        ];
        // Teardown is LIFO, so the last-registered one is the first to fail.
        expect(() => disposeAll(list)).toThrow('registered-last');
        expect(list).toHaveLength(0);
    });
});

describe('Disposable', () => {
    class Probe extends Disposable {
        register<T extends { dispose(): void }>(value: T): T {
            return this._register(value as never) as unknown as T;
        }
        get disposedFlag(): boolean {
            return this.isDisposed;
        }
    }

    it('disposes everything registered, exactly once', () => {
        const probe = new Probe();
        const inner = { dispose: vi.fn() };
        probe.register(inner);
        probe.dispose();
        probe.dispose(); // idempotent — a second dispose must not re-run teardown
        expect(inner.dispose).toHaveBeenCalledTimes(1);
        expect(probe.disposedFlag).toBe(true);
    });

    it('disposes a late registration immediately instead of retaining it', () => {
        const probe = new Probe();
        probe.dispose();
        const late = { dispose: vi.fn() };
        probe.register(late);
        expect(late.dispose).toHaveBeenCalledTimes(1);
    });
});
