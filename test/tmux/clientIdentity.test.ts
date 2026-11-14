import { describe, expect, it } from 'vitest';
import { CLIENT_NONCE_STATE_KEY, clientId, isClientId, resolveClientId } from '../../src/tmux/clientIdentity';

// The id this window writes into its tmux sessions (`@orst_owner`) so a second machine can
// tell whose client holds a session. It travels to — and is readable on — a shared remote,
// so the raw VS Code machineId (a stable device identifier) must never be in it.

const MACHINE_ID = '4f2c9a7b1d3e5f60718293a4b5c6d7e8f9012345678901234567890abcdef123';

/** A `vscode.Memento` stand-in. */
function fakeState(initial: Record<string, unknown> = {}) {
    const store = new Map<string, unknown>(Object.entries(initial));
    return {
        store,
        keys: (): string[] => [...store.keys()],
        get: <T>(key: string): T | undefined => store.get(key) as T | undefined,
        update: async (key: string, value: unknown): Promise<void> => {
            store.set(key, value);
        },
    };
}

describe('clientId', () => {
    it('is deterministic for the same machine and nonce', () => {
        expect(clientId(MACHINE_ID, '0011aabb')).toBe(clientId(MACHINE_ID, '0011aabb'));
    });

    it('is 8 hex of the machine hash, a dash, and the nonce', () => {
        expect(clientId(MACHINE_ID, '0011aabb')).toMatch(/^[0-9a-f]{8}-0011aabb$/);
    });

    it('never carries the raw machineId (or any long slice of it)', () => {
        const id = clientId(MACHINE_ID, '0011aabb');
        expect(id).not.toContain(MACHINE_ID);
        expect(id).not.toContain(MACHINE_ID.slice(0, 8));
    });

    it('differs between machines and between windows of one machine', () => {
        expect(clientId(MACHINE_ID, '0011aabb')).not.toBe(clientId('another-machine', '0011aabb'));
        expect(clientId(MACHINE_ID, '0011aabb')).not.toBe(clientId(MACHINE_ID, 'ffeeddcc'));
    });
});

describe('isClientId', () => {
    it('accepts what clientId produces', () => {
        expect(isClientId(clientId(MACHINE_ID, '0011aabb'))).toBe(true);
    });

    it.each(['', 'abc', 'x;rm -rf ~', '#{session_name}', '0011aabb-0011aabb;', ' 0011aabb-0011aabb'])('rejects %j', value => {
        expect(isClientId(value)).toBe(false);
    });
});

describe('resolveClientId (nonce kept in workspaceState)', () => {
    it('mints a nonce once and persists it', () => {
        const state = fakeState();
        const id = resolveClientId(MACHINE_ID, state, () => '0011aabb');
        expect(id).toBe(clientId(MACHINE_ID, '0011aabb'));
        expect(state.store.get(CLIENT_NONCE_STATE_KEY)).toBe('0011aabb');
    });

    it('reuses the persisted nonce on the next window of this workspace', () => {
        const state = fakeState({ [CLIENT_NONCE_STATE_KEY]: 'ffeeddcc' });
        expect(resolveClientId(MACHINE_ID, state, () => '0011aabb')).toBe(clientId(MACHINE_ID, 'ffeeddcc'));
    });

    it('replaces a malformed persisted nonce rather than putting it on the remote', () => {
        const state = fakeState({ [CLIENT_NONCE_STATE_KEY]: 'x;y' });
        expect(resolveClientId(MACHINE_ID, state, () => '0011aabb')).toBe(clientId(MACHINE_ID, '0011aabb'));
        expect(state.store.get(CLIENT_NONCE_STATE_KEY)).toBe('0011aabb');
    });

    it('still answers when persisting the nonce fails', () => {
        const state = { ...fakeState(), update: async (): Promise<void> => { throw new Error('storage'); } };
        expect(resolveClientId(MACHINE_ID, state, () => '0011aabb')).toBe(clientId(MACHINE_ID, '0011aabb'));
    });

    it('mints 8 hex by default', () => {
        expect(resolveClientId(MACHINE_ID, fakeState())).toMatch(/^[0-9a-f]{8}-[0-9a-f]{8}$/);
    });
});
