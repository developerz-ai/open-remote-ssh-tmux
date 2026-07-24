import * as cp from 'child_process';
import * as fs from 'fs';
import * as net from 'net';
import * as stream from 'stream';
import { SocksClient, SocksClientOptions } from 'socks';
import * as vscode from 'vscode';
import * as ssh2 from 'ssh2';
import type { ParsedKey } from 'ssh2-streams';
import Log from './common/logger';
import SSHDestination from './ssh/sshDestination';
import SSHConnection, { SSHTunnelConfig } from './ssh/sshConnection';
import SSHConfiguration from './ssh/sshConfig';
import { gatherIdentityFiles } from './ssh/identityFiles';
import { verifyKnownHost, hostKeyIdentity } from './ssh/hostfile';
import { untildify, exists as fileExists } from './common/files';
import { findRandomPort } from './common/ports';
import { disposeAll } from './common/disposable';
import { installCodeServer, ServerInstallError, findServerInstallPath } from './serverSetup';
import { isWindows } from './common/platform';
import * as os from 'os';
import { isNullable } from '@zokugun/is-it-type';
import { ServerVersion } from './serverConfig';
import { probeTmux, type TmuxCapability } from './tmux/tmuxBootstrap';

const PASSWORD_RETRY_COUNT = 3;
const PASSPHRASE_RETRY_COUNT = 3;

export const REMOTE_SSH_AUTHORITY = 'ssh-remote';

export function getRemoteAuthority(host: string) {
    return `${REMOTE_SSH_AUTHORITY}+${host}`;
}

class TunnelInfo implements vscode.Disposable {
    constructor(
        readonly localPort: number,
        readonly remotePortOrSocketPath: number | string,
        private disposables: vscode.Disposable[]
    ) {
    }

    dispose() {
        disposeAll(this.disposables);
    }
}

interface SSHKey {
    filename: string;
    // Absent for an encrypted private key with no `.pub` sibling — identityFiles
    // keeps it (flagged `isPrivate`) rather than dropping it, since we can't
    // derive a parsedKey/fingerprint without the passphrase yet.
    parsedKey?: ParsedKey;
    fingerprint?: string;
    agentSupport?: boolean;
    isPrivate?: boolean;
}


/**
 * Split a ProxyCommand value into argv tokens.
 *
 * ssh-config v5.0.0 reassembles ProxyCommand's value into a single string (to
 * preserve quoting across the param boundary), but the spawn code expects
 * individual argv tokens. Calling `[].concat(someString)` does NOT split the
 * string — it wraps it, so `spawn()` ends up receiving the whole command
 * line as the executable path and fails with ENOENT. See
 * https://github.com/jeanp413/open-remote-ssh/issues/271 and
 * https://github.com/jeanp413/open-remote-ssh/issues/273.
 *
 * This helper mirrors OpenSSH's own ProxyCommand tokenization:
 * - whitespace separates tokens (outside quotes)
 * - double quotes group a single token
 * - backslash escapes the next character
 *
 * Array inputs are passed through for defensive compatibility with older
 * ssh-config versions.
 */
export function splitProxyCommand(value: string | string[]): string[] {
    if (Array.isArray(value)) {return value.slice();}
    const out: string[] = [];
    let cur = '';
    let i = 0;
    let quoted = false;
    let hasToken = false;
    while (i < value.length) {
        const ch = value[i];
        if (ch === '\\' && i + 1 < value.length) {
            cur += value[i + 1];
            i += 2;
            hasToken = true;
            continue;
        }
        if (ch === '"') {
            quoted = !quoted;
            hasToken = true;
            i += 1;
            continue;
        }
        if (!quoted && /\s/.test(ch)) {
            if (hasToken) { out.push(cur); cur = ''; hasToken = false; }
            i += 1;
            continue;
        }
        cur += ch;
        hasToken = true;
        i += 1;
    }
    if (hasToken) {out.push(cur);}
    return out;
}

/**
 * Expand OpenSSH-style `%x` config tokens (`HostName`, `ProxyCommand` args)
 * against a token→value map, honouring `%%` as a literal `%`.
 *
 * The code this replaces chained single-shot `String.replace(token, value)`
 * calls per token, which only ever substituted the *first* occurrence of a
 * repeated token (`%h %h` left the second `%h` untouched) and had no escape
 * for a literal `%` at all. This scans the template once, left to right, so
 * every occurrence is replaced and `%%` is never mistaken for a token.
 */
export function expandTokens(template: string, tokens: Record<string, string>): string {
    let out = '';
    for (let i = 0; i < template.length; i++) {
        const ch = template[i];
        if (ch === '%' && i + 1 < template.length) {
            const next = template[i + 1];
            if (next === '%') {
                out += '%';
                i += 1;
                continue;
            }
            if (Object.prototype.hasOwnProperty.call(tokens, next)) {
                out += tokens[next];
                i += 1;
                continue;
            }
        }
        out += ch;
    }
    return out;
}

/**
 * Resolve an SSH hop's port: an explicit ssh_config `Port` wins, else the
 * port embedded in the ProxyJump destination string, else `fallback` (22).
 *
 * Shared by the hop's own connection port and the *next* hop's forward-out
 * destination port so both agree — the hop's own port previously fell back
 * to the final destination's port (`sshPort`) instead of 22, which is wrong
 * whenever the final host listens on a non-standard port.
 */
export function resolveHopPort(configuredPort: string | undefined, jumpPort: number | undefined, fallback = 22): number {
    return configuredPort ? parseInt(configuredPort, 10) : (jumpPort || fallback);
}

/**
 * Decide what to hand ssh2's keyboard-interactive `finish()` callback once
 * prompt collection ends. ssh2 expects a responses array exactly as long as
 * the prompts it sent; if the user dismissed (`showInputBox` → `undefined`)
 * partway through, sending a *shorter* array desyncs the protocol instead of
 * just failing auth cleanly. Padding the remainder keeps the array the right
 * length regardless of where the user cancelled, and `retriesExhausted`
 * tells the caller to set (not decrement) the retry counter exactly once —
 * avoiding the prior double-adjustment (zeroed on cancel, then decremented
 * again unconditionally) that pushed it negative.
 */
export function buildKeyboardInteractiveFinish(promptCount: number, responses: string[], cancelled: boolean): { finishWith: string[]; retriesExhausted: boolean } {
    if (!cancelled) {
        return { finishWith: responses, retriesExhausted: false };
    }
    const padded = responses.slice(0, promptCount);
    while (padded.length < promptCount) {
        padded.push('');
    }
    return { finishWith: padded, retriesExhausted: true };
}

/**
 * Which SSHConnection instances `dispose()` must close. A ProxyJump chain
 * connects hop[0] for real (TCP); each later hop, and the destination
 * connection sitting on top of the chain, is layered on via a forwarded-out
 * stream (`sock:` in the ssh2 config) — ending hop[0] tends to cascade down
 * through those interrupted streams, but that's an implicit transport side
 * effect, not something this resolver should rely on to close connections it
 * created. Close every one of them explicitly instead of only hop[0].
 */
export function connectionsToClose(sshConnection: SSHConnection | undefined, proxyConnections: SSHConnection[]): SSHConnection[] {
    return [sshConnection, ...proxyConnections].filter((connection): connection is SSHConnection => connection !== undefined);
}

export class RemoteSSHResolver implements vscode.RemoteAuthorityResolver, vscode.Disposable {

    private proxyConnections: SSHConnection[] = [];
    private sshConnection: SSHConnection | undefined;
    private sshAgentSock: string | undefined;
    private proxyCommandProcess: cp.ChildProcessWithoutNullStreams | undefined;

    private socksTunnel: SSHTunnelConfig | undefined;
    private tunnels: TunnelInfo[] = [];
    private tmuxCapability: TmuxCapability | undefined;

    private labelFormatterDisposable: vscode.Disposable | undefined;

    /** Exposed for tmux terminal provider wiring — the SSH connection after resolve completes. */
    getSSHConnection(): SSHConnection | undefined {
        return this.sshConnection;
    }

    /** Exposed for tmux terminal provider wiring — the probe result after resolve completes. */
    getTmuxCapability(): TmuxCapability | undefined {
        return this.tmuxCapability;
    }

    /** Callback invoked after successful resolve() to wire tmux terminal components.
     * Must not throw; resolution failures are handled before calling. */
    private onResolveSuccess?: (() => void);

    /** Register a callback to be invoked after resolve() succeeds. Used by extension.ts
     * to wire terminal provider/reaper after SSH connection + tmux capability are known. */
    onResolveSuccessfullyCompleted(callback: () => void): void {
        this.onResolveSuccess = callback;
    }

    constructor(
        readonly context: vscode.ExtensionContext,
        readonly logger: Log
    ) {
    }

    resolve(authority: string, context: vscode.RemoteAuthorityResolverContext): Thenable<vscode.ResolverResult> {
        const [type, dest] = authority.split('+');
        if (type !== REMOTE_SSH_AUTHORITY) {
            throw new Error(`Invalid authority type for SSH resolver: ${type}`);
        }

        this.logger.info(`Resolving ssh remote authority '${authority}' (attempt #${context.resolveAttempt})`);

        const sshDest = SSHDestination.parseEncoded(dest);

        // It looks like default values are not loaded yet when resolving a remote,
        // so let's hardcode the default values here
        const remoteSSHconfig = vscode.workspace.getConfiguration('remote.SSH');
        const enableDynamicForwarding = remoteSSHconfig.get<boolean>('enableDynamicForwarding', true)!;
        const enableAgentForwarding = remoteSSHconfig.get<boolean>('enableAgentForwarding', true)!;
        const serverDownloadUrlTemplate = remoteSSHconfig.get<string>('serverDownloadUrlTemplate');
        const serverVersion = remoteSSHconfig.get<ServerVersion>('serverVersion', 'match');
        const defaultExtensions = remoteSSHconfig.get<string[]>('defaultExtensions', []);
        const remotePlatformMap = remoteSSHconfig.get<Record<string, string>>('remotePlatform', {});
        const remoteServerListenOnSocket = remoteSSHconfig.get<boolean>('remoteServerListenOnSocket', false)!;
        const connectTimeout = remoteSSHconfig.get<number>('connectTimeout', 60)!;
        const serverInstallPathMap = remoteSSHconfig.get<Record<string, string>>('serverInstallPath', {});

        return vscode.window.withProgress({
            title: `Setting up SSH Host ${sshDest.hostname}`,
            location: vscode.ProgressLocation.Notification,
            cancellable: false
        }, async () => {
            try {
                const sshconfig = await SSHConfiguration.loadFromFS();
                const sshHostConfig = sshconfig.getHostConfiguration(sshDest.hostname);
                const sshHostName = sshHostConfig['HostName'] ? expandTokens(sshHostConfig['HostName'], { h: sshDest.hostname }) : sshDest.hostname;
                const sshUser = sshHostConfig['User'] || sshDest.user || os.userInfo().username || ''; // https://github.com/openssh/openssh-portable/blob/5ec5504f1d328d5bfa64280cd617c3efec4f78f3/sshconnect.c#L1561-L1562
                const sshPort = sshHostConfig['Port'] ? parseInt(sshHostConfig['Port'], 10) : (sshDest.port || 22);

                this.sshAgentSock = sshHostConfig['IdentityAgent'] || process.env['SSH_AUTH_SOCK'] || (isWindows ? '\\\\.\\pipe\\openssh-ssh-agent' : undefined);
                this.sshAgentSock = this.sshAgentSock ? untildify(this.sshAgentSock) : undefined;
                const agentForward = enableAgentForwarding && (sshHostConfig['ForwardAgent'] || 'no').toLowerCase() === 'yes';
                const agent = agentForward && this.sshAgentSock ? new ssh2.OpenSSHAgent(this.sshAgentSock) : undefined;

                const preferredAuthentications = sshHostConfig['PreferredAuthentications'] ? sshHostConfig['PreferredAuthentications'].split(',').map(s => s.trim()) : ['publickey', 'password', 'keyboard-interactive'];

                const identityFiles: string[] = (sshHostConfig['IdentityFile'] as unknown as string[]) || [];
                const identitiesOnly = (sshHostConfig['IdentitiesOnly'] || 'no').toLowerCase() === 'yes';
                const identityKeys = await gatherIdentityFiles(identityFiles, this.sshAgentSock, identitiesOnly, this.logger);

                // Create proxy jump connections if any
                let proxyStream: ssh2.ClientChannel | stream.Duplex | undefined;
                if (sshHostConfig['ProxyJump']) {
                    const proxyJumps = sshHostConfig['ProxyJump'].split(',').filter(i => !!i.trim())
                        .map(i => {
                            const proxy = SSHDestination.parse(i);
                            const proxyHostConfig = sshconfig.getHostConfiguration(proxy.hostname);
                            return [proxy, proxyHostConfig] as [SSHDestination, Record<string, string>];
                        });
                    for (let i = 0; i < proxyJumps.length; i++) {
                        const [proxy, proxyHostConfig] = proxyJumps[i];
                        const proxyHostName = proxyHostConfig['HostName'] || proxy.hostname;
                        const proxyUser = proxyHostConfig['User'] || proxy.user || sshUser;
                        const proxyPort = resolveHopPort(proxyHostConfig['Port'], proxy.port);

                        const proxyAgentForward = enableAgentForwarding && (proxyHostConfig['ForwardAgent'] || 'no').toLowerCase() === 'yes';
                        const proxyAgent = proxyAgentForward && this.sshAgentSock ? new ssh2.OpenSSHAgent(this.sshAgentSock) : undefined;

                        const proxyIdentityFiles: string[] = (proxyHostConfig['IdentityFile'] as unknown as string[]) || [];
                        const proxyIdentitiesOnly = (proxyHostConfig['IdentitiesOnly'] || 'no').toLowerCase() === 'yes';
                        const proxyIdentityKeys = await gatherIdentityFiles(proxyIdentityFiles, this.sshAgentSock, proxyIdentitiesOnly, this.logger);

                        const proxyAuthHandler = this.getSSHAuthHandler(proxyUser, proxyHostName, proxyIdentityKeys, preferredAuthentications);
                        const proxyConnection = new SSHConnection({
                            host: !proxyStream ? proxyHostName : undefined,
                            port: !proxyStream ? proxyPort : undefined,
                            sock: proxyStream,
                            username: proxyUser,
                            readyTimeout: connectTimeout * 1000,
                            strictVendor: false,
                            agentForward: proxyAgentForward,
                            agent: proxyAgent,
                            hostVerifier: this.buildHostVerifier(proxyHostName, proxyPort),
                            authHandler: (arg0, arg1, arg2) => (proxyAuthHandler(arg0, arg1, arg2), undefined)
                        });
                        this.proxyConnections.push(proxyConnection);

                        const nextProxyJump = i < proxyJumps.length - 1 ? proxyJumps[i + 1] : undefined;
                        const destIP = nextProxyJump ? (nextProxyJump[1]['HostName'] || nextProxyJump[0].hostname) : sshHostName;
                        const destPort = nextProxyJump ? resolveHopPort(nextProxyJump[1]['Port'], nextProxyJump[0].port) : sshPort;
                        proxyStream = await proxyConnection.forwardOut('127.0.0.1', 0, destIP, destPort);
                    }
                } else if (sshHostConfig['ProxyCommand']) {
                    let proxyArgs = splitProxyCommand(sshHostConfig['ProxyCommand'] as unknown as string | string[])
                        .map((arg) => expandTokens(arg, { h: sshHostName, n: sshDest.hostname, p: sshPort.toString(), r: sshUser }));
                    let proxyCommand = proxyArgs.shift()!;

                    let options = {};
                    if (isWindows && /\.(bat|cmd)$/.test(proxyCommand)) {
                        proxyCommand = `"${proxyCommand}"`;
                        proxyArgs = proxyArgs.map((arg) => arg.includes(' ') ? `"${arg}"` : arg);
                        options = { shell: true, windowsHide: true, windowsVerbatimArguments: true };
                    }

                    this.logger.trace(`Spawning ProxyCommand: ${proxyCommand} ${proxyArgs.join(' ')}`);

                    const child = cp.spawn(proxyCommand, proxyArgs, options);
                    proxyStream = stream.Duplex.from({ readable: child.stdout, writable: child.stdin });
                    // A bad ProxyCommand binary (e.g. ENOENT) emits 'error' on the child process
                    // asynchronously, after this synchronous setup has returned — left unhandled
                    // that's an uncaught exception instead of the resolver's error dialog. Destroy
                    // the sock so ssh2's Client (which already listens for 'error' on `sock`, see
                    // node_modules/ssh2/lib/client.js) surfaces it through the normal
                    // connect()-rejects-into-catch path below. The stream listener is a defensive
                    // backstop against Duplex.from itself emitting 'error'.
                    child.on('error', (err) => {
                        this.logger.error(`ProxyCommand '${proxyCommand}' failed to start`, err);
                        proxyStream?.destroy(err);
                    });
                    proxyStream.on('error', (err) => {
                        this.logger.trace(`ProxyCommand stream error: ${err instanceof Error ? err.message : String(err)}`);
                    });
                    this.proxyCommandProcess = child;
                }

                // Create final shh connection
                const sshAuthHandler = this.getSSHAuthHandler(sshUser, sshHostName, identityKeys, preferredAuthentications);

                this.sshConnection = new SSHConnection({
                    host: !proxyStream ? sshHostName : undefined,
                    port: !proxyStream ? sshPort : undefined,
                    sock: proxyStream,
                    username: sshUser,
                    readyTimeout: connectTimeout * 1000,
                    strictVendor: false,
                    agentForward,
                    agent,
                    hostVerifier: this.buildHostVerifier(sshHostName, sshPort),
                    authHandler: (arg0, arg1, arg2) => (sshAuthHandler(arg0, arg1, arg2), undefined),
                });
                await this.sshConnection.connect();

                const envVariables: Record<string, string | null> = {};
                if (agentForward) {
                    envVariables['SSH_AUTH_SOCK'] = null;
                }

                // Find the custom install path for this hostname (supports wildcards)
                const customInstallPath = findServerInstallPath(sshDest.hostname, serverInstallPathMap);

                const installResult = await installCodeServer(
                    this.sshConnection,
                    serverDownloadUrlTemplate,
                    serverVersion,
                    defaultExtensions,
                    Object.keys(envVariables),
                    remotePlatformMap[sshDest.hostname],
                    remoteServerListenOnSocket,
                    customInstallPath,
                    this.logger,
                    this.context.extensionPath
                );

                // Probe for tmux capability on the remote
                this.tmuxCapability = await probeTmux(
                    (cmd) => this.sshConnection!.exec(cmd),
                    installResult.platform
                );
                if (!this.tmuxCapability.available) {
                    this.logger.info(`Persistent terminals unavailable: ${this.tmuxCapability.reason}`);
                }

                for (const key of Object.keys(envVariables)) {
                    if (!isNullable(installResult[key])) {
                        envVariables[key] = String(installResult[key]);
                    }
                }

                // Update terminal env variables
                this.context.environmentVariableCollection.persistent = false;
                for (const [key, value] of Object.entries(envVariables)) {
                    if (value) {
                        this.context.environmentVariableCollection.replace(key, value);
                    }
                }

                if (enableDynamicForwarding) {
                    const socksPort = await findRandomPort();
                    this.socksTunnel = await this.sshConnection!.addTunnel({
                        name: `ssh_tunnel_socks_${socksPort}`,
                        localPort: socksPort,
                        socks: true
                    });
                }

                const tunnelConfig = await this.openTunnel(0, installResult.listeningOn);
                this.tunnels.push(tunnelConfig);

                // Enable ports view
                vscode.commands.executeCommand('setContext', 'forwardedPortsViewEnabled', true);

                this.labelFormatterDisposable?.dispose();
                this.labelFormatterDisposable = vscode.workspace.registerResourceLabelFormatter({
                    scheme: 'vscode-remote',
                    authority: `${REMOTE_SSH_AUTHORITY}+*`,
                    formatting: {
                        label: '${path}',
                        separator: '/',
                        tildify: true,
                        workspaceSuffix: `SSH: ${sshDest.hostname}` + (sshDest.port && sshDest.port !== 22 ? `:${sshDest.port}` : '')
                    }
                });

                const resolvedResult: vscode.ResolverResult = new vscode.ResolvedAuthority('127.0.0.1', tunnelConfig.localPort, installResult.connectionToken);
                resolvedResult.extensionHostEnv = envVariables;

                // Trigger tmux wiring callback after successful resolution
                try {
                    this.onResolveSuccess?.();
                } catch (err) {
                    this.logger.trace(`onResolveSuccess callback failed: ${err instanceof Error ? err.message : String(err)}`);
                }

                return resolvedResult;
            } catch (e: unknown) {
                this.logger.error(`Error resolving authority`, e);

                // Initial connection
                if (context.resolveAttempt === 1) {
                    this.logger.show();

                    const closeRemote = 'Close Remote';
                    const retry = 'Retry';
                    const result = await vscode.window.showErrorMessage(`Could not establish connection to "${sshDest.hostname}"`, { modal: true }, closeRemote, retry);
                    if (result === closeRemote) {
                        await vscode.commands.executeCommand('workbench.action.remote.close');
                    } else if (result === retry) {
                        await vscode.commands.executeCommand('workbench.action.reloadWindow');
                    }
                }

                if (e instanceof ServerInstallError || !(e instanceof Error)) {
                    throw vscode.RemoteAuthorityResolverError.NotAvailable(e instanceof Error ? e.message : String(e));
                } else {
                    throw vscode.RemoteAuthorityResolverError.TemporarilyNotAvailable(e.message);
                }
            }
        });
    }

    private async openTunnel(localPort: number, remotePortOrSocketPath: number | string) {
        localPort = localPort > 0 ? localPort : await findRandomPort();

        const disposables: vscode.Disposable[] = [];
        const remotePort = typeof remotePortOrSocketPath === 'number' ? remotePortOrSocketPath : undefined;
        const remoteSocketPath = typeof remotePortOrSocketPath === 'string' ? remotePortOrSocketPath : undefined;
        if (this.socksTunnel && remotePort) {
            const forwardingServer = await new Promise<net.Server>((resolve, reject) => {
                this.logger.trace(`Creating forwarding server ${localPort}(local) => ${this.socksTunnel!.localPort!}(socks) => ${remotePort}(remote)`);
                const socksOptions: SocksClientOptions = {
                    proxy: {
                        host: '127.0.0.1',
                        port: this.socksTunnel!.localPort!,
                        type: 5
                    },
                    command: 'connect',
                    destination: {
                        host: '127.0.0.1',
                        port: remotePort
                    }
                };
                const server: net.Server = net.createServer()
                    .on('error', reject)
                    .on('connection', async (socket: net.Socket) => {
                        try {
                            const socksConn = await SocksClient.createConnection(socksOptions);
                            // An unhandled 'error' on either end of the pipe (e.g. ECONNRESET) would
                            // otherwise be an uncaught exception that kills the extension host.
                            // Destroy the counterpart so the pipe tears down cleanly instead.
                            socket.on('error', () => socksConn.socket.destroy());
                            socksConn.socket.on('error', () => socket.destroy());
                            socket.pipe(socksConn.socket);
                            socksConn.socket.pipe(socket);
                        } catch (error) {
                            this.logger.error(`Error while creating SOCKS connection`, error);
                        }
                    })
                    .on('listening', () => resolve(server))
                    .listen(localPort);
            });
            disposables.push({
                dispose: () => forwardingServer.close(() => {
                    this.logger.trace(`SOCKS forwading server closed`);
                }),
            });
        } else {
            this.logger.trace(`Opening tunnel ${localPort}(local) => ${remotePortOrSocketPath}(remote)`);
            const tunnelConfig = await this.sshConnection!.addTunnel({
                name: `ssh_tunnel_${localPort}_${remotePortOrSocketPath}`,
                remoteAddr: '127.0.0.1',
                remotePort,
                remoteSocketPath,
                localPort
            });
            disposables.push({
                dispose: () => {
                    this.sshConnection?.closeTunnel(tunnelConfig.name);
                    this.logger.trace(`Tunnel ${tunnelConfig.name} closed`);
                }
            });
        }

        return new TunnelInfo(localPort, remotePortOrSocketPath, disposables);
    }

    /**
     * Build the ssh2 `hostVerifier` for a target (the destination or a ProxyJump
     * hop). Upstream shipped none, so every host key was accepted silently — any
     * MITM went through. We verify the presented key against known_hosts: a known
     * key connects, an unseen host prompts for first-connect consent (then records
     * it), and a changed key hard-fails with no click-through. All decision/record
     * logic is the pure, unit-tested `verifyKnownHost`; this only adds the vscode
     * UI and bridges ssh2's key argument (see below).
     */
    private buildHostVerifier(host: string, port: number): NonNullable<ssh2.ConnectConfig['hostVerifier']> {
        const identity = hostKeyIdentity(host, port);
        return (keyHash, callback) => {
            // We never set `hostHash`, so ssh2 hands us the raw wire-format host-key
            // Buffer here even though @types/ssh2 declares the parameter `string`.
            // known_hosts stores that blob base64-encoded, which is what
            // verifyKnownHost compares against.
            const key = keyHash as unknown as Buffer;
            void verifyKnownHost({
                host: identity,
                key,
                promptForUnknownHost: (id, fingerprint) => this.promptNewHostKey(id, fingerprint),
            }).then(
                ({ verdict, verified }) => {
                    if (verdict === 'mismatch') {
                        this.logger.error(`Host key verification failed for ${identity}: presented key does not match known_hosts`);
                        void vscode.window.showErrorMessage(
                            `Host key verification failed for '${identity}': the key does not match the one recorded in known_hosts. This may indicate a man-in-the-middle attack, so the connection was refused. If the host key legitimately changed, remove the stale entry from your known_hosts file and reconnect.`,
                            { modal: true },
                        );
                    }
                    callback(verified);
                },
                (err) => {
                    // Read/record failure (e.g. EACCES) — fail closed, never accept.
                    this.logger.error(`Host key verification errored for ${identity}`, err);
                    callback(false);
                },
            );
        };
    }

    /**
     * First-connect consent prompt for an unknown host key (OpenSSH-style wording,
     * fingerprint shown). Cancelling or dismissing the modal rejects the key.
     */
    private async promptNewHostKey(identity: string, fingerprint: string): Promise<boolean> {
        const cont = 'Continue';
        const answer = await vscode.window.showWarningMessage(
            `The authenticity of host '${identity}' can't be established.\nKey fingerprint is ${fingerprint}.\n\nAre you sure you want to continue connecting? The key will be added to your known_hosts file.`,
            { modal: true },
            cont,
        );
        return answer === cont;
    }

    private getSSHAuthHandler(sshUser: string, sshHostName: string, identityKeys: SSHKey[], preferredAuthentications: string[]) {
        let passwordRetryCount = PASSWORD_RETRY_COUNT;
        let keyboardRetryCount = PASSWORD_RETRY_COUNT;
        identityKeys = identityKeys.slice();
        return async (methodsLeft: string[] | null, _partialSuccess: boolean | null, callback: (nextAuth: ssh2.AuthHandlerResult) => void) => {
            // ssh2 invokes this handler without awaiting it (it's a plain
            // callback-style API), so a throw/rejection anywhere below (e.g. the
            // identity file is deleted between the fileExists check and readFile,
            // or showInputBox rejects) would otherwise be an unhandled rejection
            // AND leave `callback` never called — ssh2 stalls until `readyTimeout`
            // instead of failing fast. This guarantees `callback(false)` ("try the
            // next auth method") always fires.
            try {
                if (methodsLeft === null) {
                    this.logger.info(`Trying no-auth authentication`);

                    return callback({
                        type: 'none',
                        username: sshUser,
                    });
                }
                if (methodsLeft.includes('publickey') && identityKeys.length && preferredAuthentications.includes('publickey')) {
                    const identityKey = identityKeys.shift()!;

                    this.logger.info(identityKey.parsedKey
                        ? `Trying publickey authentication: ${identityKey.filename} ${identityKey.parsedKey.type} SHA256:${identityKey.fingerprint}`
                        : `Trying publickey authentication: ${identityKey.filename} (encrypted, passphrase required)`);

                    if (identityKey.agentSupport) {
                        return callback({
                            type: 'agent',
                            username: sshUser,
                            agent: new class extends ssh2.OpenSSHAgent {
                                // Only return the current key
                                override getIdentities(callback: (err: Error | undefined, publicKeys?: ParsedKey[]) => void): void {
                                    // Invariant: agentSupport is only ever set alongside a resolved parsedKey (see identityFiles.ts).
                                    callback(undefined, [identityKey.parsedKey!]);
                                }
                            }(this.sshAgentSock!)
                        });
                    }
                    if (identityKey.isPrivate && identityKey.parsedKey) {
                        return callback({
                            type: 'publickey',
                            username: sshUser,
                            key: identityKey.parsedKey
                        });
                    }
                    if (!await fileExists(identityKey.filename)) {
                        // Try next identity file
                        // eslint-disable-next-line @typescript-eslint/no-explicit-any
                        return callback(null as any);
                    }

                    const keyBuffer = await fs.promises.readFile(identityKey.filename);
                    let result = ssh2.utils.parseKey(keyBuffer); // First try without passphrase
                    if (result instanceof Error && result.message === 'Encrypted private OpenSSH key detected, but no passphrase given') {
                        let passphraseRetryCount = PASSPHRASE_RETRY_COUNT;
                        while (result instanceof Error && passphraseRetryCount > 0) {
                            const passphrase = await vscode.window.showInputBox({
                                title: `Enter passphrase for ${identityKey.filename}`,
                                password: true,
                                ignoreFocusOut: true
                            });
                            if (!passphrase) {
                                break;
                            }
                            result = ssh2.utils.parseKey(keyBuffer, passphrase);
                            passphraseRetryCount--;
                        }
                    }
                    if (!result || result instanceof Error) {
                        // Try next identity file
                        // eslint-disable-next-line @typescript-eslint/no-explicit-any
                        return callback(null as any);
                    }

                    const key = Array.isArray(result) ? result[0] : result;
                    return callback({
                        type: 'publickey',
                        username: sshUser,
                        key
                    });
                }
                if (methodsLeft.includes('password') && passwordRetryCount > 0 && preferredAuthentications.includes('password')) {
                    if (passwordRetryCount === PASSWORD_RETRY_COUNT) {
                        this.logger.info(`Trying password authentication`);
                    }

                    const password = await vscode.window.showInputBox({
                        title: `Enter password for ${sshUser}@${sshHostName}`,
                        password: true,
                        ignoreFocusOut: true
                    });
                    passwordRetryCount--;

                    return callback(password
                        ? {
                            type: 'password',
                            username: sshUser,
                            password
                        }
                        : false);
                }
                if (methodsLeft.includes('keyboard-interactive') && keyboardRetryCount > 0 && preferredAuthentications.includes('keyboard-interactive')) {
                    if (keyboardRetryCount === PASSWORD_RETRY_COUNT) {
                        this.logger.info(`Trying keyboard-interactive authentication`);
                    }

                    return callback({
                        type: 'keyboard-interactive',
                        username: sshUser,
                        prompt: async (_name, _instructions, _instructionsLang, prompts, finish) => {
                            // Same fire-and-forget hazard as the outer handler: ssh2 calls
                            // `prompt` without awaiting it, so a throw here (e.g.
                            // showInputBox rejecting) would otherwise leave `finish` never
                            // called and this keyboard-interactive attempt stalled until
                            // `readyTimeout`. Treat a failure like a user cancel — finish
                            // with a full-length padded response array (never a short one,
                            // which would desync the protocol) and mark retries exhausted.
                            try {
                                const responses: string[] = [];
                                let cancelled = false;
                                for (const prompt of prompts) {
                                    const response = await vscode.window.showInputBox({
                                        title: `(${sshUser}@${sshHostName}) ${prompt.prompt}`,
                                        password: !prompt.echo,
                                        ignoreFocusOut: true
                                    });
                                    if (response === undefined) {
                                        cancelled = true;
                                        break;
                                    }
                                    responses.push(response);
                                }
                                const { finishWith, retriesExhausted } = buildKeyboardInteractiveFinish(prompts.length, responses, cancelled);
                                if (retriesExhausted) {
                                    keyboardRetryCount = 0;
                                } else {
                                    keyboardRetryCount--;
                                }
                                finish(finishWith);
                            } catch (err) {
                                this.logger.error(`Keyboard-interactive prompt failed`, err);
                                keyboardRetryCount = 0;
                                finish(buildKeyboardInteractiveFinish(prompts.length, [], true).finishWith);
                            }
                        }
                    });
                }

                callback(false);
            } catch (err) {
                this.logger.error(`SSH auth handler failed`, err);
                callback(false);
            }
        };
    }

    dispose() {
        disposeAll(this.tunnels);
        for (const connection of connectionsToClose(this.sshConnection, this.proxyConnections)) {
            connection.close().catch((err) => {
                this.logger.trace(`Error closing SSH connection during dispose: ${err instanceof Error ? err.message : String(err)}`);
            });
        }
        this.proxyCommandProcess?.kill();
        this.labelFormatterDisposable?.dispose();
    }
}
