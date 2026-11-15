import type * as vscode from 'vscode';

/** `globalState` key of the most-recently-connected destinations. */
export const RECENT_HOSTS_STORAGE_KEY = 'recentHosts_v0';

/** How many recent destinations are remembered. */
export const MAX_RECENT_HOSTS = 10;

/** `host` first, any earlier occurrence removed, capped at `MAX_RECENT_HOSTS`. */
export function pushRecent(list: readonly string[], host: string): string[] {
    return [host, ...list.filter(entry => entry !== host)].slice(0, MAX_RECENT_HOSTS);
}

/** The stored value is untrusted (older build, truncated write): keep unique non-empty strings. */
function normalize(raw: unknown): string[] {
    if (!Array.isArray(raw)) {
        return [];
    }
    const hosts = raw.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0);
    return [...new Set(hosts)].slice(0, MAX_RECENT_HOSTS);
}

/**
 * Most-recently-connected SSH destinations (as `[user@]host[:port]`), for the "Connect to
 * Host..." pick. Separate from `RemoteLocationHistory`: that records only windows with a
 * folder open, keyed by hostname in insertion order, so it cannot say which host was used
 * last. Read through to `globalState` on every call — it is shared by every window.
 */
export class RecentHosts {
    constructor(private readonly memento: Pick<vscode.Memento, 'get' | 'update'>) {
    }

    list(): string[] {
        return normalize(this.memento.get(RECENT_HOSTS_STORAGE_KEY));
    }

    async add(host: string): Promise<void> {
        await this.memento.update(RECENT_HOSTS_STORAGE_KEY, pushRecent(this.list(), host));
    }
}
