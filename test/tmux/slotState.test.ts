import { describe, expect, it } from 'vitest';
import {
    decideSlotAction,
    describeSlot,
    isClientStale,
    STALE_CLIENT_SECONDS,
    toHandOffPolicy,
    type HandOffPolicy,
    type RemoteSlotState,
    type SlotInput,
    type SlotOwner,
} from '../../src/tmux/slotState';

// The slot lifecycle as ONE explicit decision. Two field bugs shaped it:
//  - VS Code keeps a closed window's pty alive for VSCODE_RECONNECTION_GRACE_TIME (3h), so
//    our own tmux client stays *attached* long after the window is gone; reading that as
//    "another machine" stranded the user's work (session `code-8282129a2247-0`, htop,
//    orphan client stale by 158s).
//  - The fix for that read "mapped" as "ours", which broke once a session moved machines:
//    PC maps slot 0, laptop adopts it, PC reconnects and `-D`-evicts the laptop's LIVE
//    terminal. Ownership now comes from the session's owner tag, not the local mapping.

/** A slot with nothing going on — spread over with the case under test. */
const BASE: SlotInput = { slot: 0, mapped: false, openHere: false, remote: undefined, handOff: 'auto' };

const remote = (attached: boolean, owner: SlotOwner = 'unknown', stale = false, windows = 1): RemoteSlotState =>
    ({ attached, windows, owner, stale });

describe('decideSlotAction: the slot state machine (03 table, one case per row)', () => {
    // Row 1: openHere wins over everything.
    it.each([
        ['mapped, attached by us', { mapped: true, remote: remote(true, 'me') }],
        ['unmapped, attached by another, stale', { mapped: false, remote: remote(true, 'other', true) }],
        ['mapped, detached', { mapped: true, remote: remote(false) }],
    ])('skips a slot already open in this window (%s)', (_label, over) => {
        const d = decideSlotAction({ ...BASE, ...over, openHere: true });
        expect(d.action).toBe('skip');
        expect(d.reason).toMatch(/open/i);
    });

    // Row 2: not attached → restore (mapped) / adopt (unmapped), whatever the owner tag.
    it.each<SlotOwner>(['me', 'other', 'unknown'])('restores a mapped detached session (owner %s)', owner => {
        expect(decideSlotAction({ ...BASE, mapped: true, remote: remote(false, owner) }).action).toBe('restore');
    });

    it.each<SlotOwner>(['me', 'other', 'unknown'])('adopts an unmapped detached session (owner %s)', owner => {
        expect(decideSlotAction({ ...BASE, remote: remote(false, owner) }).action).toBe('adopt');
    });

    // Row 3: attached + owner me → our own zombie pty; mapped or not.
    it.each([true, false])('reclaims a session our own client holds (mapped=%s)', mapped => {
        const d = decideSlotAction({ ...BASE, mapped, remote: remote(true, 'me') });
        expect(d.action).toBe('restore-takeover');
        expect(d.forget).toBe(false);
    });

    // Row 4: attached + foreign owner + stale → hand-off take-over (auto).
    it.each<SlotOwner>(['other', 'unknown'])('takes over an idle foreign client under auto (owner %s)', owner => {
        const d = decideSlotAction({ ...BASE, remote: remote(true, owner, true) });
        expect(d.action).toBe('handoff-takeover');
        expect(d.forget).toBe(false);
    });

    // Row 5: attached + foreign owner + live → per policy.
    it.each<[HandOffPolicy, string]>([
        ['auto', 'offer'],
        ['ask', 'offer'],
        ['never', 'skip'],
    ])('a live foreign client under %s → %s', (handOff, action) => {
        expect(decideSlotAction({ ...BASE, handOff, remote: remote(true, 'other', false) }).action).toBe(action);
    });

    // THE REGRESSION: the laptop adopted PC's slot 0; PC's mapping still lists it. PC's
    // reconnect must not evict the laptop's live client.
    it('never takes over a mapped session a live client of another machine holds', () => {
        const d = decideSlotAction({ ...BASE, mapped: true, remote: remote(true, 'other', false) });
        expect(d.action).not.toBe('restore-takeover');
        expect(d.action).not.toBe('handoff-takeover');
        expect(d.action).toBe('offer');
    });

    it('treats a pre-tag (unknown owner) live session as foreign — never -D without proof', () => {
        expect(decideSlotAction({ ...BASE, mapped: true, remote: remote(true, 'unknown', false) }).action).toBe('offer');
    });

    // The auto/ask distinction is real: ask never takes anything without a click.
    it('offers (does not silently take) a stale foreign client under ask', () => {
        expect(decideSlotAction({ ...BASE, handOff: 'ask', remote: remote(true, 'other', true) }).action).toBe('offer');
    });

    it('leaves even a stale foreign client alone under never', () => {
        expect(decideSlotAction({ ...BASE, handOff: 'never', remote: remote(true, 'other', true) }).action).toBe('skip');
    });

    // Mapping hygiene: once the tag names another machine, our mapping entry is stale.
    it.each<HandOffPolicy>(['auto', 'ask', 'never'])('forgets a mapped slot another machine now holds (%s)', handOff => {
        expect(decideSlotAction({ ...BASE, handOff, mapped: true, remote: remote(true, 'other', false) }).forget).toBe(true);
    });

    it('does not forget a pre-tag session — it may well be ours from before the upgrade', () => {
        expect(decideSlotAction({ ...BASE, mapped: true, remote: remote(true, 'unknown', false) }).forget).toBe(false);
    });

    it('attempts restore (not prune) for a mapped slot missing from the snapshot', () => {
        const d = decideSlotAction({ ...BASE, mapped: true });
        expect(d.action).toBe('restore');
        expect(d.reason).toMatch(/has-session/);
    });

    it('does nothing for an unmapped slot with no remote session', () => {
        expect(decideSlotAction(BASE).action).toBe('skip');
    });

    // No windows===0 special case: a zero-window session cannot appear in `list-sessions`.
    it('adopts a detached session regardless of window count (zero-window is unreachable)', () => {
        expect(decideSlotAction({ ...BASE, remote: remote(false, 'unknown', false, 0) }).action).toBe('adopt');
    });
});

describe('isClientStale', () => {
    const NOW = 1_800_000_000;

    it('is stale when every client is idle past the threshold', () => {
        expect(isClientStale([NOW - STALE_CLIENT_SECONDS, NOW - 500], NOW)).toBe(true);
    });

    it('is live when any client typed recently', () => {
        expect(isClientStale([NOW - 500, NOW - 5], NOW)).toBe(false);
    });

    it('is never stale without evidence (no clients known)', () => {
        expect(isClientStale([], NOW)).toBe(false);
    });

    it('takes an explicit threshold', () => {
        expect(isClientStale([NOW - 3], NOW, 2)).toBe(true);
        expect(isClientStale([NOW - 1], NOW, 2)).toBe(false);
    });

    it('defaults to two minutes', () => {
        expect(STALE_CLIENT_SECONDS).toBe(120);
    });
});

describe('toHandOffPolicy', () => {
    it.each(['auto', 'ask', 'never'])('accepts %s', value => {
        expect(toHandOffPolicy(value)).toBe(value);
    });

    it.each([undefined, '', 'yes', 1, null])('falls back to auto for %s', value => {
        expect(toHandOffPolicy(value)).toBe('auto');
    });
});

describe('describeSlot: one greppable log line per slot', () => {
    it('reports the observed state and the resulting action', () => {
        const line = describeSlot({ ...BASE, slot: 3, mapped: true, remote: remote(true, 'me', false, 2) });
        expect(line).toContain('slot 3');
        expect(line).toContain('mapped=yes');
        expect(line).toContain('attached=yes');
        expect(line).toContain('windows=2');
        expect(line).toContain('owner=me');
        expect(line).toContain('stale=no');
        expect(line).toContain('handOff=auto');
        expect(line).toContain('restore-takeover');
    });

    it('renders a slot with no remote session without inventing fields', () => {
        const line = describeSlot({ ...BASE, slot: 1, mapped: true });
        expect(line).toContain('slot 1');
        expect(line).toContain('remote=none');
        expect(line).toContain('restore');
    });
});
