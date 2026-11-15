import { describe, expect, it } from 'vitest';
import { decideSettingsChange, type WatchedTmuxSettings } from '../../src/tmux/settingsWatcher';

// Changing a `remote.SSH.tmux.*` setting used to do nothing until a reload — and turning the
// feature off left this workspace's sessions running where nothing would ever show them
// again. The watcher's decision is pure: old settings, new settings, and whether the layer is
// wired now, in; one action out.

const BASE: WatchedTmuxSettings = {
    enabled: 'auto',
    historyLimit: 50000,
    handOff: 'auto',
    setDefaultProfile: true,
    reapOnConnect: true,
    orphanMaxAgeDays: 14,
};
const withChange = (over: Partial<WatchedTmuxSettings>): WatchedTmuxSettings => ({ ...BASE, ...over });

describe('decideSettingsChange', () => {
    it('nothing changed → none', () => {
        expect(decideSettingsChange(BASE, BASE, true)).toBe('none');
        expect(decideSettingsChange(BASE, BASE, false)).toBe('none');
    });

    describe('enabled', () => {
        it('turned off while wired → offer-cleanup (unwire, offer to close what still runs)', () => {
            expect(decideSettingsChange(BASE, withChange({ enabled: 'off' }), true)).toBe('offer-cleanup');
            expect(decideSettingsChange(withChange({ enabled: 'on' }), withChange({ enabled: 'off' }), true)).toBe('offer-cleanup');
        });

        it('turned off while not wired → none (nothing of ours is live here)', () => {
            expect(decideSettingsChange(BASE, withChange({ enabled: 'off' }), false)).toBe('none');
        });

        it('turned back on without a reload → rewire', () => {
            expect(decideSettingsChange(withChange({ enabled: 'off' }), BASE, false)).toBe('rewire');
            expect(decideSettingsChange(withChange({ enabled: 'off' }), withChange({ enabled: 'on' }), false)).toBe('rewire');
        });

        it('auto ↔ on while not wired → rewire (on must surface "tmux is required" now)', () => {
            expect(decideSettingsChange(BASE, withChange({ enabled: 'on' }), false)).toBe('rewire');
            expect(decideSettingsChange(withChange({ enabled: 'on' }), BASE, false)).toBe('rewire');
        });

        it('auto ↔ on while wired → none (tmux is there; the layer stays as it is)', () => {
            expect(decideSettingsChange(BASE, withChange({ enabled: 'on' }), true)).toBe('none');
            expect(decideSettingsChange(withChange({ enabled: 'on' }), BASE, true)).toBe('none');
        });

        it('off wins over any other change in the same edit', () => {
            expect(decideSettingsChange(BASE, withChange({ enabled: 'off', historyLimit: 1 }), true)).toBe('offer-cleanup');
        });

        it('a turn-on wins over any other change in the same edit', () => {
            expect(decideSettingsChange(withChange({ enabled: 'off' }), withChange({ historyLimit: 1 }), false)).toBe('rewire');
        });
    });

    describe('settings a live layer takes as they are (refresh)', () => {
        it.each([
            ['historyLimit', { historyLimit: 1000 }],
            ['handOff', { handOff: 'never' as const }],
            ['setDefaultProfile', { setDefaultProfile: false }],
        ])('%s while wired → refresh', (_, over) => {
            expect(decideSettingsChange(BASE, withChange(over), true)).toBe('refresh');
        });

        it.each([
            ['historyLimit', { historyLimit: 1000 }],
            ['handOff', { handOff: 'never' as const }],
        ])('%s while not wired → none (read when the layer wires)', (_, over) => {
            expect(decideSettingsChange(BASE, withChange(over), false)).toBe('none');
        });
    });

    describe('settings read at every (re)connect', () => {
        it.each([
            ['reapOnConnect', { reapOnConnect: false }],
            ['orphanMaxAgeDays', { orphanMaxAgeDays: 0 }],
        ])('%s → none, wired or not (the next housekeeping pass reads it)', (_, over) => {
            expect(decideSettingsChange(BASE, withChange(over), true)).toBe('none');
            expect(decideSettingsChange(BASE, withChange(over), false)).toBe('none');
        });
    });
});
