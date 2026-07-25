import * as vscode from 'vscode';
import { REMOTE_SSH_AUTHORITY } from './authResolver';
import SSHDestination from './ssh/sshDestination';

/** `globalState` key the recent-locations map is persisted under. Exported so
 *  tests seed/inspect the exact slot the class reads and writes. */
export const HISTORY_STORAGE_KEY = 'remoteLocationHistory_v0';

/** Upper bound on remembered locations per host — keeps `globalState` (and the
 *  "SSH Targets" tree) from growing without limit as workspaces are opened. */
export const MAX_LOCATIONS_PER_HOST = 20;

/**
 * Coerce an arbitrary persisted value into the `{ host: string[] }` shape.
 *
 * The stored value is untrusted: an older build, a truncated write, or a
 * concurrent editor can leave a non-object root, a non-array host entry, or an
 * array with non-string members. A malformed value reaching the tree view
 * (`element.locations.map(...)`) throws and breaks the whole panel — and this map
 * is loaded eagerly by `activate()`, so a bad shape used to take every command
 * down with it. Normalise once, on read, and never trust the raw shape.
 */
function normalizeHistory(raw: unknown): Record<string, string[]> {
    const result: Record<string, string[]> = {};
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
        return result;
    }

    for (const [host, locations] of Object.entries(raw as Record<string, unknown>)) {
        if (!Array.isArray(locations)) {
            continue;
        }
        const paths = locations
            .filter((location): location is string => typeof location === 'string')
            .slice(0, MAX_LOCATIONS_PER_HOST);
        if (paths.length > 0) {
            result[host] = paths;
        }
    }

    return result;
}

export class RemoteLocationHistory {
    private remoteLocationHistory: Record<string, string[]> = {};

    constructor(private context: vscode.ExtensionContext) {
        this.remoteLocationHistory = this.read();
    }

    /** Locations remembered for `host`, freshest first.
     *
     *  Read through to `globalState` rather than answering from the constructor's snapshot:
     *  that storage is shared by every window of the profile, and the window *showing* the
     *  tree is usually not the window that opened the folder. Answering from the snapshot
     *  made an already-open "SSH Targets" view permanently stale — its own Refresh command
     *  could not fix it either, since refresh re-fires the tree event and never re-read
     *  storage. The read is a `Map` lookup plus a normalise of a ≤20-entries-per-host object,
     *  on a user-driven tree render; the staleness cost far more than the parse does. */
    getHistory(host: string): string[] {
        this.remoteLocationHistory = this.read();
        return this.remoteLocationHistory[host] ?? [];
    }

    /** Every host with at least one remembered location, in storage order.
     *
     *  The tree needs this because a remembered host is not necessarily a *configured* one:
     *  connecting by FQDN records the folder under that FQDN, which may appear nowhere in the
     *  user's SSH config. See `rootHostList` in `hostTreeView.ts`. */
    getHosts(): string[] {
        this.remoteLocationHistory = this.read();
        return Object.keys(this.remoteLocationHistory);
    }

    async addLocation(host: string, path: string) {
        const history = this.read();
        const existing = history[host] ?? [];
        // Dedupe + MRU: the freshly-opened path moves to the front (rather than
        // duplicating if it was already remembered), and the list is capped.
        history[host] = [path, ...existing.filter(location => location !== path)].slice(0, MAX_LOCATIONS_PER_HOST);

        await this.write(history);
    }

    async removeLocation(host: string, path: string) {
        const history = this.read();
        const remaining = (history[host] ?? []).filter(location => location !== path);
        if (remaining.length > 0) {
            history[host] = remaining;
        } else {
            delete history[host];
        }

        await this.write(history);
    }

    /** Load the latest persisted, normalised history. Re-read before every mutate:
     *  `globalState` is shared across every window of this profile, so writing a
     *  whole map off a stale in-memory copy would clobber another window's
     *  additions. Read → merge → write narrows that last-writer-wins race. */
    private read(): Record<string, string[]> {
        return normalizeHistory(this.context.globalState.get(HISTORY_STORAGE_KEY));
    }

    private async write(history: Record<string, string[]>): Promise<void> {
        this.remoteLocationHistory = history;
        await this.context.globalState.update(HISTORY_STORAGE_KEY, history);
    }
}

export function getRemoteWorkspaceLocationData(): [string, string] | undefined {
    const workspaceFile = vscode.workspace.workspaceFile;
    if (workspaceFile && workspaceFile.path.endsWith('.code-workspace')) {
        const data = remoteLocationFromUri(workspaceFile);
        if (data) {
            return data;
        }
    }

    // `?.[0]?.uri` (not `?.[0].uri`): `workspaceFolders` is `undefined` with no
    // folder open but an EMPTY ARRAY for an empty-folder workspace — indexing `[0]`
    // then yields `undefined`, and dereferencing `.uri` on it threw and killed
    // `activate()` (leaving every command "not found"). Guard the element too.
    const folderUri = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (folderUri) {
        return remoteLocationFromUri(folderUri);
    }

    return undefined;
}

/**
 * Extract `[hostname, path]` from a workspace URI iff it is an SSH remote of THIS
 * extension.
 *
 * Match `REMOTE_SSH_AUTHORITY + '+'`, not a bare `startsWith(REMOTE_SSH_AUTHORITY)`
 * which also swallows a different remote type whose id merely shares the prefix
 * (`ssh-remote2+…`). Split on the FIRST `'+'` only via `substring` — the encoded
 * host payload can itself contain `'+'`, which a plain `split('+')[1]` would
 * truncate.
 */
function remoteLocationFromUri(uri: vscode.Uri): [string, string] | undefined {
    const prefix = `${REMOTE_SSH_AUTHORITY}+`;
    if (uri.scheme !== 'vscode-remote' || !uri.authority.startsWith(prefix)) {
        return undefined;
    }

    const encodedHost = uri.authority.substring(prefix.length);
    const sshDest = SSHDestination.parseEncoded(encodedHost);
    return [sshDest.hostname, uri.path];
}
