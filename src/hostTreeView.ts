import * as vscode from 'vscode';
import * as path from 'path';
import SSHConfiguration, { getSSHConfigPath } from './ssh/sshConfig';
import { RemoteLocationHistory } from './remoteLocationHistory';
import { Disposable } from './common/disposable';
import { addNewHost, openRemoteSSHLocationWindow, openRemoteSSHWindow, openSSHConfigFile } from './commands';
import SSHDestination from './ssh/sshDestination';

class HostItem {
    constructor(
        public hostname: string,
        public locations: string[]
    ) {
    }
}

class HostLocationItem {
    constructor(
        public path: string,
        public hostname: string
    ) {
    }
}

type DataTreeItem = HostItem | HostLocationItem;

/**
 * The tree's root nodes: the user's configured hosts, plus any host we remember a folder for
 * that the config does not name.
 *
 * Those two sets are not the same, which is the bug this exists to fix. A root node used to
 * come *only* from a `Host` entry in the SSH config, while a remembered folder is keyed by the
 * hostname decoded from the remote authority — so connecting to `host.example.com` directly
 * (rather than through a configured alias) recorded the folder under a key with no node to
 * hang it on. It sat in `globalState`, correct and unreachable: reported from the field as
 * "I opened a dir and it's not showing in the list". Wildcard/negated `Host` patterns are
 * excluded from the configured list upstream (they name no single host), which makes a
 * config built out of patterns another way to hit the same dead end.
 *
 * Configured hosts keep their file order — that order is the user's, and re-sorting a list
 * they scan by position would be its own small betrayal. The remembered-only extras go after
 * them, sorted, because `globalState` key order is an implementation detail and a tree that
 * reshuffles itself between renders is worse than one that is merely alphabetical.
 *
 * Pure and exported so the merge rule is unit-testable without standing up TreeItem,
 * EventEmitter and ThemeIcon; the view keeps only presentation.
 */
export function rootHostList(configured: readonly string[], remembered: readonly string[]): string[] {
    const hosts = [...new Set(configured)];
    const known = new Set(hosts);
    const extras = remembered.filter(host => !known.has(host)).sort((a, b) => a.localeCompare(b));
    return [...hosts, ...extras];
}

export class HostTreeDataProvider extends Disposable implements vscode.TreeDataProvider<DataTreeItem> {

    private readonly _onDidChangeTreeData = this._register(new vscode.EventEmitter<DataTreeItem | DataTreeItem[] | void>());
    public readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    constructor(
        private locationHistory: RemoteLocationHistory
    ) {
        super();

        this._register(vscode.commands.registerCommand('openremotessh.explorer.add', () => addNewHost()));
        this._register(vscode.commands.registerCommand('openremotessh.explorer.configure', () => openSSHConfigFile()));
        this._register(vscode.commands.registerCommand('openremotessh.explorer.refresh', () => this.refresh()));
        this._register(vscode.commands.registerCommand('openremotessh.explorer.emptyWindowInNewWindow', e => this.openRemoteSSHWindow(e, false)));
        this._register(vscode.commands.registerCommand('openremotessh.explorer.emptyWindowInCurrentWindow', e => this.openRemoteSSHWindow(e, true)));
        this._register(vscode.commands.registerCommand('openremotessh.explorer.reopenFolderInNewWindow', e => this.openRemoteSSHLocationWindow(e, false)));
        this._register(vscode.commands.registerCommand('openremotessh.explorer.reopenFolderInCurrentWindow', e => this.openRemoteSSHLocationWindow(e, true)));
        this._register(vscode.commands.registerCommand('openremotessh.explorer.deleteFolderHistoryItem', e => this.deleteHostLocation(e)));

        this._register(vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('remote.SSH.configFile')) {
                this.refresh();
            }
        }));
        this._register(vscode.workspace.onDidSaveTextDocument(e => {
            if (e.uri.fsPath === getSSHConfigPath()) {
                this.refresh();
            }
        }));
    }

    getTreeItem(element: DataTreeItem): vscode.TreeItem {
        if (element instanceof HostLocationItem) {
            const label = path.posix.basename(element.path).replace(/\.code-workspace$/, ' (Workspace)');
            const treeItem = new vscode.TreeItem(label);
            treeItem.description = path.posix.dirname(element.path);
            treeItem.iconPath = new vscode.ThemeIcon('folder');
            treeItem.contextValue = 'openremotessh.explorer.folder';
            return treeItem;
        }

        const treeItem = new vscode.TreeItem(element.hostname);
        treeItem.collapsibleState = element.locations.length ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None;
        treeItem.iconPath = new vscode.ThemeIcon('vm');
        treeItem.contextValue = 'openremotessh.explorer.host';
        return treeItem;
    }

    async getChildren(element?: HostItem): Promise<DataTreeItem[]> {
        if (!element) {
            const sshConfigFile = await SSHConfiguration.loadFromFS();
            const hosts = rootHostList(sshConfigFile.getAllConfiguredHosts(), this.locationHistory.getHosts());
            return hosts.map(hostname => new HostItem(hostname, this.locationHistory.getHistory(hostname)));
        }
        if (element instanceof HostItem) {
            return element.locations.map(location => new HostLocationItem(location, element.hostname));
        }
        return [];
    }

    private refresh() {
        this._onDidChangeTreeData.fire();
    }

    private async deleteHostLocation(element: HostLocationItem) {
        await this.locationHistory.removeLocation(element.hostname, element.path);
        this.refresh();
    }

    private async openRemoteSSHWindow(element: HostItem, reuseWindow: boolean) {
        // `element.hostname` is a Host alias/value straight from the user's SSH
        // config, so route it through the same `SSHDestination.parse` boundary as
        // every other command-input site (user@/port/bracketed-IPv6 aware) rather
        // than the raw-string constructor.
        const sshDest = SSHDestination.parse(element.hostname);
        openRemoteSSHWindow(sshDest.toEncodedString(), reuseWindow);
    }

    private async openRemoteSSHLocationWindow(element: HostLocationItem, reuseWindow: boolean) {
        const sshDest = SSHDestination.parse(element.hostname);
        openRemoteSSHLocationWindow(sshDest.toEncodedString(), element.path, reuseWindow);
    }
}
