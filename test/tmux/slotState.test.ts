import { describe, expect, it } from 'vitest';
import { decideSlotAction, describeSlot, type SlotInput } from '../../src/tmux/slotState';

// The slot lifecycle as ONE explicit decision, extracted from reconcile()'s inlined
// conditionals. Every row below is a state this fork actually hits in the field; the
// regression that forced this extraction is `reclaims a slot this client owns even when
// it reports attached` — VS Code keeps a closed window's pty alive for
// VSCODE_RECONNECTION_GRACE_TIME (3h by default), so the tmux client inside it stays
// *attached* long after the window is gone. reconcile() read that `attached` flag as
// "another machine holds this", refused to re-attach, and handed the user a brand-new
// empty terminal while their real work (an htop, a Claude Code run) sat in an
// unreachable session. Confirmed live: session `code-8282129a2247-0` running htop,
// orphan client on /dev/pts/0 stale by 158s, user saw an empty shell.

/** A slot with nothing going on — spread over with the case under test. */
const BASE: SlotInput = { slot: 0, mapped: false, openHere: false, remote: undefined };

const live = (attached: boolean, windows = 1) => ({ attached, windows });

describe('decideSlotAction: the slot state machine', () => {
    it('skips a slot already backing an open terminal in this window (no mirrored tab)', () => {
        // Guards the re-resolve path: a reconnect re-runs reconcile over the same mapping.
        const d = decideSlotAction({ ...BASE, mapped: true, openHere: true, remote: live(true) });
        expect(d.action).toBe('skip');
        expect(d.reason).toMatch(/open/i);
    });

    // There is deliberately no "the user closed this one" input any more. The old
    // `tombstoned` flag made a user-closed slot skip BOTH restore and adoption while its
    // tmux session kept running on the remote forever — an invisible, unreachable session,
    // i.e. exactly the zombie this fork promises never to create. Observed in the field:
    // `code-bcb9aa492263-2` alive with a shell in it, logged as
    // `tombstoned=yes -> skip (user-closed)`, with no way for the user to ever see it again.
    // An explicit close now KILLS the session (`handleTerminalClosed`), so by the time
    // reconcile runs there is nothing left to skip and this decision has one less input.
    it('restores a mapped detached session even if the user once closed its terminal', () => {
        // Post-kill, a user-closed slot is either gone from the remote (-> caller prunes via
        // has-session) or still live because the kill could not be delivered — in which case
        // re-attaching is the only outcome that keeps the session reachable.
        expect(decideSlotAction({ ...BASE, mapped: true, remote: live(false) }).action).toBe('restore');
    });

    // Deliberately NOT 'prune'. `refreshRemote()` returns an empty list when the probe
    // channel *fails*, so "absent from the snapshot" and "does not exist" are
    // indistinguishable here. Pruning on absence would wipe every mapping on one network
    // blip — the caller settles existence with a narrower `has-session` probe instead.
    it('attempts restore (not prune) for a mapped slot missing from the snapshot', () => {
        const d = decideSlotAction({ ...BASE, mapped: true, remote: undefined });
        expect(d.action).toBe('restore');
        expect(d.reason).toMatch(/has-session/);
    });

    it('restores a mapped, live, detached session', () => {
        expect(decideSlotAction({ ...BASE, mapped: true, remote: live(false) }).action).toBe('restore');
    });

    // THE REGRESSION. Ours + attached = our own zombie pty from a closed window, not a
    // second machine — the mapping is client-local, so nothing another machine created
    // can be in it. Reclaim with `-D` (verified on real tmux 3.4: evicts the stale client,
    // attaches the new one, leaves the running process untouched).
    it('reclaims a slot this client owns even when it reports attached', () => {
        const d = decideSlotAction({ ...BASE, mapped: true, remote: live(true) });
        expect(d.action).toBe('restore-takeover');
        expect(d.reason).toMatch(/reclaim/i);
    });

    // The no-steal invariant, preserved exactly: an attached session we never mapped
    // belongs to another machine. Touching it would mirror keystrokes into their terminal.
    it('never touches an attached session this client does not own', () => {
        const d = decideSlotAction({ ...BASE, mapped: false, remote: live(true) });
        expect(d.action).toBe('skip');
        expect(d.reason).toMatch(/another client|no steal/i);
    });

    it('adopts a detached orphan of this workspace (PC closed -> laptop takes over)', () => {
        expect(decideSlotAction({ ...BASE, mapped: false, remote: live(false) }).action).toBe('adopt');
    });

    // No windows===0 special case: a zero-window session cannot appear in `list-sessions`
    // because tmux destroys it (verified against real tmux 3.4 — `#{session_windows}` was
    // never below 1 in any reproducible state). Adopting is the right answer for the input
    // regardless, and a dead branch here would only re-import a predicate already proven
    // unreachable once in the reap decision.
    it('adopts a detached session regardless of window count (zero-window is unreachable)', () => {
        expect(decideSlotAction({ ...BASE, mapped: false, remote: live(false, 0) }).action).toBe('adopt');
    });

    it('does nothing for an unmapped slot with no remote session', () => {
        expect(decideSlotAction(BASE).action).toBe('skip');
    });

    // Precedence matters: openHere must win over ownership, because it is about THIS
    // window's tabs — acting again on an already-open slot is what produced duplicate
    // mirrored tabs on re-resolve.
    it('orders precedence: open > ownership', () => {
        expect(decideSlotAction({ ...BASE, mapped: true, openHere: true, remote: live(true) }).reason)
            .toMatch(/open/i);
    });
});

describe('describeSlot: one greppable log line per slot', () => {
    // Debuggability was the other half of this bug: the old log said only "slot 0 attached
    // elsewhere", which stated a conclusion and hid every input that produced it. A log
    // line has to carry the observed state, not just the verdict.
    it('reports the observed state and the resulting action', () => {
        const line = describeSlot({ ...BASE, slot: 3, mapped: true, remote: live(true, 2) });
        expect(line).toContain('slot 3');
        expect(line).toContain('mapped=yes');
        expect(line).toContain('attached=yes');
        expect(line).toContain('windows=2');
        expect(line).toContain('restore-takeover');
    });

    it('renders a slot with no remote session without inventing fields', () => {
        const line = describeSlot({ ...BASE, slot: 1, mapped: true });
        expect(line).toContain('slot 1');
        expect(line).toContain('remote=none');
        expect(line).toContain('restore');
    });
});
