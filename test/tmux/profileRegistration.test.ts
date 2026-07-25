import { describe, expect, it, vi } from 'vitest';
import { TerminalProfileRegistration } from '../../src/tmux/profileRegistration';

// Regression cover for the v1.0.0 field failure: activate() registered the plain-shell
// FallbackTerminalProvider on the "tmux" profile id, then wireTmuxTerminalLayer registered
// the real TmuxTerminalProvider on the *same* id. VS Code does not override a profile-id
// registration — it throws `Terminal profile provider "tmux" already registered` — so the
// whole tmux layer was skipped on every connect and "Persistent Shell" silently opened a
// plain bash terminal (no tmux server ever started on the remote). The fake below models
// VS Code's real one-provider-per-id rule so the swap is pinned, not assumed.

/** A `registerTerminalProfileProvider` stand-in with VS Code's actual semantics: one
 * provider per id, re-registering an occupied id throws, disposing frees the id. */
function fakeRegistry() {
    const occupied = new Map<string, unknown>();
    const register = vi.fn((id: string, provider: unknown) => {
        if (occupied.has(id)) {
            throw new Error(`Terminal profile provider "${id}" already registered`);
        }
        occupied.set(id, provider);
        return {
            dispose: (): void => {
                if (occupied.get(id) === provider) {
                    occupied.delete(id);
                }
            },
        };
    });
    return { register, providerFor: (id: string): unknown => occupied.get(id) };
}

describe('TerminalProfileRegistration: one provider per profile id, swappable', () => {
    it('swaps the fallback out for the real provider without throwing "already registered"', () => {
        const { register, providerFor } = fakeRegistry();
        const fallback = { kind: 'fallback' };
        const real = { kind: 'tmux' };
        const registration = new TerminalProfileRegistration('tmux', register as never);

        registration.use(fallback as never);
        expect(providerFor('tmux')).toBe(fallback);

        // The bug: this second registration threw, so the tmux layer never wired.
        expect(() => registration.use(real as never)).not.toThrow();
        expect(providerFor('tmux')).toBe(real);
        expect(register).toHaveBeenCalledTimes(2);
    });

    it('disposes the previous registration before registering the next (frees the id)', () => {
        const disposed: string[] = [];
        const register = vi.fn((id: string) => ({ dispose: (): void => void disposed.push(id) }));
        const registration = new TerminalProfileRegistration('tmux', register as never);

        registration.use({} as never);
        expect(disposed).toEqual([]);
        registration.use({} as never);
        expect(disposed).toEqual(['tmux']); // old one released as part of the swap
    });

    it('releases the id on dispose so a reload does not leak the registration', () => {
        const { register, providerFor } = fakeRegistry();
        const registration = new TerminalProfileRegistration('tmux', register as never);

        registration.use({} as never);
        registration.dispose();
        expect(providerFor('tmux')).toBeUndefined();
    });

    it('is idempotent on repeated dispose (pushed to context.subscriptions)', () => {
        const { register } = fakeRegistry();
        const registration = new TerminalProfileRegistration('tmux', register as never);

        registration.use({} as never);
        registration.dispose();
        expect(() => registration.dispose()).not.toThrow();
    });

    it('leaves the id free when register throws, so a later use() can still take it', () => {
        const failing = vi.fn(() => { throw new Error('boom'); });
        const registration = new TerminalProfileRegistration('tmux', failing as never);

        expect(() => registration.use({} as never)).toThrow('boom');
        // No stale disposable retained — dispose must not blow up, and a retry re-registers.
        expect(() => registration.dispose()).not.toThrow();
        expect(failing).toHaveBeenCalledTimes(1);
    });
});
