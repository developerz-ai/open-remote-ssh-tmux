// The slot lifecycle as ONE explicit decision.
//
// Previously these rules lived inline in `TerminalProvider#reconcile`, spread across
// five overlapping sets (`mapping`, `openSlots`, `attachedRemoteSlots`, `reservedSlots`,
// `tombstones`) and two loops. That shape hid a field bug for a whole release: VS Code
// keeps a closed window's pty alive for `VSCODE_RECONNECTION_GRACE_TIME` (3h by
// default), so the tmux client inside it stays *attached* long after the window is gone.
// `reconcile` read that `attached` flag as "another machine holds this", refused to
// re-attach, and handed the user a brand-new empty terminal while their real work sat in
// a session they could no longer see. Observed live: session `code-8282129a2247-0`
// running `htop`, its orphan client on `/dev/pts/0` stale by 158 seconds.
//
// The fix rests on one fact: **the persisted slot mapping is client-local**
// (`context.workspaceState`), so a slot in our mapping is one THIS machine created.
// Nothing another machine owns can be in it. So "mapped AND attached" cannot mean a
// second client — it means our own zombie pty, and reclaiming it (tmux `-A -D`, which
// evicts the stale client and leaves the running process untouched — verified against a
// real tmux 3.4 server) is taking back what is ours, not stealing.
//
// Keeping the decision pure and separate buys three things: the no-steal invariant is
// stated once instead of re-derived at each call site; every state is unit-testable
// without a tmux server or a live VS Code; and {@link describeSlot} can log the observed
// inputs next to the verdict, which is what the old "slot 0 attached elsewhere" line
// failed to do — it printed a conclusion and hid every input that produced it.

/** What the remote reports about a slot's session right now, or `undefined` when the
 * remote has no session for this slot. Mirrors the fields `list-sessions` yields. */
export interface RemoteSlotState {
    /** `#{session_attached}` — some tmux client is on it. NOT proof of another machine. */
    readonly attached: boolean;
    /** `#{session_windows}`. Zero means an empty corpse the reaper owns. */
    readonly windows: number;
}

/** Everything the decision needs, gathered by the caller. Pure data — no VS Code, no ssh. */
export interface SlotInput {
    readonly slot: number;
    /** In this client's persisted slot→session mapping, i.e. THIS machine created it. */
    readonly mapped: boolean;
    /** Already backing an open terminal in this window right now. */
    readonly openHere: boolean;
    /** The remote's view, or `undefined` if no such session exists there. */
    readonly remote?: RemoteSlotState;
}

/**
 * What to do with a slot:
 *  - `restore-takeover` — ours and reachable, but a client (our own stale pty) is on it:
 *    re-attach with tmux `-D` to evict that client first.
 *  - `restore` — ours, live, and free: plain attach.
 *  - `adopt` — a detached orphan of this workspace no one holds (hand-off: PC closed →
 *    laptop takes over).
 *  - `skip` — do nothing, for the reason carried alongside.
 *
 * Note there is deliberately no `prune`: whether a mapped session still EXISTS is not
 * decidable from the `list-sessions` snapshot, because that probe degrades to "no
 * sessions" when the channel fails. Pruning on absence would wipe every mapping on one
 * transient blip. The caller settles existence with a narrower `has-session` probe and
 * prunes on that — see `TmuxTerminalProvider#reconcile`.
 */
export type SlotAction = 'restore-takeover' | 'restore' | 'adopt' | 'skip';

/** A decision plus the reason, which goes straight into the log so a support log explains
 * itself without a rebuild. */
export interface SlotDecision {
    readonly action: SlotAction;
    readonly reason: string;
}

/**
 * Resolve one slot's state. Precedence is deliberate and load-bearing:
 *
 *  1. `openHere` wins over everything — it is about THIS window's tabs, and acting again
 *     on an already-open slot is what produced duplicate mirrored tabs on re-resolve.
 *  2. Then ownership: ours (`mapped`) → restore/reclaim; not ours → adopt only if
 *     genuinely unheld.
 *
 * There is deliberately no "the user closed this one" input. An earlier version carried a
 * `tombstoned` flag that made such a slot skip BOTH restore and adoption — while its tmux
 * session went on running on the remote, reachable by nothing and surviving every reload.
 * That is the zombie this fork exists to prevent, and it shipped: field logs showed
 * `slot 2: tombstoned=yes -> skip (user-closed)` next to a live `code-…-2` in `tmux ls`.
 * An explicit close now kills the session outright (`TmuxTerminalProvider#handleTerminalClosed`),
 * so there is never a survivor left for this decision to have an opinion about.
 */
export function decideSlotAction(input: SlotInput): SlotDecision {
    if (input.openHere) {
        return { action: 'skip', reason: 'already open in this window' };
    }

    const remote = input.remote;
    if (input.mapped) {
        if (!remote) {
            // Absent from the snapshot is NOT proof it is gone: `list-sessions` degrades
            // to "no sessions" on a channel failure, so pruning here would wipe the whole
            // mapping on one blip. Attempt the restore and let the caller's `has-session`
            // probe decide whether it truly exists.
            return { action: 'restore', reason: 'ours, not in snapshot — verifying with has-session' };
        }
        // Ours + attached = our own orphaned pty from a closed window (the mapping is
        // client-local, so no other machine's client can be here). Reclaim it.
        return remote.attached
            ? { action: 'restore-takeover', reason: 'ours but held by a stale client — reclaiming with -D' }
            : { action: 'restore', reason: 'ours and detached — re-attaching' };
    }

    if (!remote) {
        return { action: 'skip', reason: 'nothing here' };
    }
    if (remote.attached) {
        // The no-steal invariant, unchanged: not ours and someone is on it. Re-attaching
        // would mirror keystrokes into another machine's live terminal.
        return { action: 'skip', reason: 'attached by another client — no steal' };
    }
    // Deliberately no `windows === 0` guard here. That predicate is unreachable: a session
    // with zero windows does not exist — tmux destroys it — so `list-sessions` never yields
    // one. It was carried over from an earlier version of the reap decision where it had
    // already been proven dead, and re-adding it here would just restore a branch that
    // cannot run while implying a corpse state that our sessions (created with
    // `remain-on-exit off`) never reach. Confirmed against real tmux 3.4: `#{session_windows}`
    // was never below 1 across every session state reproducible on a live server.
    return { action: 'adopt', reason: 'detached orphan of this workspace — adopting' };
}

/**
 * One greppable log line carrying the observed inputs *and* the verdict. The line this
 * replaces ("slot 0 attached elsewhere — not re-attaching") stated only a conclusion, so
 * a user's log could not distinguish the correct no-steal case from the bug. Print the
 * evidence, not just the ruling.
 */
export function describeSlot(input: SlotInput): string {
    const { action, reason } = decideSlotAction(input);
    const remote = input.remote
        ? `attached=${yesNo(input.remote.attached)} windows=${input.remote.windows}`
        : 'remote=none';
    return `slot ${input.slot}: mapped=${yesNo(input.mapped)} `
        + `open=${yesNo(input.openHere)} ${remote} -> ${action} (${reason})`;
}

function yesNo(value: boolean): string {
    return value ? 'yes' : 'no';
}
