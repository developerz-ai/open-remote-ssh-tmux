import type { HandOffPolicy } from './slotState';

// What a change to `remote.SSH.tmux.*` means for a window that is already connected. Before
// this, the settings were read once at wiring, so a change did nothing until a reload — and
// turning the feature off left this workspace's sessions running where nothing would ever
// list them again. The decision is pure (old settings, new settings, is the layer wired) so
// every row of it is unit-tested; `extension.ts` only carries the action out.

/** The settings the decision compares — a structural subset of `extension.ts`'s
 * `TmuxSettings`, declared here so this module never imports upward. */
export interface WatchedTmuxSettings {
    readonly enabled: string;
    readonly historyLimit: number;
    readonly handOff: HandOffPolicy;
    readonly setDefaultProfile: boolean;
    readonly reapOnConnect: boolean;
    readonly orphanMaxAgeDays: number;
}

/**
 * What to do about a settings change:
 *  - `rewire` — (re)build the layer from scratch: persistent terminals were turned (back) on,
 *    or `on` ↔ `auto` changed while unwired (`on` must say now that tmux is missing);
 *  - `refresh` — the wired layer takes the new values as they are: new terminals get the new
 *    scrollback, the next reconcile the new hand-off policy, the default profile is reconciled;
 *  - `offer-cleanup` — turned off while wired: unwire, and offer to close this workspace's
 *    sessions that are still running (they would otherwise run unseen);
 *  - `none` — nothing to do now. `reapOnConnect` and `orphanMaxAgeDays` are read by every
 *    housekeeping pass, i.e. at the next (re)connect.
 */
export type SettingsChangeAction = 'rewire' | 'refresh' | 'offer-cleanup' | 'none';

export function decideSettingsChange(
    previous: WatchedTmuxSettings,
    next: WatchedTmuxSettings,
    wired: boolean,
): SettingsChangeAction {
    if (next.enabled === 'off') {
        return wired ? 'offer-cleanup' : 'none';
    }
    if (!wired) {
        return previous.enabled !== next.enabled ? 'rewire' : 'none';
    }
    const liveChange = previous.historyLimit !== next.historyLimit
        || previous.handOff !== next.handOff
        || previous.setDefaultProfile !== next.setDefaultProfile;
    return liveChange ? 'refresh' : 'none';
}
