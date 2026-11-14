import { describe, expect, it } from 'vitest';
import { MAX_RECENT_HOSTS, pushRecent, RECENT_HOSTS_STORAGE_KEY, RecentHosts } from '../src/recentHosts';

// "Connect to Host..." lists the hosts this profile connected to most recently first. The
// folder history can't answer that: it records only windows with a folder open, and its key
// order is insertion, not recency. So a tiny MRU of destinations sits beside it.

function fakeMemento(stored?: unknown) {
    const store = new Map<string, unknown>();
    if (stored !== undefined) {
        store.set(RECENT_HOSTS_STORAGE_KEY, stored);
    }
    return {
        store,
        memento: {
            get: (key: string): unknown => store.get(key),
            update: (key: string, value: unknown): Promise<void> => {
                store.set(key, value);
                return Promise.resolve();
            },
        },
    };
}

describe('pushRecent', () => {
    it('puts the host first', () => {
        expect(pushRecent(['a', 'b'], 'c')).toEqual(['c', 'a', 'b']);
    });

    it('moves an already-listed host to the front instead of duplicating it', () => {
        expect(pushRecent(['a', 'b', 'c'], 'b')).toEqual(['b', 'a', 'c']);
    });

    it('caps the list', () => {
        const full = Array.from({ length: MAX_RECENT_HOSTS }, (_, i) => `h${i}`);
        const next = pushRecent(full, 'new');
        expect(next).toHaveLength(MAX_RECENT_HOSTS);
        expect(next[0]).toBe('new');
        expect(next).not.toContain(`h${MAX_RECENT_HOSTS - 1}`);
    });
});

describe('RecentHosts', () => {
    it('is empty with nothing stored', () => {
        expect(new RecentHosts(fakeMemento().memento).list()).toEqual([]);
    });

    it('records connections most recent first and persists them', async () => {
        const { memento, store } = fakeMemento();
        const recent = new RecentHosts(memento);
        await recent.add('dev');
        await recent.add('me@staging:2222');
        await recent.add('dev');
        expect(recent.list()).toEqual(['dev', 'me@staging:2222']);
        expect(store.get(RECENT_HOSTS_STORAGE_KEY)).toEqual(['dev', 'me@staging:2222']);
    });

    it('reads through to storage, so another window\'s connection shows up', async () => {
        const { memento, store } = fakeMemento(['dev']);
        const recent = new RecentHosts(memento);
        store.set(RECENT_HOSTS_STORAGE_KEY, ['other', 'dev']);
        expect(recent.list()).toEqual(['other', 'dev']);
        await recent.add('third');
        expect(recent.list()).toEqual(['third', 'other', 'dev']);
    });

    it.each([
        ['a non-array', { dev: 1 }],
        ['a string', 'dev'],
        ['null', null],
    ])('treats %s in storage as empty', (_name, stored) => {
        expect(new RecentHosts(fakeMemento(stored).memento).list()).toEqual([]);
    });

    it('drops non-string and empty entries and duplicates from storage', () => {
        expect(new RecentHosts(fakeMemento(['dev', 3, '', 'dev', null, 'ops']).memento).list()).toEqual(['dev', 'ops']);
    });
});
