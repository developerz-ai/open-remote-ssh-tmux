import * as vscode from 'vscode';
import Log from './common/logger';
import { RemoteSSHResolver, REMOTE_SSH_AUTHORITY } from './authResolver';
import { KILL_WORKSPACE_SESSIONS_COMMAND_ID, killWorkspaceSessions, openSSHConfigFile, promptOpenRemoteSSHWindow, type WorkspaceKillTarget } from './commands';
import { HostTreeDataProvider } from './hostTreeView';
import { getRemoteWorkspaceLocationData, RemoteLocationHistory } from './remoteLocationHistory';
import { TmuxTerminalProvider, type OpenTerminal } from './tmux/terminalProvider';
import { SessionReaper } from './tmux/sessionReaper';

export async function activate(context: vscode.ExtensionContext) {
    const logger = new Log('Remote - SSH');
    context.subscriptions.push(logger);

    const remoteSSHResolver = new RemoteSSHResolver(context, logger);
    context.subscriptions.push(vscode.workspace.registerRemoteAuthorityResolver(REMOTE_SSH_AUTHORITY, remoteSSHResolver));
    context.subscriptions.push(remoteSSHResolver);

    // Wire tmux terminal provider and session reaper after remote resolution completes.
    // The provider/reaper are gated on PR3 capability (tmux available) and PR5 setting
    // (remote.SSH.tmux.enabled). This callback fires after resolve() succeeds, when
    // SSH connection and tmux capability are known.
    remoteSSHResolver.onResolveSuccessfullyCompleted(() => {
        wireTmuxTerminalLayer(context, remoteSSHResolver, logger);
    });

    const locationHistory = new RemoteLocationHistory(context);
    const locationData = getRemoteWorkspaceLocationData();
    if (locationData) {
        await locationHistory.addLocation(locationData[0], locationData[1]);
    }

    const hostTreeDataProvider = new HostTreeDataProvider(locationHistory);
    context.subscriptions.push(vscode.window.createTreeView('sshHosts', { treeDataProvider: hostTreeDataProvider }));
    context.subscriptions.push(hostTreeDataProvider);

    context.subscriptions.push(vscode.commands.registerCommand('openremotessh.openEmptyWindow', () => promptOpenRemoteSSHWindow(false)));
    context.subscriptions.push(vscode.commands.registerCommand('openremotessh.openEmptyWindowInCurrentWindow', () => promptOpenRemoteSSHWindow(true)));
    context.subscriptions.push(vscode.commands.registerCommand('openremotessh.openConfigFile', () => openSSHConfigFile()));
    context.subscriptions.push(vscode.commands.registerCommand('openremotessh.showLog', () => logger.show()));
    context.subscriptions.push(vscode.commands.registerCommand(KILL_WORKSPACE_SESSIONS_COMMAND_ID, () => killWorkspaceSessions(() => resolveKillTarget(remoteSSHResolver, logger))));
}

/**
 * Wire tmux terminal provider and session reaper after remote resolution succeeds.
 * Gated on PR3 capability (tmux available) + PR5 setting (remote.SSH.tmux.enabled).
 * Constructs and registers TmuxTerminalProvider, SessionReaper with injected
 * Log, exec, clock; pushes disposables for cleanup.
 *
 * Called from resolver callback after resolve() completes (SSH connection exists).
 */
function wireTmuxTerminalLayer(
    context: vscode.ExtensionContext,
    resolver: RemoteSSHResolver,
    logger: Log
): void {
    try {
        // PR3 gate: tmux must be available on the remote.
        const capability = resolver.getTmuxCapability();
        if (!capability?.available) {
            // Capability not probed or not available; skip tmux wiring.
            // Base SSH functionality remains unaffected.
            return;
        }

        // PR5 gate: check if tmux is enabled in settings (graceful fallback to 'auto').
        // The setting may not exist yet if PR5 hasn't completed; default to enabled.
        const remoteSSHConfig = vscode.workspace.getConfiguration('remote.SSH');
        const tmuxSetting = remoteSSHConfig.get<string>('tmux.enabled', 'auto');
        if (tmuxSetting === 'off') {
            // Feature is explicitly disabled; skip wiring.
            return;
        }

        // Session identity (host + workspace) — shared with the kill command via
        // currentTmuxSessionContext() so both name this workspace's sessions identically.
        const sessionContext = currentTmuxSessionContext();
        if (!sessionContext) {
            // Not on a remote; shouldn't happen since this is called from the resolve callback.
            return;
        }
        const { hostKey, workspaceKey } = sessionContext;
        const cwd = workspaceKey;

        // Construct the terminal provider with injected dependencies.
        // exec is deferred — it's fetched from the SSH connection when needed.
        const sshConnection = resolver.getSSHConnection();
        if (!sshConnection) {
            // SSH connection should exist by now (resolve() just completed).
            // If not, something went wrong; skip wiring.
            return;
        }

        const exec = async (command: string) => sshConnection.exec(command);
        const openTerminal: OpenTerminal = (options) => vscode.window.createTerminal(options);

        const terminalProvider = new TmuxTerminalProvider({
            ctx: {
                hostKey,
                workspaceKey,
                cwd,
            },
            exec,
            state: context.workspaceState,
            openTerminal,
            log: logger,
            // historyLimit: read from settings if available (PR5)
        });

        // Initialize the provider (restore + adopt sessions from previous clients).
        terminalProvider.initialize()
            .catch((err) => {
                logger.trace(`Failed to initialize tmux provider: ${err instanceof Error ? err.message : String(err)}`);
            });

        // Register the terminal profile provider with VS Code.
        // This makes the provider available for creating terminals on the remote.
        const providerDisposable = vscode.window.registerTerminalProfileProvider('tmux', terminalProvider);
        context.subscriptions.push(providerDisposable);

        // Construct the session reaper (housekeeping for empty/detached sessions).
        // Uses current time as the clock for age-based reap decisions.
        const reaper = new SessionReaper({
            exec,
            now: () => Math.floor(Date.now() / 1000),
            log: logger,
        });

        // Run reaper immediately on connect (cleanup leftover sessions).
        reaper.reap()
            .catch((err) => {
                logger.trace(`Session reaper failed: ${err instanceof Error ? err.message : String(err)}`);
            });

        // Create a disposable for the reaper (so it can be cleaned up, though
        // it has no resources to free — reaper is stateless).
        context.subscriptions.push({
            dispose: () => {
                // No-op; reaper is stateless.
            },
        });

        logger.trace('Tmux terminal layer wired successfully');
    } catch (err) {
        // Wiring failure must never break the connection; log and continue.
        logger.trace(`Tmux wiring failed: ${err instanceof Error ? err.message : String(err)}`);
    }
}

/**
 * The (host, workspace) identity tmux session names are keyed to, derived from the
 * resolved remote authority (`vscode.env.remoteName`) and the open workspace folder.
 * `undefined` when not on a remote. Shared by the terminal-layer wiring and the kill
 * command so both name this workspace's sessions identically.
 */
function currentTmuxSessionContext(): { hostKey: string; workspaceKey: string } | undefined {
    const authority = vscode.env.remoteName; // e.g. "example.com" (without the "ssh-remote+" prefix)
    if (!authority) {
        return undefined;
    }
    const workspaceKey = vscode.workspace.workspaceFolders?.[0]?.uri.path || '/home/user';
    return { hostKey: authority, workspaceKey };
}

/**
 * Build the kill command's target from live resolver state: the current SSH
 * connection's `exec` wrapped in a fresh {@link SessionReaper}, plus the
 * (host, workspace) identity. Returns `undefined` when there is no connection or we
 * are not on a remote, so the command no-ops safely instead of throwing. Wiring
 * only — the reaper owns all tmux/session logic.
 */
function resolveKillTarget(resolver: RemoteSSHResolver, logger: Log): WorkspaceKillTarget | undefined {
    const sshConnection = resolver.getSSHConnection();
    const context = currentTmuxSessionContext();
    if (!sshConnection || !context) {
        return undefined;
    }
    const reaper = new SessionReaper({
        exec: async (command: string) => sshConnection.exec(command),
        now: () => Math.floor(Date.now() / 1000),
        log: logger,
    });
    return { reaper, hostKey: context.hostKey, workspaceKey: context.workspaceKey };
}

export function deactivate() {
}
