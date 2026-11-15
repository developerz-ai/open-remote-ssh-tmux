import { REMOTE_SSH_AUTHORITY } from './authResolver';
import SSHDestination from './ssh/sshDestination';

/**
 * The SSH destination this window is connected to, from `vscode.env.remoteAuthority`
 * (`ssh-remote+<encoded destination>`), or undefined in a local window, under another
 * remote type, or for an authority with no usable host. Matches `ssh-remote+` — not the bare
 * prefix, which `ssh-remote2+…` would also pass — like `remoteLocationFromUri` does.
 */
export function connectedDestination(remoteAuthority: string | undefined): SSHDestination | undefined {
    const prefix = `${REMOTE_SSH_AUTHORITY}+`;
    if (!remoteAuthority?.startsWith(prefix)) {
        return undefined;
    }
    const dest = SSHDestination.parseEncoded(remoteAuthority.substring(prefix.length));
    return dest.hostname ? dest : undefined;
}

/** Is `host` (a tree/pick host: an SSH config alias or a remembered hostname) the one this
 * window is connected to? Compared by hostname — the key the folder history uses too — so a
 * connection made as `me@dev:2222` still marks `dev`. */
export function isConnectedHost(host: string, connected: SSHDestination | undefined): boolean {
    return !!connected && SSHDestination.parse(host).hostname === connected.hostname;
}

/** Is `path` on `host` the folder open in this window (`current` is
 * `getRemoteWorkspaceLocationData()`'s `[hostname, path]`)? */
export function isConnectedFolder(host: string, path: string, current: readonly [string, string] | undefined): boolean {
    return !!current && current[0] === SSHDestination.parse(host).hostname && current[1] === path;
}

function stringValue(value: unknown): string | undefined {
    return typeof value === 'string' && value ? value : undefined;
}

/**
 * `user@hostname:port` for a host, as the SSH config resolves it: what the destination
 * spells out wins, then the config's `User` / `HostName` / `Port`; unset parts are omitted.
 * Display only — the connection itself resolves the config on its own.
 */
export function hostAddress(host: string, config: Readonly<Record<string, unknown>>): string {
    const dest = SSHDestination.parse(host);
    const configPort = stringValue(config.Port);
    const port = dest.port ?? (configPort && /^\d+$/.test(configPort) ? parseInt(configPort, 10) : undefined);
    return new SSHDestination(stringValue(config.HostName) ?? dest.hostname, dest.user ?? stringValue(config.User), port).toString();
}

/** Codicon id + description for a host row. */
export function hostItemLook(connected: boolean): { icon: string; description: string | undefined } {
    return connected ? { icon: 'vm-active', description: 'connected' } : { icon: 'vm', description: undefined };
}

/** Codicon id + description for a remembered-folder row (`parent` is its directory). */
export function folderItemLook(parent: string, connected: boolean): { icon: string; description: string } {
    return connected ? { icon: 'folder-opened', description: `${parent} · connected` } : { icon: 'folder', description: parent };
}
