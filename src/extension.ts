import * as vscode from 'vscode';
import Log from './common/logger';
import { RemoteSSHResolver, REMOTE_SSH_AUTHORITY } from './authResolver';
import { KILL_WORKSPACE_SESSIONS_COMMAND_ID, killWorkspaceSessions, openSSHConfigFile, promptOpenRemoteSSHWindow, type WorkspaceKillTarget } from './commands';
import { HostTreeDataProvider } from './hostTreeView';
import { getRemoteWorkspaceLocationData, RemoteLocationHistory } from './remoteLocationHistory';
import { TmuxTerminalProvider, type OpenTerminal, type RemoteExec } from './tmux/terminalProvider';
import { SessionReaper } from './tmux/sessionReaper';

export async function activate(context: vscode.ExtensionContext) {
    const logger = new Log('Remote - SSH');
    context.subscriptions.push(logger);

    const remoteSSHResolver = new RemoteSSHResolver(context, logger);
    context.subscriptions.push(vscode.workspace.registerRemoteAuthorityResolver(REMOTE_SSH_AUTHORITY, remoteSSHResolver));
    context.subscriptions.push(remoteSSHResolver);

    // Wire tmux terminal provider and session reaper after remote resolution completes.
    // The provider/reaper are gated on PR3 capability (tmux available) and PR5 setting
    // (remote.SSH.tmux.enabled). This callback fires after *every* resolve() succeeds —
    // including reconnects — so it wires the layer exactly once and only refreshes it
    // thereafter (idempotentResolveHandler): re-registering the terminal profile
    // provider throws "already registered" and would orphan the live provider.
    remoteSSHResolver.onResolveSuccessfullyCompleted(
        idempotentResolveHandler(() => wireTmuxTerminalLayer(context, remoteSSHResolver, logger))
    );

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
 * Called from the resolver callback after resolve() completes. Returns a
 * {@link TmuxTerminalLayer} handle whose `refresh()` a later resolve (reconnect)
 * calls instead of wiring again, or `undefined` when a gate is unmet (capability
 * unavailable / setting off / not on a remote) or wiring throws — so the wrapping
 * {@link idempotentResolveHandler} retries wiring on the next resolve.
 */
function wireTmuxTerminalLayer(
    context: vscode.ExtensionContext,
    resolver: RemoteSSHResolver,
    logger: Log
): TmuxTerminalLayer | undefined {
    try {
        // Read the three remote.SSH.tmux.* settings once, up front. `enabled` is read
        // BEFORE the capability probe so an explicit `'on'` ("require tmux") can surface
        // a user-visible error when the remote can't provide tmux, instead of silently
        // skipping like `'auto'` does — see decideTmuxWiring.
        const settings = readTmuxSettings();

        // PR3 + PR5 gate combined: decide whether to wire from (enabled setting ×
        // tmux availability). `'off'` → skip; unavailable under `'on'` → user error;
        // unavailable under `'auto'` → silent skip; available (and not `'off'`) → wire.
        const capability = resolver.getTmuxCapability();
        const decision = decideTmuxWiring(settings.enabled, capability?.available === true);
        if (decision === 'require-error') {
            // The one path that reaches the user: they required tmux but it isn't there.
            // Best-effort notification; the failed connection is already succeeded.
            void vscode.window.showErrorMessage(TMUX_REQUIRED_UNAVAILABLE_MESSAGE);
            return;
        }
        if (decision !== 'wire' || !capability?.available) {
            // `'skip'` (disabled, or unavailable under `'auto'`). The `!capability?.available`
            // clause is redundant given `decision === 'wire'` implies availability — it is
            // there only to re-narrow `capability` to non-undefined for the compiler below.
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

        // exec resolves the resolver's *current* SSH connection at call time (see
        // lazyExec) — never captured — so a reconnect's fresh connection is picked up
        // automatically and post-reconnect terminals/reaper hit the live channel
        // instead of the dead pre-reconnect one (headline #3).
        const exec = lazyExec(resolver);
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
            // Launch tmux by the absolute path the probe resolved (`command -v tmux`),
            // so nix / `~/.local/bin` installs off the non-login PATH still work —
            // undefined falls back to a bare `tmux` on PATH.
            tmuxPath: capability.path,
            // Scrollback lines for new sessions (remote.SSH.tmux.historyLimit); the
            // provider caps its `new-session` history buffer to this.
            historyLimit: settings.historyLimit,
        });

        // Initialize the provider (restore + adopt sessions from previous clients).
        terminalProvider.initialize()
            .catch((err) => {
                logger.trace(`Failed to initialize tmux provider: ${err instanceof Error ? err.message : String(err)}`);
            });

        // Register the terminal profile provider with VS Code. The id ("tmux") must
        // match the contributed profile in package.json's contributes.terminal.profiles
        // — registering without a matching contribution is a silent no-op (no entry in
        // the profile picker, provider never invoked). See docs/idea/tmux-approach.md.
        const providerDisposable = vscode.window.registerTerminalProfileProvider('tmux', terminalProvider);
        context.subscriptions.push(providerDisposable);

        // Free a terminal's slot when it actually closes — the counterpart to
        // provideTerminalProfile()/reopen() allocating one. Without this a slot is
        // never released within a live window: every "New Terminal" after a close
        // mints a brand-new, ever-growing remote session instead of reattaching the
        // one just detached (found live in the 09 acceptance matrix's churn row).
        context.subscriptions.push(vscode.window.onDidOpenTerminal(t => terminalProvider.handleTerminalOpened(t)));
        context.subscriptions.push(vscode.window.onDidCloseTerminal(t => terminalProvider.handleTerminalClosed(t)));

        // Make it the default so a plain "New Terminal" already lands on tmux — the
        // whole point of "invisible UX" (tmux-approach.md:33: "the default terminal on
        // a resolved Unix host"). Contributed profiles have no manifest-level default
        // flag (VS Code's terminal extension point only has id/title/icon), so this is
        // the one settings write the terminal layer makes — scoped to this Workspace
        // (never User/Global, never the remote's own ~/.tmux.conf) and only when unset,
        // so a user who deliberately picked a different default is never overridden.
        setDefaultTerminalProfileIfUnset(logger);

        // Construct the session reaper (housekeeping for empty/detached sessions).
        // Uses current time as the clock for age-based reap decisions.
        const reaper = new SessionReaper({
            exec,
            now: () => Math.floor(Date.now() / 1000),
            log: logger,
        });

        // Run the reaper only when remote.SSH.tmux.reapOnConnect is set (default true) —
        // the setting's contract is "clean up empty/dead sessions when connecting". Gates
        // both the initial connect reap here and the reconnect refresh below. `label`
        // (not `context`) avoids shadowing the ExtensionContext parameter.
        const reapIfEnabled = (label: string): void => {
            if (!settings.reapOnConnect) {
                return;
            }
            reaper.reap()
                .catch((err) => logger.trace(`${label}: ${err instanceof Error ? err.message : String(err)}`));
        };

        // Run reaper immediately on connect (cleanup leftover sessions).
        reapIfEnabled('Session reaper failed');

        // Create a disposable for the reaper (so it can be cleaned up, though
        // it has no resources to free — reaper is stateless).
        context.subscriptions.push({
            dispose: () => {
                // No-op; reaper is stateless.
            },
        });

        logger.trace('Tmux terminal layer wired successfully');

        // The reconnect handle: on a later resolve-success the provider/reaper are
        // already registered and their lazy `exec` targets the fresh connection, so
        // nothing is re-registered. Re-reconcile provider state (re-attach survivors,
        // adopt orphans that appeared during the drop — reopen() is idempotent) and
        // re-run the reaper to clear any corpses left by the disconnect.
        return {
            refresh: () => {
                terminalProvider.initialize()
                    .catch((err) => logger.trace(`Tmux provider refresh failed: ${err instanceof Error ? err.message : String(err)}`));
                reapIfEnabled('Tmux reaper refresh failed');
            },
        };
    } catch (err) {
        // Wiring failure must never break the connection; log and continue. No layer
        // is returned, so idempotentResolveHandler retries wiring on the next resolve.
        logger.trace(`Tmux wiring failed: ${err instanceof Error ? err.message : String(err)}`);
        return undefined;
    }
}

/**
 * A wired tmux terminal layer's reconnect handle. `refresh()` is what a later
 * resolve-success (reconnect) invokes in place of re-wiring: it re-reconciles
 * provider state and re-runs the reaper, but never re-registers the profile
 * provider / event handlers / default-profile write (those survive the reconnect).
 */
interface TmuxTerminalLayer {
    refresh(): void;
}

/**
 * Build the resolve-success callback that wires the tmux layer exactly once, then
 * on every later resolve (reconnect) refreshes the existing layer instead of
 * re-registering it. `wire` is injected (rather than called inline) so this
 * idempotency is unit-testable without the VS Code terminal surface; it returns
 * `undefined` while a gate is unmet, in which case wiring is retried next resolve.
 */
export function idempotentResolveHandler(wire: () => TmuxTerminalLayer | undefined): () => void {
    let layer: TmuxTerminalLayer | undefined;
    return () => {
        if (layer) {
            layer.refresh(); // reconnect: refresh provider state + re-reap only, no re-register
            return;
        }
        layer = wire();
    };
}

/**
 * A {@link RemoteExec} bound to the resolver's *current* SSH connection, resolved
 * at call time rather than captured at wire time. On a reconnect the resolver swaps
 * in a fresh `SSHConnection`; a captured connection would pin every terminal and the
 * reaper to the dead pre-reconnect channel — the "post-reconnect terminals fail"
 * headline bug. Rejects when no connection is live so the provider/reaper degrade via
 * their existing never-throw probe paths (a failed exec reads as "saw nothing").
 */
export function lazyExec(resolver: RemoteSSHResolver): RemoteExec {
    return async (command: string) => {
        const connection = resolver.getSSHConnection();
        if (!connection) {
            throw new Error('SSH connection is not available');
        }
        return connection.exec(command);
    };
}

/**
 * The three `remote.SSH.tmux.*` settings the terminal layer honours, read together from
 * the `remote.SSH` configuration section. Values and defaults mirror package.json's
 * `contributes.configuration`, so an unset key behaves exactly as documented there.
 */
export interface TmuxSettings {
    /** `remote.SSH.tmux.enabled`: `'auto'` (default) | `'off'` | `'on'`. */
    readonly enabled: string;
    /** `remote.SSH.tmux.historyLimit`: scrollback lines for new sessions (default 50000). */
    readonly historyLimit: number;
    /** `remote.SSH.tmux.reapOnConnect`: reap empty/dead sessions on (re)connect (default true). */
    readonly reapOnConnect: boolean;
}

/**
 * Read the three `remote.SSH.tmux.*` settings. The single read seam for the terminal
 * layer's settings — keeps the section path, key names, and defaults in one place (and
 * unit-testable) instead of scattered inline. Defaults match package.json, so a missing
 * value resolves to the documented default.
 */
export function readTmuxSettings(): TmuxSettings {
    const config = vscode.workspace.getConfiguration('remote.SSH');
    return {
        enabled: config.get<string>('tmux.enabled', 'auto'),
        historyLimit: config.get<number>('tmux.historyLimit', 50000),
        reapOnConnect: config.get<boolean>('tmux.reapOnConnect', true),
    };
}

/** What {@link decideTmuxWiring} resolves the (enabled × availability) matrix to:
 * `'wire'` (register the tmux layer), `'skip'` (do nothing; base SSH unaffected), or
 * `'require-error'` (user required tmux via `'on'` but it is unavailable → notify). */
export type TmuxWiringDecision = 'wire' | 'skip' | 'require-error';

/**
 * The pure enablement rule for the tmux terminal layer, from `remote.SSH.tmux.enabled`
 * and whether the remote can provide tmux:
 *  - `'off'` → always `'skip'` (feature disabled);
 *  - available → `'wire'`;
 *  - unavailable + `'on'` → `'require-error'` (the "fail if unavailable" contract);
 *  - unavailable otherwise (`'auto'` / unknown) → `'skip'` (silent graceful degrade).
 * Pure + exported so the matrix is unit-tested without the VS Code terminal surface.
 */
export function decideTmuxWiring(enabled: string, tmuxAvailable: boolean): TmuxWiringDecision {
    if (enabled === 'off') {
        return 'skip';
    }
    if (tmuxAvailable) {
        return 'wire';
    }
    return enabled === 'on' ? 'require-error' : 'skip';
}

/** User-facing error shown when `remote.SSH.tmux.enabled` is `'on'` (tmux required) but the
 * remote can't provide tmux — the one enablement path that surfaces to the user instead of
 * silently degrading (`'auto'`). Generic wording: names only the setting and the tmux
 * requirement, no internals. */
export const TMUX_REQUIRED_UNAVAILABLE_MESSAGE =
    'remote.SSH.tmux.enabled is set to "on" (persistent terminals required), but tmux is not available on this remote. Install tmux, or set the setting to "auto" or "off".';

/** Title of the contributed profile (`package.json` contributes.terminal.profiles) —
 * the value `terminal.integrated.defaultProfile.linux` must reference to select it. */
const TMUX_PROFILE_TITLE = 'Persistent Shell';

/**
 * Set `terminal.integrated.defaultProfile.linux` to the tmux-backed profile, scoped to
 * this Workspace only, and only when nothing is set there yet — so "New Terminal"
 * lands on tmux by default (tmux-approach.md's "default terminal on a resolved Unix
 * host") without ever overriding a user's own deliberate choice, and without touching
 * User/Global settings (those aren't remote-scoped and would leak into unrelated
 * workspaces). Best-effort: a failure here must not break the (already-succeeded)
 * connection, so it only logs.
 */
function setDefaultTerminalProfileIfUnset(logger: Log): void {
    const terminalConfig = vscode.workspace.getConfiguration('terminal.integrated');
    const inspected = terminalConfig.inspect<string>('defaultProfile.linux');
    if (inspected?.workspaceValue !== undefined) {
        return; // user (or a prior connect) already chose one — never override
    }
    terminalConfig
        .update('defaultProfile.linux', TMUX_PROFILE_TITLE, vscode.ConfigurationTarget.Workspace)
        .then(
            undefined,
            (err: unknown) => logger.trace(`Could not set default tmux terminal profile: ${err instanceof Error ? err.message : String(err)}`)
        );
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
