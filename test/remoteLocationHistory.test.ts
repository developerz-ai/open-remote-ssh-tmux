import { beforeEach, describe, expect, it } from 'vitest';
import {
    getRemoteWorkspaceLocationData,
    HISTORY_STORAGE_KEY,
    MAX_LOCATIONS_PER_HOST,
    RemoteLocationHistory,
} from '../src/remoteLocationHistory';
import { workspace } from './mocks/vscode';

// `remoteLocationHistory` is loaded eagerly by `activate()`, so anything it can
// throw takes every command down with it ("command not found" everywhere). These
// tests pin the crash-proofing: a malformed persisted value is normalised rather
// than trusted, an empty-folder workspace doesn't dereference `undefined`, a
// foreign remote authority is ignored, and concurrent windows don't clobber each
// other's history (re-read-before-write).

type Ctx = ConstructorParameters<typeof RemoteLocationHistory>[0];

/** A fake `ExtensionContext` whose `globalState` is a Map — models the shared,
 *  cross-window global storage the history is persisted in. `stored` seeds the
 *  value already at the history key (any shape, to exercise normalisation). */
function fakeContext(stored?: unknown) {
    const store = new Map<string, unknown>();
    if (stored !== undefined) {
        store.set(HISTORY_STORAGE_KEY, stored);
    }
    const globalState = {
        keys: (): readonly string[] => [...store.keys()],
        get: (key: string, def?: unknown): unknown => (store.has(key) ? store.get(key) : def),
        update: async (key: string, value: unknown): Promise<void> => {
            if (value === undefined) {
                store.delete(key);
            } else {
                store.set(key, value);
            }
        },
    };
    return {
        context: { globalState } as unknown as Ctx,
        /** Simulate another window's write landing in the shared store. */
        seedExternal: (value: unknown): void => void store.set(HISTORY_STORAGE_KEY, value),
        /** The persisted history value, as another window would read it. */
        persisted: (): Record<string, string[]> => store.get(HISTORY_STORAGE_KEY) as Record<string, string[]>,
    };
}

describe('RemoteLocationHistory', () => {
    describe('getHistory', () => {
        it('returns an empty array for an unknown host', () => {
            const { context } = fakeContext();
            const history = new RemoteLocationHistory(context);
            expect(history.getHistory('nope')).toEqual([]);
        });

        it('returns the stored locations for a known host', () => {
            const { context } = fakeContext({ h: ['/a', '/b'] });
            const history = new RemoteLocationHistory(context);
            expect(history.getHistory('h')).toEqual(['/a', '/b']);
        });

        // `globalState` is shared by every window of the profile, so the window showing the
        // tree is usually NOT the window that opened the folder. Answering from the
        // constructor's snapshot meant the "SSH Targets" view of an already-open window
        // showed a stale list — and even its explicit Refresh command could not fix it,
        // because refresh only re-fires the tree event and never re-read storage.
        it('reflects a write from another window without being reconstructed', () => {
            const ctx = fakeContext({ h: ['/a'] });
            const history = new RemoteLocationHistory(ctx.context);

            ctx.seedExternal({ h: ['/a'], other: ['/z'] });

            expect(history.getHistory('other')).toEqual(['/z']);
        });
    });

    describe('getHosts', () => {
        it('is empty when nothing has been remembered', () => {
            const { context } = fakeContext();
            expect(new RemoteLocationHistory(context).getHosts()).toEqual([]);
        });

        it('lists every host with a remembered location', () => {
            const { context } = fakeContext({ hA: ['/a'], hB: ['/b'] });
            expect(new RemoteLocationHistory(context).getHosts()).toEqual(['hA', 'hB']);
        });

        // Same shared-storage reason as getHistory above: the tree asks for the host list on
        // every render, and that answer has to come from storage, not from activation time.
        it('reflects a host added by another window', () => {
            const ctx = fakeContext({ hA: ['/a'] });
            const history = new RemoteLocationHistory(ctx.context);

            ctx.seedExternal({ hA: ['/a'], hB: ['/b'] });

            expect(history.getHosts()).toEqual(['hA', 'hB']);
        });

        it('omits a host whose entry normalised away to nothing', () => {
            // `normalizeHistory` drops non-string members; a host left with no usable path
            // must not become an empty root node in the tree.
            const { context } = fakeContext({ hA: ['/a'], hB: [42] });
            expect(new RemoteLocationHistory(context).getHosts()).toEqual(['hA']);
        });
    });

    describe('addLocation', () => {
        it('adds a new location to the front and persists it', async () => {
            const ctx = fakeContext();
            const history = new RemoteLocationHistory(ctx.context);

            await history.addLocation('h', '/a');
            await history.addLocation('h', '/b');

            expect(history.getHistory('h')).toEqual(['/b', '/a']);
            expect(ctx.persisted()).toEqual({ h: ['/b', '/a'] });
        });

        it('moves an already-remembered location to the front without duplicating (MRU)', async () => {
            const ctx = fakeContext({ h: ['/a', '/b', '/c'] });
            const history = new RemoteLocationHistory(ctx.context);

            await history.addLocation('h', '/c');

            expect(history.getHistory('h')).toEqual(['/c', '/a', '/b']);
        });

        it('caps the per-host list length', async () => {
            const seeded = Array.from({ length: MAX_LOCATIONS_PER_HOST }, (_, i) => `/p${i}`);
            const ctx = fakeContext({ h: seeded });
            const history = new RemoteLocationHistory(ctx.context);

            await history.addLocation('h', '/new');

            const result = history.getHistory('h');
            expect(result).toHaveLength(MAX_LOCATIONS_PER_HOST);
            expect(result[0]).toBe('/new');
            expect(result).not.toContain(`/p${MAX_LOCATIONS_PER_HOST - 1}`);
        });

        it('re-reads globalState before writing so a concurrent window is not clobbered', async () => {
            const ctx = fakeContext({ hB: ['/x'] });
            const history = new RemoteLocationHistory(ctx.context);

            // Another window persists a new host AFTER we loaded our in-memory copy.
            ctx.seedExternal({ hB: ['/x'], hC: ['/z'] });

            await history.addLocation('hA', '/y');

            // Our addition merges in; the other window's `hC` survives.
            expect(ctx.persisted()).toEqual({ hB: ['/x'], hC: ['/z'], hA: ['/y'] });
        });
    });

    describe('removeLocation', () => {
        it('removes a location and persists the result', async () => {
            const ctx = fakeContext({ h: ['/a', '/b', '/c'] });
            const history = new RemoteLocationHistory(ctx.context);

            await history.removeLocation('h', '/b');

            expect(history.getHistory('h')).toEqual(['/a', '/c']);
            expect(ctx.persisted()).toEqual({ h: ['/a', '/c'] });
        });

        it('drops the host entry entirely once its last location is removed', async () => {
            const ctx = fakeContext({ h: ['/a'] });
            const history = new RemoteLocationHistory(ctx.context);

            await history.removeLocation('h', '/a');

            expect(history.getHistory('h')).toEqual([]);
            expect(ctx.persisted()).toEqual({});
        });

        it('re-reads globalState before writing so a concurrent window is not clobbered', async () => {
            const ctx = fakeContext({ h: ['/a', '/b'] });
            const history = new RemoteLocationHistory(ctx.context);

            ctx.seedExternal({ h: ['/a', '/b'], other: ['/z'] });

            await history.removeLocation('h', '/a');

            expect(ctx.persisted()).toEqual({ h: ['/b'], other: ['/z'] });
        });
    });

    describe('normalisation of a malformed persisted value', () => {
        it('treats a non-array host entry as empty', () => {
            const { context } = fakeContext({ h: 'notarray' });
            const history = new RemoteLocationHistory(context);
            expect(history.getHistory('h')).toEqual([]);
        });

        it('drops non-string members of a host array', () => {
            const { context } = fakeContext({ h: [1, '/a', null, '/b', {}] });
            const history = new RemoteLocationHistory(context);
            expect(history.getHistory('h')).toEqual(['/a', '/b']);
        });

        it('treats a non-object root as empty history', () => {
            for (const bad of ['garbage', 42, null, ['/a']]) {
                const { context } = fakeContext(bad);
                const history = new RemoteLocationHistory(context);
                expect(history.getHistory('h')).toEqual([]);
            }
        });

        it('does not write a persisted-normalised over-cap array back on a mutation', async () => {
            const overCap = Array.from({ length: MAX_LOCATIONS_PER_HOST + 5 }, (_, i) => `/p${i}`);
            const ctx = fakeContext({ h: overCap });
            const history = new RemoteLocationHistory(ctx.context);

            await history.addLocation('h', '/new');

            expect(history.getHistory('h')).toHaveLength(MAX_LOCATIONS_PER_HOST);
            expect(ctx.persisted().h).toHaveLength(MAX_LOCATIONS_PER_HOST);
        });
    });
});

describe('getRemoteWorkspaceLocationData', () => {
    /** Encode a host the way the `vscode-remote` authority carries it (hex JSON). */
    const encode = (host: { hostName: string; user?: string; port?: number }): string =>
        Buffer.from(JSON.stringify(host)).toString('hex');

    const remoteUri = (authority: string, path: string) => ({ scheme: 'vscode-remote', authority, path });

    beforeEach(() => {
        workspace.workspaceFile = undefined;
        workspace.workspaceFolders = undefined;
    });

    it('returns undefined when no workspace is open', () => {
        expect(getRemoteWorkspaceLocationData()).toBeUndefined();
    });

    it('does not throw on an empty-folder workspace (empty workspaceFolders array)', () => {
        // `?.[0]` on `[]` is `undefined`; the pre-fix `?.[0].uri` threw here and
        // killed `activate()`. Must return undefined, never throw.
        workspace.workspaceFolders = [];
        expect(() => getRemoteWorkspaceLocationData()).not.toThrow();
        expect(getRemoteWorkspaceLocationData()).toBeUndefined();
    });

    it('extracts [hostname, path] from a remote workspace folder', () => {
        const authority = `ssh-remote+${encode({ hostName: 'example.com' })}`;
        workspace.workspaceFolders = [{ uri: remoteUri(authority, '/home/user/proj') }];
        expect(getRemoteWorkspaceLocationData()).toEqual(['example.com', '/home/user/proj']);
    });

    it('ignores a foreign remote authority (ssh-remote2+…, not this extension)', () => {
        const authority = `ssh-remote2+${encode({ hostName: 'example.com' })}`;
        workspace.workspaceFolders = [{ uri: remoteUri(authority, '/home/user/proj') }];
        expect(getRemoteWorkspaceLocationData()).toBeUndefined();
    });

    it('ignores a non-remote (local) folder', () => {
        workspace.workspaceFolders = [{ uri: { scheme: 'file', authority: '', path: '/home/user/proj' } }];
        expect(getRemoteWorkspaceLocationData()).toBeUndefined();
    });

    it('splits on the first "+" only so a payload containing "+" survives', () => {
        // Synthetic payload with a literal '+': a plain `split('+')[1]` would
        // truncate it to 'aa'; splitting on the first '+' keeps 'aa+bb'.
        workspace.workspaceFolders = [{ uri: remoteUri('ssh-remote+aa+bb', '/home/user/proj') }];
        expect(getRemoteWorkspaceLocationData()).toEqual(['aa+bb', '/home/user/proj']);
    });

    it('extracts [hostname, path] from a remote .code-workspace file', () => {
        const authority = `ssh-remote+${encode({ hostName: 'example.com' })}`;
        workspace.workspaceFile = remoteUri(authority, '/home/user/proj/my.code-workspace');
        expect(getRemoteWorkspaceLocationData()).toEqual(['example.com', '/home/user/proj/my.code-workspace']);
    });

    it('falls through to a remote folder when the workspace file is a local .code-workspace', () => {
        const authority = `ssh-remote+${encode({ hostName: 'example.com' })}`;
        workspace.workspaceFile = { scheme: 'file', authority: '', path: '/local/my.code-workspace' };
        workspace.workspaceFolders = [{ uri: remoteUri(authority, '/home/user/proj') }];
        expect(getRemoteWorkspaceLocationData()).toEqual(['example.com', '/home/user/proj']);
    });
});
