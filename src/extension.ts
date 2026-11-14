import * as os from 'os';
import * as vscode from 'vscode';
import Log from './common/logger';
import { expandTokens, RemoteSSHResolver, REMOTE_SSH_AUTHORITY } from './authResolver';
import SSHDestination from './ssh/sshDestination';
import SSHConfiguration from './ssh/sshConfig';
import { addNewHost, closeWorkspaceSessions, KILL_WORKSPACE_SESSIONS_COMMAND_ID, killWorkspaceSessions, openSSHConfigFile, promptOpenRemoteSSHWindow, type WorkspaceKillTarget, type WorkspaceSessionIdentity, type WorkspaceSessionKiller } from './commands';
import { HostTreeDataProvider } from './hostTreeView';
import { getRemoteWorkspaceLocationData, RemoteLocationHistory } from './remoteLocationHistory';
import { RecentHosts } from './recentHosts';
import { connectedDestination } from './hostPresentation';
import { loadConnectPickSources, pickConnectDestination } from './connectQuickPick';
import { reuseCurrentWindow } from './windowTarget';
import { TmuxTerminalProvider, type OpenTerminal, type TmuxSessionContext } from './tmux/terminalProvider';
import { createCloseWatch, createRemoteExec, type RawExec, type RemoteExec } from './tmux/remoteExec';
import { probeLifetimeRisk, type LifetimeFacts, type TmuxCapability } from './tmux/tmuxBootstrap';
import { withDeadline } from './common/deadline';
import { FallbackTerminalProvider } from './tmux/fallbackTerminalProvider';
import { TerminalProfileRegistration } from './tmux/profileRegistration';
import { pasteClipboardImage, sweepOldImages } from './clipboard/pasteImage';
import { SessionReaper } from './tmux/sessionReaper';
import { buildCloseWatchCommand, canonicalHostKey, canonicalWorkspaceKey, clampHistoryLimit, DEFAULT_ORPHAN_MAX_AGE_DAYS, type SshTarget } from './tmux/tmuxSession';
import { resolveClientId } from './tmux/clientIdentity';
import { toHandOffPolicy, type HandOffPolicy } from './tmux/slotState';
import { decideSettingsChange } from './tmux/settingsWatcher';
import { prepareEnvCollection } from './common/envCollection';
import { disposeAll } from './common/disposable';

export async function activate(context: vscode.ExtensionContext) {
    const logger = new Log('Remote - SSH');
    context.subscriptions.push(logger);

    const remoteSSHResolver = new RemoteSSHResolver(context, logger);
    context.subscriptions.push(vscode.workspace.registerRemoteAuthorityResolver(REMOTE_SSH_AUTHORITY, remoteSSHResolver));
    context.subscriptions.push(remoteSSHResolver);

    // Settle the terminal environment contribution NOW, at activation, while the window has
    // no terminals for it to invalidate. Any later mutation marks open terminals stale, and
    // VS Code only relaunches them silently when it judges that safe — a tmux terminal with
    // a live process in it never is, so the user gets "…wants to relaunch the terminal to
    // contribute to its environment" instead, on terminals where relaunching is precisely
    // the wrong thing. The resolver's own write is diffed (`common/envCollection.ts`), so
    // after this the collection only changes when a variable's value genuinely does.
    prepareEnvCollection(context.environmentVariableCollection);

    // Single owner of the contributed "tmux" profile id. VS Code permits exactly one
    // provider per id and throws on a second register for the same id, so the fallback
    // and the real tmux provider must *swap* through this handle rather than both
    // calling registerTerminalProfileProvider (which is what silently killed the tmux
    // layer in v1.0.0 — see profileRegistration.ts). Seeded with the plain-shell
    // fallback so "Persistent Shell" is always in the picker, even when tmux is
    // unavailable or disabled; wireTmuxTerminalLayer swaps in the real provider.
    const profileRegistration = new TerminalProfileRegistration(TMUX_PROFILE_ID);
    profileRegistration.use(new FallbackTerminalProvider());

    // Wire the tmux terminal provider after remote resolution completes, gated on the
    // capability probe and `remote.SSH.tmux.enabled`. The resolve callback fires after
    // *every* resolve() — including reconnects — so the controller wires the layer once and
    // only refreshes it thereafter: re-swapping the terminal profile provider per reconnect
    // would needlessly churn the registration and orphan the live one. Settings and folder
    // changes rewire or unwire it at runtime (`watchTmuxLayerInputs`).
    // One close watch per SSH connection for the life of this window, however often the layer
    // is rebuilt on that connection (see `createCloseWatch`).
    const watchClose = createCloseWatch({
        current: () => remoteSSHResolver.getSSHConnection(),
        run: (connection, command) => connection.exec(command),
        log: logger,
    });
    const layers = new TmuxLayerController(
        () => wireTmuxTerminalLayer(context, remoteSSHResolver, profileRegistration, logger, watchClose)
    );
    // Released before the registration it swaps the fallback back into.
    context.subscriptions.push({ dispose: () => layers.unwire() });
    context.subscriptions.push(profileRegistration);
    context.subscriptions.push(watchTmuxLayerInputs({
        onDidChangeConfiguration: listener => vscode.workspace.onDidChangeConfiguration(listener),
        onDidChangeWorkspaceFolders: listener => vscode.workspace.onDidChangeWorkspaceFolders(listener),
    }, {
        controller: layers,
        readSettings: readTmuxSettings,
        connected: () => remoteSSHResolver.getSSHConnection() !== undefined,
        currentIdentity: () => currentTmuxIdentity(logger),
        clearDefaultProfile: () => void reconcileDefaultTerminalProfile(logger, false, remoteSSHResolver.getRemotePlatform()),
        offerCleanup: identity => offerBackgroundCleanup(identity, {
            reaper: newReaper(remoteSSHResolver, logger),
            ask: (message, ...items) => vscode.window.showInformationMessage(message, ...items),
        }),
        log: logger,
    }));
    // The image sweep is deliberately NOT inside `wireTmuxTerminalLayer`. It used to be, and
    // that tied housekeeping for pasted screenshots to a gate it has nothing to do with:
    // pasting only needs a remote authority, but the sweep only ran when the tmux layer wired.
    // Turn `remote.SSH.tmux.enabled` off, connect to a remote without tmux, or open an empty
    // remote window (no folder → no session context) and images uploaded fine while nothing
    // ever deleted them — the 48h retention promise quietly became "forever".
    const sweepImages = onceOnly(() => {
        void sweepOldImages({ exec: clipboardExec(remoteSSHResolver, CLIPBOARD_SWEEP_DEADLINE_MS), log: logger });
    });
    // `onResolveSuccessfullyCompleted` holds a single callback, so the two are composed here
    // rather than registered separately.
    remoteSSHResolver.onResolveSuccessfullyCompleted(() => {
        sweepImages();
        layers.resolved()
            .then(layer => runHousekeeping(remoteSSHResolver, logger, layer))
            .catch(err => logger.trace(`Persistent terminal housekeeping failed: ${errorMessage(err)}`));
    });

    const locationHistory = new RemoteLocationHistory(context);
    const locationData = getRemoteWorkspaceLocationData();
    if (locationData) {
        // Never `await` this bare. It is a `globalState` write, and every command
        // registration and the tree view below come AFTER it — so one rejected write
        // (storage failure, corrupt state) rejected `activate()` and left the user with a
        // window that connects but whose every command reports "not found". That is the
        // exact failure `remoteLocationHistory.ts` was hardened against internally,
        // reintroduced here at the call site. Remembering a folder is the least important
        // thing this function does; it must not be able to take the rest of it down.
        await locationHistory.addLocation(locationData[0], locationData[1])
            .then(undefined, (err: unknown) => logger.trace(`Could not remember this remote folder: ${errorMessage(err)}`));
    }

    // Remember the host this window connects to, folder or not, so "Connect to Host..." lists
    // it first. Same rule as above: a failed write must not take activation down.
    const recentHosts = new RecentHosts(context.globalState);
    const connectedHost = connectedDestination(vscode.env.remoteAuthority);
    if (connectedHost) {
        await recentHosts.add(connectedHost.toString())
            .then(undefined, (err: unknown) => logger.trace(`Could not remember this host: ${errorMessage(err)}`));
    }

    const hostTreeDataProvider = new HostTreeDataProvider(locationHistory);
    context.subscriptions.push(vscode.window.createTreeView('sshHosts', { treeDataProvider: hostTreeDataProvider }));
    context.subscriptions.push(hostTreeDataProvider);

    // "Connect to Host..." lands per `remote.SSH.openInWindow` (reuses an empty local window by
    // default); "Connect Current Window to Host..." always reuses this one.
    const askDestination = (): Promise<string | undefined> => pickConnectDestination(
        () => loadConnectPickSources(recentHosts, locationHistory),
        { add: addNewHost, configure: openSSHConfigFile },
    );
    context.subscriptions.push(vscode.commands.registerCommand('openremotessh.openEmptyWindow', () => promptOpenRemoteSSHWindow(reuseCurrentWindow(), askDestination)));
    context.subscriptions.push(vscode.commands.registerCommand('openremotessh.openEmptyWindowInCurrentWindow', () => promptOpenRemoteSSHWindow(true, askDestination)));
    context.subscriptions.push(vscode.commands.registerCommand('openremotessh.openConfigFile', () => openSSHConfigFile()));
    context.subscriptions.push(vscode.commands.registerCommand('openremotessh.showLog', () => logger.show()));
    context.subscriptions.push(vscode.commands.registerCommand(KILL_WORKSPACE_SESSIONS_COMMAND_ID, () => killWorkspaceSessions(() => resolveKillTarget(remoteSSHResolver, logger, layers))));

    // Paste a LOCAL screenshot into the focused REMOTE terminal: the clipboard lives on this
    // machine, the tool that needs the image (e.g. Claude Code) runs on the server, and
    // nothing bridges them. Falls back to an ordinary paste whenever there is no image on
    // the clipboard, so the keybinding never swallows a normal text paste.
    context.subscriptions.push(vscode.commands.registerCommand('openremotessh.pasteImage', async () => {
        // Prefer the open folder's authority; fall back to the one the resolver was asked for.
        // The folder URI is absent in an empty window (and `vscode.env.remoteName` only ever
        // says `ssh-remote`, not which host), and without an authority there is no remote
        // filesystem to write the image to.
        const authority = vscode.workspace.workspaceFolders?.[0]?.uri.authority
            ?? remoteSSHResolver.getAuthority();
        let handled = false;
        if (remoteSSHResolver.getRemotePlatform() === 'windows') {
            // Same graceful-degradation contract the tmux layer honours (CLAUDE.md: Windows
            // remotes degrade, they never break). Everything downstream of the upload is
            // POSIX — `printf %s "$HOME"`, `mkdir -p -m 700`, `find -mmin -delete` — so on a
            // Windows remote the paste got as far as producing a generic error toast and,
            // because a failed upload counts as "handled", swallowed the text paste with it.
            // Falling through here gives the user their ordinary paste back.
            logger.info('clipboard image: the remote is Windows — pasting as text');
        } else if (authority) {
            handled = await pasteClipboardImage({
                exec: clipboardExec(remoteSSHResolver, CLIPBOARD_PASTE_DEADLINE_MS),
                log: logger,
                platform: process.platform,
                authority,
            });
        } else {
            // Previously this fell through to a text paste in silence, which is how the
            // feature came to be reported as "nothing happens and there are no logs" — the
            // one outcome with no trace at all was also the easiest one to hit.
            logger.info('clipboard image: no remote authority for this window — pasting as text');
        }
        if (!handled) {
            await vscode.commands.executeCommand('workbench.action.terminal.paste');
        }
    }));
}

/**
 * Wire the tmux terminal provider after remote resolution succeeds. Gated on the capability
 * probe (tmux available) + `remote.SSH.tmux.enabled`. Constructs and registers
 * TmuxTerminalProvider with injected Log, exec and state; the listeners it subscribes belong
 * to the returned layer, which releases them on `dispose` (settings → off, folder change).
 *
 * Called by {@link TmuxLayerController}. Resolves the {@link TmuxTerminalLayer} handle whose
 * `refresh()` a later resolve (reconnect) calls instead of wiring again, or `undefined` when a
 * gate is unmet (capability unavailable / setting off / no folder) or wiring throws — so the
 * controller retries wiring on the next resolve.
 */
async function wireTmuxTerminalLayer(
    context: vscode.ExtensionContext,
    resolver: RemoteSSHResolver,
    profileRegistration: TerminalProfileRegistration,
    logger: Log,
    watchClose: (command: string) => void,
): Promise<TmuxTerminalLayer | undefined> {
    // Disposables this attempt has registered but not yet handed to the layer. Declared
    // out here so the catch can roll them back — see where it is filled below for why a
    // retried attempt must not inherit the previous one's.
    const wired: vscode.Disposable[] = [];
    let terminalProvider: TmuxTerminalProvider | undefined;
    try {
        // Read the remote.SSH.tmux.* settings up front. `enabled` is read BEFORE the
        // capability probe so an explicit `'on'` ("require tmux") can surface a
        // user-visible error when the remote can't provide tmux, instead of silently
        // skipping like `'auto'` does — see decideTmuxWiring. A change while this attempt
        // is in flight is the settings watcher's to apply (the controller counts an
        // in-flight wiring as wired).
        const settings = readTmuxSettings();

        // Decide whether to wire from (enabled setting × tmux availability). `'off'` → skip;
        // unavailable under `'on'` → user error; unavailable under `'auto'` → silent skip;
        // available (and not `'off'`) → wire.
        const capability = resolver.getTmuxCapability();
        const decision = decideTmuxWiring(settings.enabled, capability);
        if (decision === 'retry') {
            // Transient: the probe could not reach the remote in time. Not wiring returns
            // undefined, so the controller re-wires on the next resolve (which probes
            // again). The default-profile setting is deliberately left alone — the
            // fallback provider answers it with a plain shell meanwhile, and clearing then
            // re-writing the user's settings file over a blip would be pure churn.
            logger.info('Persistent terminals: the remote did not answer the capability check — plain shells for now, retrying on reconnect');
            return undefined;
        }
        if (decision === 'require-error') {
            // The one path that reaches the user: they required tmux but it isn't there.
            // Best-effort notification; the failed connection is already succeeded.
            void vscode.window.showErrorMessage(TMUX_REQUIRED_UNAVAILABLE_MESSAGE);
            // Not wiring → remove any stale tmux default we wrote on a prior (tmux-capable)
            // connect, so "New Terminal" falls back to the base shell instead of a profile
            // we never registered.
            void reconcileDefaultTerminalProfile(logger, false, resolver.getRemotePlatform());
            return undefined;
        }
        if (decision !== 'wire' || !capability?.available) {
            // `'skip'` (disabled, or unavailable under `'auto'`). The `!capability?.available`
            // clause is redundant given `decision === 'wire'` implies availability — it is
            // there only to re-narrow `capability` to non-undefined for the compiler below.
            void reconcileDefaultTerminalProfile(logger, false, resolver.getRemotePlatform()); // clean up a stale tmux default, as above
            return undefined;
        }

        // Session identity (canonical host + workspace, plus the legacy one to adopt from) —
        // shared with the kill command so both name this workspace's sessions identically.
        const identity = await currentTmuxIdentity(logger);
        if (!identity) {
            // No resolved remote SSH workspace folder to key sessions to (an empty remote
            // window, or a non-ssh-remote folder) — there is no stable host+workspace
            // identity, so wire nothing rather than fabricate one. Still reconcile the
            // default toward cleanup, since we are not wiring the layer here.
            void reconcileDefaultTerminalProfile(logger, false, resolver.getRemotePlatform());
            return undefined;
        }

        // exec resolves the resolver's *current* SSH connection at call time (see
        // lazyExec) — never captured — so a reconnect's fresh connection is picked up
        // automatically and post-reconnect terminals hit the live channel instead of the
        // dead pre-reconnect one (headline #3). Deadline-bounded, so a half-dead link can
        // never leave "New Terminal" waiting forever.
        const exec = tmuxExec(resolver);
        const openTerminal: OpenTerminal = (options) => vscode.window.createTerminal(options);
        // Who this window is on the remote: a hash of the machine id plus a per-window
        // nonce (never the raw machineId), tagged onto every session it attaches.
        const clientId = resolveClientId(vscode.env.machineId, context.workspaceState);

        const provider = new TmuxTerminalProvider({
            ctx: identity,
            exec,
            state: context.workspaceState,
            openTerminal,
            // Terminals VS Code has already revived from its own persistence (which is what
            // restores split layout — see buildOptions). Reconcile reads this so it does not
            // re-attach a session that is already on screen.
            listTerminals: () => vscode.window.terminals,
            log: logger,
            // Launch tmux by the absolute path the probe resolved (`command -v tmux`),
            // so nix / `~/.local/bin` installs off the non-login PATH still work —
            // undefined falls back to a bare `tmux` on PATH.
            tmuxPath: capability.path,
            // Picks the attach chain variant for this tmux (see tmuxFeatures).
            tmuxVersion: capability.version,
            // Scrollback lines for new sessions (remote.SSH.tmux.historyLimit); the
            // provider caps its `new-session` history buffer to this.
            historyLimit: settings.historyLimit,
            clientId,
            handOff: settings.handOff,
            offerTakeOver: offerHandOff,
        });
        terminalProvider = provider;

        // These go into `wired`, and are handed to the layer only once every fallible step
        // below has succeeded. This function is *retried*: the controller re-wires on the
        // next resolve whenever this one resolves undefined, and the catch turns any throw
        // past this point into exactly that. Listeners left behind by a failed attempt
        // would stack a SECOND pair pointing at a SECOND provider — two providers
        // allocating slots against the same workspaceState and both reacting to every
        // open/close, i.e. duplicated tabs and a kill-session for a slot the surviving
        // provider still holds. The rollback in the catch releases them instead.
        //
        // Subscribe BEFORE initialize(). VS Code revives its persisted terminals around the
        // same moment reconcile runs (both wait on the server connection), and a revived
        // terminal that lands while reconcile is still awaiting a probe would otherwise go
        // unseen — leaving two tabs attached to one session. Subscribed first, it is caught
        // either by the reconcile-time sweep or by the duplicate guard in the handler.
        wired.push(vscode.window.onDidOpenTerminal(t => provider.handleTerminalOpened(t)));
        // Free a terminal's slot when it actually closes — the counterpart to
        // provideTerminalProfile()/reopen() allocating one. Without this a slot is
        // never released within a live window: every "New Terminal" after a close
        // mints a brand-new, ever-growing remote session instead of reattaching the
        // one just detached (found live in the 09 acceptance matrix's churn row).
        wired.push(vscode.window.onDidCloseTerminal(t => provider.handleTerminalClosed(t)));

        // Initialize the provider (adopt legacy-named sessions, restore + adopt sessions
        // from previous clients).
        provider.initialize()
            .catch((err) => {
                logger.trace(`Failed to initialize tmux provider: ${errorMessage(err)}`);
            });

        // Take over the contributed "tmux" profile id from the plain-shell fallback
        // activate() seeded it with. This is a *swap*, not a second registration: VS Code
        // permits one provider per id and throws "already registered" otherwise — which is
        // precisely how v1.0.0 shipped, silently degrading every "Persistent Shell" to a
        // plain bash terminal (see profileRegistration.ts). The id must match the
        // contributed profile in package.json's contributes.terminal.profiles — owning an
        // id with no matching contribution is a silent no-op (no entry in the profile
        // picker, provider never invoked). See docs/idea/tmux-approach.md.
        profileRegistration.use(provider);

        // Make tmux the default so a plain "New Terminal" already lands on it — the whole
        // point of "invisible UX" (tmux-approach.md:33: "the default terminal on a resolved
        // Unix host"). Contributed profiles carry no manifest-level default flag (the
        // terminal extension point is only id/title/icon), so this is the one settings write
        // the terminal layer makes — Workspace scope only, and only when the user hasn't set
        // a default at ANY scope (a Workspace write silently overrides a User/Remote one).
        // The mirror case (not wiring → remove a stale write of ours) is reconciled on the
        // skip returns above, so the default never points at an unregistered profile.
        //
        // Awaited (bounded, never rejects) before the layer counts as wired: the write lands in
        // the remote's settings file seconds after it is issued, and a terminal opened in that
        // gap on a first connect was a plain shell — "wired" was logged ~2 s too early (EDH
        // row 01b). The provider is already registered above, so the moment VS Code sees the
        // default, it is ours that answers.
        await reconcileDefaultTerminalProfile(logger, true, resolver.getRemotePlatform());

        // Every fallible step is behind us, so this attempt is the one that keeps the
        // listeners: they now belong to the layer, released by its `dispose`.
        const listeners = wired.splice(0);
        // A closing window cannot detach its tmux clients itself (VS Code kills this
        // extension host within milliseconds); the close watch makes the remote notice the
        // connection drop instead, so another machine can take the sessions at once rather
        // than wait out VS Code's 3 h pty grace. One per connection: a reconnect starts its own.
        const closeWatchCommand = buildCloseWatchCommand(clientId, capability.path);
        watchClose(closeWatchCommand);

        // Advisory and off the connect path: does this host end the terminals at logout?
        if (!lifetimeChecked.has(identity.hostKey)) {
            lifetimeChecked.add(identity.hostKey);
            void maybeWarnTerminalLifetime(identity.hostKey, {
                probe: () => probeLifetimeRisk(exec),
                state: context.globalState,
                show: (message, ...items) => vscode.window.showWarningMessage(message, ...items),
                openDocs: url => void vscode.env.openExternal(vscode.Uri.parse(url)),
                log: logger,
            }).catch(err => logger.trace(`Terminal lifetime check failed: ${errorMessage(err)}`));
        }

        logger.trace('Tmux terminal layer wired successfully');

        return {
            identity,
            // A reconnect, not a reload: same window, same tabs, so VS Code revives nothing
            // and never calls the profile provider. Restore therefore has no reason to hold
            // its queue open waiting to be claimed — see `initialize`. The provider and its
            // lazy `exec` survive the reconnect, so nothing is re-registered.
            refresh: () => {
                watchClose(closeWatchCommand);
                provider.initialize({ awaitRevive: false })
                    .catch((err) => logger.trace(`Tmux provider refresh failed: ${errorMessage(err)}`));
            },
            reconfigure: next => {
                provider.configure({ historyLimit: next.historyLimit, handOff: next.handOff });
                provider.initialize({ awaitRevive: false })
                    .catch((err) => logger.trace(`Tmux provider reconfigure failed: ${errorMessage(err)}`));
                void reconcileDefaultTerminalProfile(logger, true, resolver.getRemotePlatform());
            },
            protectedSessions: async () => {
                await provider.initialized.catch(() => undefined);
                return provider.mappedSessionNames();
            },
            dispose: () => {
                provider.dispose();
                profileRegistration.use(new FallbackTerminalProvider());
                disposeAll(listeners);
            },
        };
    } catch (err) {
        // Wiring failure must never break the connection; log and continue. No layer
        // is returned, so the controller retries wiring on the next resolve — which is
        // exactly why anything this attempt registered has to go first. `wired` is empty
        // on the success path (handed to the layer above), so this only ever releases a
        // half-built layer. `disposeAll` rethrows the first failing dispose, and that must
        // not escape and mask `err`.
        terminalProvider?.dispose();
        try {
            disposeAll(wired);
        } catch (rollbackErr) {
            logger.trace(`Tmux wiring rollback failed: ${errorMessage(rollbackErr)}`);
        }
        logger.trace(`Tmux wiring failed: ${errorMessage(err)}`);
        return undefined;
    }
}

/** Hosts whose terminal lifetime this window has already checked — once per window. */
const lifetimeChecked = new Set<string>();

/**
 * Connect-time housekeeping (`remote.SSH.tmux.reapOnConnect`, re-read on every resolve):
 * kill this extension's dead and long-abandoned sessions on the remote. It runs whenever
 * the remote has tmux — also with persistent terminals switched off, because that is exactly
 * when sessions left from before would otherwise run unseen forever. The sessions this
 * window is about to restore (its mapping, once reconcile has planned) are protected.
 */
async function runHousekeeping(resolver: RemoteSSHResolver, logger: Log, layer: TmuxTerminalLayer | undefined): Promise<void> {
    const settings = readTmuxSettings();
    if (!settings.reapOnConnect || !resolver.getTmuxCapability()?.available) {
        return;
    }
    const protect = layer ? await layer.protectedSessions() : [];
    await newReaper(resolver, logger, settings.orphanMaxAgeDays).reap({ protect });
}

/** A {@link SessionReaper} over the live connection, for housekeeping and the kill paths. */
function newReaper(resolver: RemoteSSHResolver, logger: Log, orphanMaxAgeDays?: number): SessionReaper {
    return new SessionReaper({
        exec: tmuxExec(resolver),
        now: () => Math.floor(Date.now() / 1000),
        log: logger,
        tmuxPath: resolver.getTmuxCapability()?.path,
        orphanMaxAgeDays,
    });
}

/** Text of the take-over offer: one non-modal notification, no tmux wording. */
export const HAND_OFF_OFFER_MESSAGE = 'This workspace\'s terminals are open on another machine.';
export const HAND_OFF_TAKE_OVER = 'Take over';
export const HAND_OFF_NOT_NOW = 'Not now';

/** Ask whether to take this workspace's terminals over from another machine still using them
 * (`remote.SSH.tmux.handOff` `auto`/`ask`). Only an explicit click on "Take over" counts;
 * dismissing the notification is "not now". */
export async function offerHandOff(): Promise<boolean> {
    const choice = await vscode.window.showInformationMessage(HAND_OFF_OFFER_MESSAGE, HAND_OFF_TAKE_OVER, HAND_OFF_NOT_NOW);
    return choice === HAND_OFF_TAKE_OVER;
}

/**
 * A wired tmux terminal layer. `refresh()` is what a later resolve-success (reconnect)
 * invokes in place of re-wiring: it re-reconciles provider state but never re-registers the
 * profile provider / event handlers / default-profile write (those survive the reconnect).
 */
export interface TmuxTerminalLayer extends vscode.Disposable {
    /** The (canonical) session identity the layer serves. */
    readonly identity: TmuxSessionContext;
    refresh(): void;
    /** Take changed settings without rebuilding (see `decideSettingsChange`'s `refresh`). */
    reconfigure(settings: TmuxSettings): void;
    /** Sessions housekeeping must not age out — this window's mapping, once planned. */
    protectedSessions(): Promise<string[]>;
}

/**
 * Owns the one tmux terminal layer of this window across resolves, settings changes and
 * folder changes: wire it once, refresh it on every reconnect, rebuild or drop it when a
 * setting or the folder says so. `wire` is injected so the lifecycle is unit-testable
 * without the VS Code terminal surface; it resolves `undefined` while a gate is unmet, in
 * which case wiring is retried on the next resolve.
 *
 * Wiring is asynchronous (the identity reads the SSH config), so two guards matter: a
 * resolve arriving while wiring is in flight JOINS it rather than wiring a second layer, and
 * a wiring superseded by `unwire`/`rewire` meanwhile disposes what it built instead of
 * installing it — a layer nobody owns would keep allocating slots in the background.
 */
export class TmuxLayerController {
    private layer: TmuxTerminalLayer | undefined;
    private wiring: Promise<TmuxTerminalLayer | undefined> | undefined;
    /** Bumped by every unwire; a wiring started under an older value is stale. */
    private generation = 0;

    constructor(private readonly wire: () => Promise<TmuxTerminalLayer | undefined>) {
    }

    /** The live layer, if one is wired. */
    get current(): TmuxTerminalLayer | undefined {
        return this.layer;
    }

    /** A layer is wired, or being wired — either way a settings change must treat it as live. */
    get wired(): boolean {
        return this.layer !== undefined || this.wiring !== undefined;
    }

    /** A resolve succeeded: wire the first time, refresh after that (reconnect). */
    resolved(): Promise<TmuxTerminalLayer | undefined> {
        if (this.layer) {
            this.layer.refresh();
            return Promise.resolve(this.layer);
        }
        return this.wireNow();
    }

    /** Drop the current layer (if any) and wire a fresh one. */
    rewire(): Promise<TmuxTerminalLayer | undefined> {
        this.unwire();
        return this.wireNow();
    }

    /** Drop the current layer, cancel an in-flight wiring, and hand back the dropped
     * layer's identity (what the "still running" offer is about). */
    unwire(): TmuxSessionContext | undefined {
        this.generation++;
        this.wiring = undefined;
        const layer = this.layer;
        this.layer = undefined;
        layer?.dispose();
        return layer?.identity;
    }

    private wireNow(): Promise<TmuxTerminalLayer | undefined> {
        if (this.wiring) {
            return this.wiring;
        }
        const generation = this.generation;
        const settle = (layer: TmuxTerminalLayer | undefined): TmuxTerminalLayer | undefined => {
            if (generation !== this.generation) {
                layer?.dispose(); // superseded while wiring: nobody owns it
                return undefined;
            }
            this.wiring = undefined;
            this.layer = layer;
            return layer;
        };
        this.wiring = Promise.resolve()
            .then(() => this.wire())
            .then(settle, () => settle(undefined));
        return this.wiring;
    }
}

/** The VS Code events {@link watchTmuxLayerInputs} listens to (injected for tests). */
export interface TmuxLayerEvents {
    onDidChangeConfiguration(listener: (e: { affectsConfiguration(section: string): boolean }) => void): vscode.Disposable;
    onDidChangeWorkspaceFolders(listener: () => void): vscode.Disposable;
}

/** What the reactions to those events need — injected so they are unit-tested. */
export interface TmuxLayerReactions {
    readonly controller: TmuxLayerController;
    readSettings(): TmuxSettings;
    /** A resolved connection exists (before it, the first resolve wires anyway). */
    connected(): boolean;
    currentIdentity(): Promise<TmuxSessionContext | undefined>;
    /** Remove a default-profile write of ours (the layer is going away). */
    clearDefaultProfile(): void;
    offerCleanup(identity: TmuxSessionContext): Promise<void>;
    readonly log: { trace(message: string): void };
}

/**
 * React to `remote.SSH.tmux.*` and workspace-folder changes without a reload. Settings: the
 * pure {@link decideSettingsChange} picks the action. Folders: the identity is recomputed
 * (still the first folder, by design) and the layer rebuilt onto it when it moved, or dropped
 * when no folder is left — never left serving a stale identity. (VS Code restarts the
 * extension host when the FIRST folder changes, so in practice only additions/removals of
 * other folders reach this, and they leave the identity as it is.)
 */
export function watchTmuxLayerInputs(events: TmuxLayerEvents, reactions: TmuxLayerReactions): vscode.Disposable {
    let settings = reactions.readSettings();
    const subscriptions = [
        events.onDidChangeConfiguration(e => {
            if (!e.affectsConfiguration('remote.SSH.tmux')) {
                return;
            }
            const next = reactions.readSettings();
            const action = decideSettingsChange(settings, next, reactions.controller.wired);
            settings = next;
            reactions.log.trace(`Persistent terminal settings changed -> ${action}`);
            applySettingsAction(action, next, reactions);
        }),
        events.onDidChangeWorkspaceFolders(() => {
            recheckIdentity(reactions)
                .catch(err => reactions.log.trace(`Persistent terminals: folder change failed: ${errorMessage(err)}`));
        }),
    ];
    return { dispose: () => disposeAll(subscriptions) };
}

function applySettingsAction(action: ReturnType<typeof decideSettingsChange>, next: TmuxSettings, reactions: TmuxLayerReactions): void {
    switch (action) {
        case 'offer-cleanup': {
            const identity = reactions.controller.unwire();
            reactions.clearDefaultProfile();
            if (identity) {
                reactions.offerCleanup(identity)
                    .catch(err => reactions.log.trace(`Persistent terminals: cleanup offer failed: ${errorMessage(err)}`));
            }
            break;
        }
        case 'rewire':
            if (reactions.connected()) {
                void reactions.controller.rewire();
            }
            break;
        case 'refresh':
            reactions.controller.current?.reconfigure(next);
            break;
        case 'none':
            break;
    }
}

async function recheckIdentity(reactions: TmuxLayerReactions): Promise<void> {
    const layer = reactions.controller.current;
    if (!layer) {
        return; // nothing wired: the next resolve or settings change wires against the folders as they are
    }
    const next = await reactions.currentIdentity();
    if (reactions.controller.current !== layer) {
        return; // rewired or dropped meanwhile
    }
    if (!next) {
        reactions.controller.unwire();
        reactions.clearDefaultProfile();
        return;
    }
    if (next.hostKey !== layer.identity.hostKey || next.workspaceKey !== layer.identity.workspaceKey) {
        await reactions.controller.rewire();
    }
}

/** Buttons of the offer that follows turning persistent terminals off. */
export const CLOSE_BACKGROUND_TERMINALS = 'Close them';
export const KEEP_BACKGROUND_TERMINALS = 'Keep';

/** Text of that offer: plain language, no internals. */
export function backgroundTerminalsMessage(count: number): string {
    return count === 1
        ? '1 background terminal from this workspace is still running.'
        : `${count} background terminals from this workspace are still running.`;
}

/** The workspace's session identities: canonical, plus the legacy one sessions may still
 * carry until adopted (the kill paths must cover both). */
export function workspaceIdentities(identity: TmuxSessionContext): WorkspaceSessionIdentity[] {
    const identities = [{ hostKey: identity.hostKey, workspaceKey: identity.workspaceKey }];
    if (identity.legacy) {
        identities.push({ hostKey: identity.legacy.hostKey, workspaceKey: identity.legacy.workspaceKey });
    }
    return identities;
}

/**
 * After persistent terminals are switched off: if this workspace still has sessions running
 * on the remote, say so once and offer to close them — otherwise they would run on where
 * nothing in this window will show them again. "Close them" is the kill command's own path
 * (`closeWorkspaceSessions`); anything else keeps them (connect-time housekeeping ages them
 * out eventually).
 */
export async function offerBackgroundCleanup(
    identity: TmuxSessionContext,
    deps: {
        readonly reaper: WorkspaceSessionKiller & { countWorkspaceSessions(identities: readonly WorkspaceSessionIdentity[]): Promise<number | undefined> };
        ask(message: string, ...items: string[]): Thenable<string | undefined>;
    },
): Promise<void> {
    const identities = workspaceIdentities(identity);
    const count = await deps.reaper.countWorkspaceSessions(identities);
    if (!count) {
        return;
    }
    const choice = await deps.ask(backgroundTerminalsMessage(count), CLOSE_BACKGROUND_TERMINALS, KEEP_BACKGROUND_TERMINALS);
    if (choice === CLOSE_BACKGROUND_TERMINALS) {
        await closeWorkspaceSessions({ reaper: deps.reaper, identities });
    }
}

/** The one-time warning for a host that ends a user's processes at logout. No internals. */
export const LIFETIME_WARNING_MESSAGE =
    'Terminals on this host may not survive a disconnect: the host ends your processes when you log out.';
export const LIFETIME_LEARN_MORE = 'Learn more';
export const LIFETIME_DOCS_URL =
    'https://github.com/developerz-ai/open-remote-ssh-tmux/blob/main/docs/troubleshooting.md#terminals-closed-after-disconnect';
/** globalState key: canonical host keys whose lifetime warning the user has dismissed. */
const LIFETIME_DISMISSED_STATE_KEY = 'tmux.lifetimeWarningDismissed.v1';

/**
 * Warn, once per host, when the remote ends a user's processes at logout (systemd-logind
 * `KillUserProcesses=yes`): every terminal then dies on disconnect, which is otherwise silent
 * and looks like this extension failing. Detection only — no wrapper around the server start.
 * Any answer to the notification (a button or closing it) is remembered in globalState, so a
 * host is never warned about again; a host already dismissed is not even probed.
 */
export async function maybeWarnTerminalLifetime(
    hostKey: string,
    deps: {
        probe(): Promise<LifetimeFacts>;
        readonly state: { get<T>(key: string, defaultValue: T): T; update(key: string, value: unknown): Thenable<void> };
        show(message: string, ...items: string[]): Thenable<string | undefined>;
        openDocs(url: string): void;
        readonly log: { trace(message: string): void };
    },
): Promise<void> {
    if (deps.state.get<string[]>(LIFETIME_DISMISSED_STATE_KEY, []).includes(hostKey)) {
        return;
    }
    const facts = await deps.probe();
    deps.log.trace(`Terminal lifetime: KillUserProcesses=${facts.killUserProcesses ?? 'unknown'} `
        + `Linger=${facts.linger ?? 'unknown'} -> ${facts.lifetimeRisk ? 'at risk' : 'ok'}`);
    if (!facts.lifetimeRisk) {
        return;
    }
    const choice = await deps.show(LIFETIME_WARNING_MESSAGE, LIFETIME_LEARN_MORE);
    const dismissed = deps.state.get<string[]>(LIFETIME_DISMISSED_STATE_KEY, []);
    await deps.state.update(LIFETIME_DISMISSED_STATE_KEY, [...dismissed.filter(key => key !== hostKey), hostKey]);
    if (choice === LIFETIME_LEARN_MORE) {
        deps.openDocs(LIFETIME_DOCS_URL);
    }
}

/** Run `action` on the first call and never again. Used for the connect-time image sweep,
 * which is housekeeping for the whole window rather than per-connection work — running it
 * again on every reconnect would be pure noise. */
export function onceOnly(action: () => void): () => void {
    let ran = false;
    return () => {
        if (ran) {
            return;
        }
        ran = true;
        action();
    };
}

/** Best-effort message from an unknown thrown value, for log lines only. */
function errorMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

/**
 * A {@link RawExec} bound to the resolver's *current* SSH connection, resolved
 * at call time rather than captured at wire time. On a reconnect the resolver swaps
 * in a fresh `SSHConnection`; a captured connection would pin every terminal and the
 * reaper to the dead pre-reconnect channel — the "post-reconnect terminals fail"
 * headline bug. Rejects when no connection is live so the provider/reaper degrade via
 * their never-throw probe paths (a failed exec reads as "could not ask", never as "absent").
 * Raw (no deadline, no exit code): the tmux layer uses it through {@link tmuxExec}.
 */
export function lazyExec(resolver: RemoteSSHResolver): RawExec {
    return async (command: string) => {
        const connection = resolver.getSSHConnection();
        if (!connection) {
            throw new Error('SSH connection is not available');
        }
        return connection.exec(command);
    };
}

/** Deadline for each tmux list/has/kill round-trip. Generous next to the ~400 ms a
 * round-trip takes in the field, short enough that a dead link degrades a new terminal to a
 * plain shell in seconds. (The capability probe has its own, `PROBE_DEADLINE_MS`, enforced
 * inside `probeTmux` because the resolver awaits it.) */
export const TMUX_EXEC_DEADLINE_MS = 8000;

/**
 * The tmux layer's {@link RemoteExec}: {@link lazyExec} (current connection per call) with an
 * exit-code marker and {@link TMUX_EXEC_DEADLINE_MS} per call. Shared by the terminal
 * provider, the connect-time reaper and the kill command, so none of them can await a remote
 * command without a deadline.
 */
export function tmuxExec(resolver: RemoteSSHResolver): RemoteExec {
    return createRemoteExec(lazyExec(resolver), TMUX_EXEC_DEADLINE_MS);
}

/** Per-command deadline for the clipboard image paste's remote commands (home lookup,
 * private-directory create). Generous: the user is waiting on an image upload over a link
 * that may be slow, and a missed deadline turns into a visible "could not paste" error. */
export const CLIPBOARD_PASTE_DEADLINE_MS = 60000;

/** Per-command deadline for the connect-time image sweep — background housekeeping, so it
 * gives up sooner; a missed sweep is retried on the next window. */
export const CLIPBOARD_SWEEP_DEADLINE_MS = 15000;

/**
 * {@link lazyExec} with a deadline per call, for the clipboard bridge. Raw shape kept (no
 * exit-code wrapping): `src/clipboard/*` parses plain stdout/stderr and is independent of
 * the tmux layer. Only the remote commands are bounded here; the image bytes themselves go
 * through `workspace.fs`, which the clipboard module owns.
 */
export function clipboardExec(resolver: RemoteSSHResolver, deadlineMs: number): RawExec {
    const exec = lazyExec(resolver);
    return (command: string) => withDeadline(exec(command), deadlineMs, 'the remote command');
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
    /** `remote.SSH.tmux.reapOnConnect`: reap dead and abandoned sessions on (re)connect (default true). */
    readonly reapOnConnect: boolean;
    /** `remote.SSH.tmux.orphanMaxAgeDays`: days a detached session of ours may sit idle
     * before housekeeping closes it (default 14; 0 = never). */
    readonly orphanMaxAgeDays: number;
    /** `remote.SSH.tmux.handOff`: `'auto'` (default) | `'ask'` | `'never'` — what to do with
     * this workspace's sessions while another machine's client holds them (`slotState.ts`). */
    readonly handOff: HandOffPolicy;
    /** `remote.SSH.tmux.setDefaultProfile`: may the layer write
     * `terminal.integrated.defaultProfile.<platform>` at Workspace scope (default true)?
     * That write lands in `.vscode/settings.json` INSIDE the user's remote folder — a
     * tracked file in their repository, shared with everyone else who opens it, and left
     * behind pointing at an unregistered profile if this extension is uninstalled. It is
     * what makes a plain "New Terminal" persistent (the invisible-UX promise), so it stays
     * on by default; users who would rather keep their repo clean can turn it off and pick
     * "Persistent Shell" from the dropdown. */
    readonly setDefaultProfile: boolean;
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
        // Read as `unknown`: a hand-edited settings.json can hold anything, and a value tmux
        // rejects would stop every terminal from opening (see clampHistoryLimit).
        historyLimit: clampHistoryLimit(config.get<unknown>('tmux.historyLimit', 50000)),
        reapOnConnect: config.get<boolean>('tmux.reapOnConnect', true),
        // Read as `unknown`: a hand-edited value that is not a non-negative integer must not
        // silently switch aging off (or on at a nonsense age) — it falls back to the default.
        orphanMaxAgeDays: toOrphanMaxAgeDays(config.get<unknown>('tmux.orphanMaxAgeDays', DEFAULT_ORPHAN_MAX_AGE_DAYS)),
        // Read as `unknown`: an unrecognised hand-edited value falls back to the default.
        handOff: toHandOffPolicy(config.get<unknown>('tmux.handOff', 'auto')),
        setDefaultProfile: config.get<boolean>('tmux.setDefaultProfile', true),
    };
}

function toOrphanMaxAgeDays(value: unknown): number {
    return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : DEFAULT_ORPHAN_MAX_AGE_DAYS;
}

/** What {@link decideTmuxWiring} resolves the (enabled × availability) matrix to:
 * `'wire'` (register the tmux layer), `'skip'` (do nothing; base SSH unaffected),
 * `'require-error'` (user required tmux via `'on'` but it is unavailable → notify), or
 * `'retry'` (the probe could not be asked → plain shells this resolve, try again next). */
export type TmuxWiringDecision = 'wire' | 'skip' | 'require-error' | 'retry';

/**
 * The pure enablement rule for the tmux terminal layer, from `remote.SSH.tmux.enabled`
 * and whether the remote can provide tmux:
 *  - `'off'` → always `'skip'` (feature disabled);
 *  - available → `'wire'`;
 *  - unavailable + `'on'` → `'require-error'` (the "fail if unavailable" contract);
 *  - unavailable otherwise (`'auto'` / unknown) → `'skip'` (silent graceful degrade);
 *  - probe `unreachable` (channel error / missed deadline) → `'retry'` under any non-off
 *    setting. That says nothing about whether tmux is installed, so even `'on'` must not
 *    tell the user to install it — the next resolve probes again.
 * Pure + exported so the matrix is unit-tested without the VS Code terminal surface.
 */
export function decideTmuxWiring(
    enabled: string,
    capability: Pick<TmuxCapability, 'available' | 'reason'> | undefined,
): TmuxWiringDecision {
    if (enabled === 'off') {
        return 'skip';
    }
    if (capability?.available) {
        return 'wire';
    }
    if (capability?.reason === 'unreachable') {
        return 'retry';
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

/** Id of the contributed profile (`package.json` contributes.terminal.profiles[].id) — the
 * single terminal-profile id this extension owns, shared by the fallback and the real tmux
 * provider via {@link TerminalProfileRegistration}. Exported so the manifest-drift test pins
 * the contributed id and the code that registers against it to the same string. */
export const TMUX_PROFILE_ID = 'tmux';

/**
 * The `terminal.integrated.defaultProfile.<suffix>` key for a given REMOTE platform.
 *
 * VS Code resolves that suffix from the remote agent's operating system — `windows`, `osx`
 * or `linux` — not from the client's, and not from "is this a Unix host". This layer used to
 * hardcode `.linux`, which is wrong for macOS remotes: those ARE wired (the tmux probe gates
 * off only an explicit `'windows'` platform, and `macos` is a supported `remote.SSH.remotePlatform`
 * value), so the write landed on a key VS Code never consults. The provider registered, the
 * profile appeared in the dropdown, and "New Terminal" still opened a plain non-persistent
 * shell — the invisible-UX promise failing silently on exactly one platform. The `'clear'`
 * cleanup and the "has the user already chosen a default?" inspection were equally inert there.
 *
 * An unknown/absent platform maps to `linux`, matching how the rest of this codebase treats an
 * unlabelled remote as Unix (see `probeTmux`'s gate).
 */
export function defaultProfileSettingKey(remotePlatform?: string): string {
    switch (remotePlatform) {
        case 'windows':
            return 'defaultProfile.windows';
        case 'macos':
        case 'darwin':
            return 'defaultProfile.osx';
        default:
            return 'defaultProfile.linux';
    }
}

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
export function reconcileDefaultTerminalProfile(logger: Log, wiring: boolean, remotePlatform?: string): Promise<void> {
    const terminalConfig = vscode.workspace.getConfiguration('terminal.integrated');
    const key = defaultProfileSettingKey(remotePlatform);
    const inspected = terminalConfig.inspect<string>(key);
    const action = decideDefaultProfile(inspected, wiring);
    if (action === 'none') {
        return Promise.resolve();
    }
    // Opting out blocks only the WRITE. A `'clear'` must still run, otherwise turning the
    // setting off would strand a previous write of ours in the user's repo pointing at a
    // profile we may no longer register — the opposite of what opting out is asking for.
    if (action === 'set' && !readTmuxSettings().setDefaultProfile) {
        logger.trace('Skipping default terminal profile write (remote.SSH.tmux.setDefaultProfile is false)');
        return Promise.resolve();
    }
    const value = action === 'set' ? TMUX_PROFILE_TITLE : undefined;
    const write = Promise.resolve(terminalConfig.update(key, value, vscode.ConfigurationTarget.Workspace));
    return withDeadline(write, DEFAULT_PROFILE_WRITE_DEADLINE_MS, 'the default terminal profile write').then(
        undefined,
        (err: unknown) => logger.trace(`Could not ${action} default tmux terminal profile: ${errorMessage(err)}`)
    );
}

/** How long wiring waits for the default-profile write to land ({@link reconcileDefaultTerminalProfile}).
 * The write goes to the remote's settings file, so a hung remote must not hold the layer
 * unwired: past this the layer wires anyway and the write lands whenever it does. 15 s, not 5:
 * on a real-latency link the first write to a folder's settings took ~6 s (plan 101 field
 * replay), and a shorter cap wired before tmux was the default terminal. */
export const DEFAULT_PROFILE_WRITE_DEADLINE_MS = 15000;

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
 * The SSH target `dest` really reaches, resolved through the user's SSH config exactly as
 * the resolver connects (`authResolver.ts`: `HostName` with `%h` expanded, then `User` over
 * the typed user over the local account, then `Port` over the typed port over 22). Pure +
 * exported so the precedence is unit-tested; it must not drift from the resolver's.
 */
export function resolveSshTarget(dest: SSHDestination, hostConfig: Readonly<Record<string, unknown>>, localUser: string): SshTarget {
    const configured = (key: string): string | undefined => {
        const value = hostConfig[key];
        return typeof value === 'string' && value !== '' ? value : undefined;
    };
    const hostName = configured('HostName');
    const port = parseInt(configured('Port') ?? '', 10);
    return {
        hostName: hostName ? expandTokens(hostName, { h: dest.hostname }) : dest.hostname,
        user: configured('User') || dest.user || localUser,
        port: Number.isInteger(port) && port > 0 ? port : (dest.port || 22),
    };
}

/**
 * The provider's session context: the canonical identity (`canonicalHostKey` of the
 * resolved target, `canonicalWorkspaceKey` of the folder path), the folder path as typed for
 * the cwd, and the identity older versions used (`legacy`), whose sessions are adopted.
 */
export function canonicalTmuxIdentity(legacy: { hostKey: string; workspaceKey: string }, target: SshTarget): TmuxSessionContext {
    return {
        hostKey: canonicalHostKey(target),
        workspaceKey: canonicalWorkspaceKey(legacy.workspaceKey),
        cwd: legacy.workspaceKey,
        legacy: { hostKey: legacy.hostKey, workspaceKey: legacy.workspaceKey },
    };
}

/**
 * Live session identity for the current window, from the first workspace folder's URI and
 * the user's SSH config. `undefined` when there is no resolved remote SSH workspace folder (a
 * local window, an empty remote window, or a non-`ssh-remote` folder). Shared by the
 * terminal-layer wiring and the kill command so both name this workspace's sessions
 * identically. An unreadable SSH config degrades to the destination as typed (the resolver
 * could not have connected through it either).
 */
async function currentTmuxIdentity(logger: Log): Promise<TmuxSessionContext | undefined> {
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
    const legacy = deriveTmuxSessionContext(folder);
    if (!folder || !legacy) {
        return undefined;
    }
    const dest = SSHDestination.parseEncoded(folder.authority.slice(`${REMOTE_SSH_AUTHORITY}+`.length));
    let hostConfig: Readonly<Record<string, unknown>> = {};
    try {
        hostConfig = (await SSHConfiguration.loadFromFS()).getHostConfiguration(dest.hostname);
    } catch (err) {
        logger.trace(`Persistent terminals: could not read the SSH config for the session identity: ${errorMessage(err)}`);
    }
    return canonicalTmuxIdentity(legacy, resolveSshTarget(dest, hostConfig, localUserName()));
}

/** The local account name, the SSH user of last resort (as in the resolver). */
function localUserName(): string {
    try {
        return os.userInfo().username;
    } catch {
        return '';
    }
}

/**
 * Build the kill command's target from live state: a fresh {@link SessionReaper} over
 * {@link tmuxExec} plus this workspace's identities (the wired layer's, else computed).
 * Returns `undefined` when there is no connection or no resolved remote SSH workspace
 * folder, so the command no-ops safely instead of throwing. Wiring only — the reaper owns
 * all tmux/session logic.
 */
async function resolveKillTarget(resolver: RemoteSSHResolver, logger: Log, layers: TmuxLayerController): Promise<WorkspaceKillTarget | undefined> {
    if (!resolver.getSSHConnection()) {
        return undefined;
    }
    const identity = layers.current?.identity ?? await currentTmuxIdentity(logger);
    return identity ? { reaper: newReaper(resolver, logger), identities: workspaceIdentities(identity) } : undefined;
}

/** Nothing to do: a closing window's terminals are the close watch's business
 * (`createCloseWatch`, `tmux/remoteExec.ts`). A remote call from here would not land —
 * VS Code kills the extension host ~4 ms after asking it to terminate, and disposes
 * `context.subscriptions` (the SSH connection among them) without waiting for this. */
export function deactivate(): void {
    // intentionally empty
}
