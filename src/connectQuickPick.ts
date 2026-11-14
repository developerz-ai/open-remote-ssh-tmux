import * as vscode from 'vscode';
import SSHConfiguration from './ssh/sshConfig';
import SSHDestination from './ssh/sshDestination';
import { hostAddress } from './hostPresentation';
import { rootHostList } from './hostTreeView';
import type { RemoteLocationHistory } from './remoteLocationHistory';
import type { RecentHosts } from './recentHosts';

/** What accepting an entry of the "Connect to Host..." pick does. */
export type ConnectAction =
    | { readonly kind: 'connect'; readonly destination: string }
    | { readonly kind: 'add' }
    | { readonly kind: 'configure' };

export interface ConnectPickItem extends vscode.QuickPickItem {
    readonly action?: ConnectAction;
}

/** The hosts the pick lists. */
export interface ConnectPickSources {
    /** Most recently connected destinations, freshest first. */
    readonly recent: readonly string[];
    /** Every other known host: the SSH config's, then hosts only the folder history knows. */
    readonly hosts: readonly string[];
    /** `user@hostname:port` a host resolves to, for its description. */
    address(host: string): string;
}

export const ADD_HOST_LABEL = 'Add New SSH Host...';
export const CONFIGURE_HOSTS_LABEL = 'Configure SSH Hosts...';

function separator(label: string): ConnectPickItem {
    return { label, kind: vscode.QuickPickItemKind.Separator };
}

/**
 * The pick's entries: recent hosts first (under a heading only when there are any), then the
 * remaining hosts, then "Add New SSH Host..." and "Configure SSH Hosts...".
 */
export function buildConnectItems(sources: ConnectPickSources): ConnectPickItem[] {
    const hostItem = (host: string): ConnectPickItem => {
        const address = sources.address(host);
        return { label: host, description: address !== host ? address : undefined, action: { kind: 'connect', destination: host } };
    };
    const recent = [...new Set(sources.recent)];
    const others = sources.hosts.filter(host => !recent.includes(host));
    const items: ConnectPickItem[] = [];
    if (recent.length > 0) {
        items.push(separator('recently connected'), ...recent.map(hostItem));
        if (others.length > 0) {
            items.push(separator('other hosts'));
        }
    }
    items.push(...others.map(hostItem));
    items.push(
        separator(''),
        { label: ADD_HOST_LABEL, action: { kind: 'add' } },
        { label: CONFIGURE_HOSTS_LABEL, action: { kind: 'configure' } },
    );
    return items;
}

/** An entry for what the user typed when it is a destination the list does not have —
 * so an unlisted `[user@]host[:port]` connects, as the old input box allowed. */
export function typedItem(value: string, items: readonly ConnectPickItem[]): ConnectPickItem | undefined {
    const destination = value.trim();
    if (!destination || !SSHDestination.parse(destination).hostname) {
        return undefined;
    }
    if (items.some(item => item.action?.kind === 'connect' && item.action.destination === destination)) {
        return undefined;
    }
    return { label: destination, description: 'connect to this destination', alwaysShow: true, action: { kind: 'connect', destination } };
}

/** The selected entry's action, else connect to the typed value (left for the caller to
 * validate, so a malformed one gets the same error as before), else nothing. */
export function acceptedAction(selected: ConnectPickItem | undefined, value: string): ConnectAction | undefined {
    if (selected?.action) {
        return selected.action;
    }
    const destination = value.trim();
    return destination ? { kind: 'connect', destination } : undefined;
}

/**
 * Show the pick and resolve the destination to connect to, or undefined when the user
 * dismissed it or chose add/configure (which run here, via `actions`).
 */
export async function pickConnectDestination(
    loadSources: () => Promise<ConnectPickSources>,
    actions: { add(): Promise<void>; configure(): Promise<void> },
): Promise<string | undefined> {
    const items = buildConnectItems(await loadSources());
    const pick = vscode.window.createQuickPick<ConnectPickItem>();
    pick.title = 'Connect to Host';
    pick.placeholder = 'Select a host or enter [user@]hostname[:port]';
    pick.matchOnDescription = true;
    pick.items = items;

    const action = await new Promise<ConnectAction | undefined>(resolve => {
        const listeners = [
            pick.onDidChangeValue(value => {
                // After the hosts, before add/configure: typing a prefix of a host keeps
                // that host the active entry instead of connecting to the half-typed name.
                const typed = typedItem(value, items);
                const footerStart = items.findIndex(item => item.action?.kind === 'add') - 1;
                pick.items = typed ? [...items.slice(0, footerStart), typed, ...items.slice(footerStart)] : items;
            }),
            pick.onDidAccept(() => {
                resolve(acceptedAction(pick.selectedItems[0], pick.value));
                pick.hide();
            }),
            pick.onDidHide(() => {
                resolve(undefined);
                listeners.forEach(listener => listener.dispose());
                pick.dispose();
            }),
        ];
        pick.show();
    });

    if (action?.kind === 'add') {
        await actions.add();
    } else if (action?.kind === 'configure') {
        await actions.configure();
    }
    return action?.kind === 'connect' ? action.destination : undefined;
}

/** The pick's sources for this profile: recent destinations, configured + remembered hosts. */
export async function loadConnectPickSources(recentHosts: RecentHosts, locationHistory: RemoteLocationHistory): Promise<ConnectPickSources> {
    const config = await SSHConfiguration.loadFromFS();
    return {
        recent: recentHosts.list(),
        hosts: rootHostList(config.getAllConfiguredHosts(), locationHistory.getHosts()),
        address: host => hostAddress(host, config.getHostConfiguration(SSHDestination.parse(host).hostname)),
    };
}
