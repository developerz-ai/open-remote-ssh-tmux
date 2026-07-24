import { beforeEach, describe, expect, it, vi } from 'vitest';
import { decideTmuxWiring, idempotentResolveHandler, lazyExec, readTmuxSettings } from '../src/extension';
import type { RemoteSSHResolver } from '../src/authResolver';
import { configOverrides } from './mocks/vscode';

// extension.ts is activation wiring only; these tests pin the two behaviours the
// reconnect-safety fix (headline #3, "post-reconnect terminals fail") introduces:
//
//   * lazyExec — the provider/reaper `exec` resolves the resolver's *current*
//     SSHConnection at call time, so a reconnect's fresh connection is used and a
//     new terminal no longer targets the dead pre-reconnect channel.
//   * idempotentResolveHandler — resolve-success fires on every (re)connect; the
//     tmux layer must be wired exactly once and only *refreshed* thereafter (never
//     re-registering the terminal profile provider, which throws "already
//     registered" and would orphan the surviving provider).
//
// The heavier activate()-level wiring tests (settings, default-profile scope,
// session-context host parse) land with those tasks + the expanded vscode mock.

/** A fake SSHConnection exposing just the `exec` this layer uses; `tag` lets a test
 * tell which connection actually answered. */
function fakeConnection(tag: string) {
    return { exec: vi.fn(async () => ({ stdout: tag, stderr: '' })) };
}

/** A resolver stub whose live connection a test can swap between exec calls (models
 * a reconnect handing the resolver a fresh `SSHConnection`). */
function fakeResolver(connection: unknown) {
    let current = connection;
    const resolver = { getSSHConnection: () => current } as unknown as RemoteSSHResolver;
    return { resolver, swap: (next: unknown): void => { current = next; } };
}

describe('lazyExec: post-reconnect exec targets the live connection', () => {
    it('resolves the resolver\'s current connection at call time, not at wire time', async () => {
        const first = fakeConnection('first');
        const second = fakeConnection('second');
        const { resolver, swap } = fakeResolver(first);
        const exec = lazyExec(resolver);

        expect((await exec('tmux ls')).stdout).toBe('first');
        swap(second); // a reconnect swaps in a fresh SSHConnection
        expect((await exec('tmux ls')).stdout).toBe('second');

        expect(first.exec).toHaveBeenCalledTimes(1);
        expect(second.exec).toHaveBeenCalledTimes(1);
    });

    it('rejects when no connection is live (provider/reaper degrade via never-throw paths)', async () => {
        const { resolver } = fakeResolver(undefined);
        await expect(lazyExec(resolver)('tmux ls')).rejects.toThrow();
    });
});

describe('idempotentResolveHandler: wire once, refresh on reconnect', () => {
    it('wires on the first resolve, then only refreshes on every later resolve', () => {
        const refresh = vi.fn();
        const wire = vi.fn(() => ({ refresh }));
        const handler = idempotentResolveHandler(wire);

        handler(); // first connect → wire
        handler(); // reconnect → refresh only
        handler(); // reconnect → refresh only

        expect(wire).toHaveBeenCalledTimes(1);   // never re-registers
        expect(refresh).toHaveBeenCalledTimes(2);
    });

    it('retries wiring on a later resolve when the gates were not yet satisfied', () => {
        const refresh = vi.fn();
        let call = 0;
        // First resolve: gates fail (e.g. tmux capability not ready) → undefined, no
        // layer retained. A later resolve wires for real; then reconnects refresh it.
        const wire = vi.fn(() => (call++ === 0 ? undefined : { refresh }));
        const handler = idempotentResolveHandler(wire);

        handler(); // gate failed → no layer retained
        handler(); // now wired
        handler(); // reconnect → refresh

        expect(wire).toHaveBeenCalledTimes(2);
        expect(refresh).toHaveBeenCalledTimes(1);
    });
});

// The three settings (`historyLimit`, `reapOnConnect`, `enabled`) were declared in
// package.json but never read — `wireTmuxTerminalLayer` hard-coded their effects.
// `readTmuxSettings` is the single read seam (pins section, key names, and the
// package.json defaults) and `decideTmuxWiring` is the pure enablement rule that
// makes `enabled:'on'` ("require tmux") observably different from `'auto'`.
describe('readTmuxSettings: the three remote.SSH.tmux.* settings are read', () => {
    beforeEach(() => configOverrides.clear());

    it('falls back to the package.json defaults when nothing is configured', () => {
        const settings = readTmuxSettings();
        expect(settings.enabled).toBe('auto');
        expect(settings.historyLimit).toBe(50000);
        expect(settings.reapOnConnect).toBe(true);
    });

    it('reads seeded values from the remote.SSH configuration section', () => {
        configOverrides.set('remote.SSH.tmux.enabled', 'on');
        configOverrides.set('remote.SSH.tmux.historyLimit', 1000);
        configOverrides.set('remote.SSH.tmux.reapOnConnect', false);

        const settings = readTmuxSettings();
        expect(settings.enabled).toBe('on');
        expect(settings.historyLimit).toBe(1000);
        expect(settings.reapOnConnect).toBe(false);
    });
});

describe('decideTmuxWiring: enabled setting × tmux availability', () => {
    it('off → skip, whether or not tmux is available', () => {
        expect(decideTmuxWiring('off', true)).toBe('skip');
        expect(decideTmuxWiring('off', false)).toBe('skip');
    });

    it('auto → wire when available, skip silently when not', () => {
        expect(decideTmuxWiring('auto', true)).toBe('wire');
        expect(decideTmuxWiring('auto', false)).toBe('skip');
    });

    it('on → wire when available, require-error when not (the "fail if unavailable" contract)', () => {
        expect(decideTmuxWiring('on', true)).toBe('wire');
        expect(decideTmuxWiring('on', false)).toBe('require-error');
    });

    it('an unknown value degrades to auto behaviour', () => {
        expect(decideTmuxWiring('weird', true)).toBe('wire');
        expect(decideTmuxWiring('weird', false)).toBe('skip');
    });
});
