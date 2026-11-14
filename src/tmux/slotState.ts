// The slot lifecycle as ONE explicit decision, including the one question two machines can
// disagree on: who may take a session that a tmux client is still attached to.
//
// Ownership comes from the remote, not from our own records. Every attach writes this
// window's client id into the session (`@orst_owner`, see `clientIdentity.ts` and
// `buildAttachOrCreateArgv`), so `list-sessions` says whose client is on it. The persisted
// slot mapping is client-local and says only "this machine once had it" — it used to be
// read as ownership, and that broke the moment a session moved between machines: PC maps
// slot 0, the laptop adopts it, PC's mapping still lists it, and PC's next reconnect
// "reclaimed" it with `-A -D`, evicting the laptop's live terminal (and back again on the
// laptop's next reload — a ping-pong). `mapped` now only decides restore-vs-adopt for an
// UNHELD session; a held one is decided by the owner tag:
//
//   * our own id on it — our own pty from a window that closed or crashed, which VS Code
//     keeps alive for `VSCODE_RECONNECTION_GRACE_TIME` (3 h). Reclaim it (`-D` evicts that
//     client and leaves the running process untouched — verified on real tmux).
//   * someone else's id, or none (a session from before tags existed) — another machine's
//     client. It is taken over silently only when it is provably stale (see
//     {@link isClientStale}); a live one is offered to the user, never taken, and the
//     `remote.SSH.tmux.handOff` setting can make even that a plain skip.
//
// Keeping the decision pure buys three things: the no-steal invariant is stated once instead
// of re-derived at each call site; every state is unit-testable without a tmux server; and
// {@link describeSlot} logs the observed inputs next to the verdict, so a support log
// explains itself.

/** `remote.SSH.tmux.handOff`: what to do with a session another machine's client holds.
 *  - `auto` — take over a provably stale client silently; offer a live one;
 *  - `ask` — offer every held session, stale or not; never take one without a click;
 *  - `never` — leave held sessions alone. */
export type HandOffPolicy = 'auto' | 'ask' | 'never';

/** The policy a missing or hand-edited setting value falls back to (package.json default). */
export const DEFAULT_HAND_OFF: HandOffPolicy = 'auto';

/** Read a raw `remote.SSH.tmux.handOff` value; anything unrecognised is the default. */
export function toHandOffPolicy(value: unknown): HandOffPolicy {
    return value === 'auto' || value === 'ask' || value === 'never' ? value : DEFAULT_HAND_OFF;
}

/** Whose client the session's `@orst_owner` tag names: this window's, another's, or nobody's
 * (no tag — a session created before tags existed, or a tmux that cannot report it). */
export type SlotOwner = 'me' | 'other' | 'unknown';

/**
 * How long a foreign client must have been idle before it counts as abandoned.
 *
 * `#{client_activity}` is what that idleness is measured on, and the rig settled what moves
 * it: keystrokes (and mouse input) through that client do, output does not — a pane printing
 * every second left it unchanged. So a laptop that slept or a VS Code that was killed stops
 * moving it, but so does a window someone is merely watching. Two minutes is the trade:
 * long enough that a hand-off never races a person still typing on the other machine, short
 * enough that "closed the lid, opened the laptop" does not ask a question.
 */
export const STALE_CLIENT_SECONDS = 120;

/**
 * True iff every client on the session has been idle for at least `thresholdSeconds`.
 * `activities` are those clients' `#{client_activity}` epochs and `now` the remote's clock
 * (both remote-side, so the two machines' clock skew never enters). No clients known → not
 * stale: absent evidence must never license `-D`.
 */
export function isClientStale(activities: readonly number[], now: number, thresholdSeconds = STALE_CLIENT_SECONDS): boolean {
    return activities.length > 0 && activities.every(activity => now - activity >= thresholdSeconds);
}

/** What the remote reports about a slot's session right now, or `undefined` when the
 * remote has no session for this slot. Mirrors the fields `list-sessions` yields. */
export interface RemoteSlotState {
    /** `#{session_attached}` — some tmux client is on it. Whose is {@link owner}'s question. */
    readonly attached: boolean;
    /** `#{session_windows}`. Always ≥ 1 for a listed session (tmux destroys a session with
     * its last window), so it is informational only — see the adopt branch below. */
    readonly windows: number;
    /** Who the `@orst_owner` tag names. */
    readonly owner: SlotOwner;
    /** Every client on the session is idle past {@link STALE_CLIENT_SECONDS}. Only gathered
     * for a session held by someone else; `false` whenever it could not be measured. */
    readonly stale: boolean;
}

/** Everything the decision needs, gathered by the caller. Pure data — no VS Code, no ssh. */
export interface SlotInput {
    readonly slot: number;
    /** In this client's persisted slot→session mapping: this machine had it last time. */
    readonly mapped: boolean;
    /** Already backing an open terminal in this window right now. */
    readonly openHere: boolean;
    /** The remote's view, or `undefined` if no such session exists there. */
    readonly remote?: RemoteSlotState;
    readonly handOff: HandOffPolicy;
}

/**
 * What to do with a slot:
 *  - `restore-takeover` — our own client (owner tag is ours) is still on it, from a window
 *    that went away: re-attach with tmux `-D` to evict that stale client first.
 *  - `handoff-takeover` — another machine's client is on it but provably stale: take the
 *    session over with `-D`. The hand-off a closed lid or a crashed window cannot do itself.
 *  - `offer` — another machine's client is on it and live: ask the user, never take it.
 *  - `restore` — ours (mapped) and free: plain attach.
 *  - `adopt` — a detached session of this workspace nobody holds (PC closed → laptop).
 *  - `skip` — do nothing, for the reason carried alongside.
 *
 * Note there is deliberately no `prune`: whether a mapped session still EXISTS is not
 * decidable from the `list-sessions` snapshot, because that probe degrades to "no
 * sessions" when the channel fails. Pruning on absence would wipe every mapping on one
 * transient blip. The caller settles existence with a narrower `has-session` probe and
 * prunes on that — see `TmuxTerminalProvider#plan`.
 */
export type SlotAction = 'restore-takeover' | 'handoff-takeover' | 'offer' | 'restore' | 'adopt' | 'skip';

/** A decision plus the reason, which goes straight into the log so a support log explains
 * itself without a rebuild. */
export interface SlotDecision {
    readonly action: SlotAction;
    readonly reason: string;
    /** The session has demonstrably moved to another machine (its tag names someone else),
     * so this client's mapping entry is stale: drop it, or old entries accumulate and every
     * reconnect re-litigates sessions this machine handed away. Only set where the session is
     * NOT being taken back here. */
    readonly forget: boolean;
}

/**
 * Resolve one slot's state. Precedence is deliberate and load-bearing:
 *
 *  1. `openHere` wins over everything — it is about THIS window's tabs, and acting again
 *     on an already-open slot is what produced duplicate mirrored tabs on re-resolve.
 *  2. An unheld session is ours to restore (mapped) or adopt (not mapped).
 *  3. A held session is decided by its owner tag and, for a foreign one, staleness and the
 *     hand-off policy. Nothing here ever returns a `-D` action for a live foreign client.
 *
 * There is deliberately no "the user closed this one" input. An earlier version carried a
 * `tombstoned` flag that made such a slot skip BOTH restore and adoption — while its tmux
 * session went on running on the remote, reachable by nothing and surviving every reload.
 * That is the zombie this fork exists to prevent, and it shipped. An explicit close now kills
 * the session outright (`TmuxTerminalProvider#handleTerminalClosed`), so there is never a
 * survivor left for this decision to have an opinion about.
 */
export function decideSlotAction(input: SlotInput): SlotDecision {
    if (input.openHere) {
        return keep('skip', 'already open in this window');
    }

    const remote = input.remote;
    if (!remote) {
        // Absent from the snapshot is NOT proof it is gone: `list-sessions` degrades to "no
        // sessions" on a channel failure, so pruning here would wipe the whole mapping on one
        // blip. Attempt the restore and let the caller's `has-session` probe decide.
        return input.mapped
            ? keep('restore', 'ours, not in snapshot — verifying with has-session')
            : keep('skip', 'nothing here');
    }

    if (!remote.attached) {
        // Deliberately no `windows === 0` guard: a session with zero windows does not exist —
        // tmux destroys it — so `list-sessions` never yields one (confirmed on real tmux).
        return input.mapped
            ? keep('restore', 'ours and detached — re-attaching')
            : keep('adopt', 'detached session of this workspace — adopting');
    }

    if (remote.owner === 'me') {
        // Our own tag: the client on it is this window's previous pty, kept alive by VS Code
        // after the window went away. Reclaiming it is taking back what is ours.
        return keep('restore-takeover', 'held by our own stale client — reclaiming with -D');
    }

    // Someone else's client. The tag names another machine (or nobody, for a pre-tag
    // session), so `mapped` is no evidence of ownership any more.
    const forget = remote.owner === 'other';
    if (input.handOff === 'never') {
        return { action: 'skip', reason: 'held by another machine — hand-off is off', forget };
    }
    if (remote.stale && input.handOff === 'auto') {
        return keep('handoff-takeover', 'held by an idle client of another machine — taking over with -D');
    }
    return { action: 'offer', reason: 'held by another machine — offering, never taking', forget };
}

function keep(action: SlotAction, reason: string): SlotDecision {
    return { action, reason, forget: false };
}

/**
 * One greppable log line carrying the observed inputs *and* the verdict. The line this
 * replaced ("slot 0 attached elsewhere — not re-attaching") stated only a conclusion, so a
 * user's log could not distinguish the correct no-steal case from the bug. Print the
 * evidence, not just the ruling.
 */
export function describeSlot(input: SlotInput): string {
    const { action, reason } = decideSlotAction(input);
    const remote = input.remote
        ? `attached=${yesNo(input.remote.attached)} windows=${input.remote.windows} `
            + `owner=${input.remote.owner} stale=${yesNo(input.remote.stale)}`
        : 'remote=none';
    return `slot ${input.slot}: mapped=${yesNo(input.mapped)} `
        + `open=${yesNo(input.openHere)} ${remote} handOff=${input.handOff} -> ${action} (${reason})`;
}

function yesNo(value: boolean): string {
    return value ? 'yes' : 'no';
}
