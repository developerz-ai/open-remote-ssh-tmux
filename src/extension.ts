import * as vscode from 'vscode';
import Log from './common/logger';
import { RemoteSSHResolver, REMOTE_SSH_AUTHORITY } from './authResolver';
import SSHDestination from './ssh/sshDestination';
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
            // Not wiring → remove any stale tmux default we wrote on a prior (tmux-capable)
            // connect, so "New Terminal" falls back to the base shell instead of a profile
            // we never registered.
            reconcileDefaultTerminalProfile(logger, false);
            return;
        }
        if (decision !== 'wire' || !capability?.available) {
            // `'skip'` (disabled, or unavailable under `'auto'`). The `!capability?.available`
            // clause is redundant given `decision === 'wire'` implies availability — it is
            // there only to re-narrow `capability` to non-undefined for the compiler below.
            reconcileDefaultTerminalProfile(logger, false); // clean up a stale tmux default, as above
            return;
        }

        // Session identity (host + workspace) — shared with the kill command via
        // currentTmuxSessionContext() so both name this workspace's sessions identically.
        const sessionContext = currentTmuxSessionContext();
        if (!sessionContext) {
            // No resolved remote SSH workspace folder to key sessions to (an empty remote
            // window, or a non-ssh-remote folder) — there is no stable host+workspace
            // identity, so wire nothing rather than fabricate one. Still reconcile the
            // default toward cleanup, since we are not wiring the layer here.
            reconcileDefaultTerminalProfile(logger, false);
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

        // Make tmux the default so a plain "New Terminal" already lands on it — the whole
        // point of "invisible UX" (tmux-approach.md:33: "the default terminal on a resolved
        // Unix host"). Contributed profiles carry no manifest-level default flag (the
        // terminal extension point is only id/title/icon), so this is the one settings write
        // the terminal layer makes — Workspace scope only, and only when the user hasn't set
        // a default at ANY scope (a Workspace write silently overrides a User/Remote one).
        // The mirror case (not wiring → remove a stale write of ours) is reconciled on the
        // skip returns above, so the default never points at an unregistered profile.
        reconcileDefaultTerminalProfile(logger, true);

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
 * the value `terminal.integrated.defaultProfile.linux` must reference to select it.
 * Exported so tests pin the exact string the reconcile writes/cleans up. */
export const TMUX_PROFILE_TITLE = 'Persistent Shell';

/**
 * The `inspect()` scopes a user's own `terminal.integrated.defaultProfile.linux` choice
 * can live in. Any of these being set means the user (or their User/Remote settings) owns
 * the default, so the terminal layer must not clobber it with a Workspace-scope write. In a
 * remote window `globalValue` already reflects the remote user settings for this
 * machine-overridable setting, so it also covers a remote-scope default. A structural subset
 * of VS Code's `inspect()` result — the full object is assignable to it.
 */
export interface DefaultProfileScopes {
    readonly globalValue?: string;
    readonly workspaceValue?: string;
    readonly workspaceFolderValue?: string;
}

/** What {@link decideDefaultProfile} resolves to — the action to take on the *Workspace*-scope
 * `defaultProfile.linux` value: `'set'` our tmux profile, `'clear'` a stale write of ours, or
 * `'none'` (leave settings untouched). */
export type DefaultProfileAction = 'set' | 'clear' | 'none';

/**
 * Pure decision for the workspace default-profile write, from what `inspect()` reports and
 * whether the tmux layer is being wired this connect:
 *  - wiring, and no default set at ANY scope → `'set'` (make tmux the default);
 *  - wiring, but a default already exists at any scope → `'none'` (never override the user's —
 *    or our own prior — choice; a Workspace write silently beats a User/Remote default);
 *  - not wiring, and the Workspace value is our own prior write → `'clear'` (remove it, else the
 *    default points at a profile we never registered and "New Terminal" errors);
 *  - not wiring otherwise → `'none'` (nothing of ours to clean; never touch a user's value).
 * Pure + exported so the matrix is unit-tested without the VS Code terminal surface.
 */
export function decideDefaultProfile(inspected: DefaultProfileScopes | undefined, wiring: boolean): DefaultProfileAction {
    const workspaceValue = inspected?.workspaceValue;
    if (wiring) {
        const anyScopeSet = inspected?.globalValue !== undefined
            || workspaceValue !== undefined
            || inspected?.workspaceFolderValue !== undefined;
        return anyScopeSet ? 'none' : 'set';
    }
    // Not wiring: only undo *our* stale Workspace write; never remove a user's own value.
    return workspaceValue === TMUX_PROFILE_TITLE ? 'clear' : 'none';
}

/**
 * Reconcile `terminal.integrated.defaultProfile.linux` (Workspace scope only) with whether the
 * tmux layer is wired this connect — see {@link decideDefaultProfile} for the rule. When
 * wiring, make the tmux profile the default ("default terminal on a resolved Unix host") but
 * only if the user hasn't chosen a default at *any* scope (User/Global, Remote, Workspace, or
 * folder), since a Workspace write silently overrides those. When *not* wiring, remove a stale
 * prior write of ours so the default never points at an unregistered profile. Never touches
 * User/Global or the remote's own ~/.tmux.conf. Best-effort: a failure here must not break the
 * (already-succeeded) connection, so it only logs.
 */
export function reconcileDefaultTerminalProfile(logger: Log, wiring: boolean): void {
    const terminalConfig = vscode.workspace.getConfiguration('terminal.integrated');
    const inspected = terminalConfig.inspect<string>('defaultProfile.linux');
    const action = decideDefaultProfile(inspected, wiring);
    if (action === 'none') {
        return;
    }
    const value = action === 'set' ? TMUX_PROFILE_TITLE : undefined;
    terminalConfig
        .update('defaultProfile.linux', value, vscode.ConfigurationTarget.Workspace)
        .then(
            undefined,
            (err: unknown) => logger.trace(`Could not ${action} default tmux terminal profile: ${err instanceof Error ? err.message : String(err)}`)
        );
}

/** The minimal slice of a `vscode.Uri` {@link deriveTmuxSessionContext} reads — the
 * workspace folder's scheme, resolved authority, and remote path. `vscode.Uri` is
 * structurally assignable, so the wrapper passes one straight through. */
export interface RemoteFolderUri {
    readonly scheme: string;
    readonly authority: string;
    readonly path: string;
}

/**
 * The (host, workspace) identity tmux session names are keyed to, parsed from a
 * resolved remote workspace-folder URI. Pure + exported so the parse is unit-tested
 * without the VS Code workspace surface.
 *
 * The host is decoded from the `ssh-remote+<encoded-dest>` authority the resolver put
 * on the folder URI (`SSHDestination.parseEncoded`, exactly as
 * `getRemoteWorkspaceLocationData` does) — NOT from `vscode.env.remoteName`, which is
 * the remote *type* (always `'ssh-remote'`) and identical for every SSH host: keying
 * the session hash on it collapses `tmuxSession.ts`'s host+workspace identity to
 * workspace-only. `workspaceKey` is the real remote folder path, which the caller also
 * uses as the `tmux new-session -c` cwd — so there is no fabricated `/home/user`
 * fallback: a non-remote / non-`ssh-remote` folder, or an empty window with no folder,
 * yields `undefined` (wire nothing) rather than a made-up path.
 */
export function deriveTmuxSessionContext(folder: RemoteFolderUri | undefined): { hostKey: string; workspaceKey: string } | undefined {
    if (!folder || folder.scheme !== 'vscode-remote') {
        return undefined;
    }
    const prefix = `${REMOTE_SSH_AUTHORITY}+`;
    if (!folder.authority.startsWith(prefix)) {
        return undefined; // a different remote type (WSL, dev container, …) — not ours
    }
    const hostKey = SSHDestination.parseEncoded(folder.authority.slice(prefix.length)).hostname;
    if (!hostKey) {
        return undefined; // undecodable/empty host — can't form a stable identity
    }
    return { hostKey, workspaceKey: folder.path };
}

/**
 * Live (host, workspace) identity for the current window — the vscode-reading wrapper
 * over {@link deriveTmuxSessionContext}, using the first workspace folder's URI.
 * `undefined` when there is no resolved remote SSH workspace folder (a local window, an
 * empty remote window, or a non-`ssh-remote` folder). Shared by the terminal-layer
 * wiring and the kill command so both name this workspace's sessions identically.
 */
function currentTmuxSessionContext(): { hostKey: string; workspaceKey: string } | undefined {
    return deriveTmuxSessionContext(vscode.workspace.workspaceFolders?.[0]?.uri);
}

/**
 * Build the kill command's target from live resolver state: the current SSH
 * connection's `exec` wrapped in a fresh {@link SessionReaper}, plus the
 * (host, workspace) identity. Returns `undefined` when there is no connection or no
 * resolved remote SSH workspace folder, so the command no-ops safely instead of
 * throwing. Wiring only — the reaper owns all tmux/session logic.
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
