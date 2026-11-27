import * as cp from 'child_process';
import * as fs from 'fs';
import * as net from 'net';
import * as stream from 'stream';
import { SocksClient, SocksClientOptions } from 'socks';
import * as vscode from 'vscode';
import * as ssh2 from 'ssh2';
import type { ParsedKey } from 'ssh2';
import Log from './common/logger';
import SSHDestination from './ssh/sshDestination';
import SSHConnection, { SSHTunnelConfig } from './ssh/sshConnection';
import SSHConfiguration from './ssh/sshConfig';
import { gatherIdentityFiles, isPassphraseRequired } from './ssh/identityFiles';
import { verifyKnownHost, knownHostsFiles, knownHostsLookupName, readKnownHostKeyTypes, serverHostKeyPreference, type HostKeyVerdict } from './ssh/hostfile';
import { untildify, exists as fileExists } from './common/files';
import { findRandomPort } from './common/ports';
import { disposeAll } from './common/disposable';
import { installCodeServer, ServerInstallError, findServerInstallPath } from './serverSetup';
import { isWindows } from './common/platform';
import * as os from 'os';
import { isNullable } from '@zokugun/is-it-type';
import { ServerVersion } from './serverConfig';
import { probeTmux, type TmuxCapability } from './tmux/tmuxBootstrap';
import { applyEnvCollection } from './common/envCollection';
import { withDeadline } from './common/deadline';

const PASSWORD_RETRY_COUNT = 3;
const PASSPHRASE_RETRY_COUNT = 3;

export const REMOTE_SSH_AUTHORITY = 'ssh-remote';

export function getRemoteAuthority(host: string) {
    return `${REMOTE_SSH_AUTHORITY}+${host}`;
}

/**
 * Split `ssh-remote+<encoded-host>` into its type and its destination.
 *
 * The authority has exactly one separator — the *first* `+`; everything after it
 * belongs to the destination. `authority.split('+')` (what this replaces)
 * destructured only the first two segments, so a Host alias containing a `+`
 * (legal in ssh_config, and passed through verbatim by VS Code) was truncated:
 * `ssh-remote+my+host` resolved `dest === 'my'` and we connected to the wrong
 * host, or more often to none at all.
 */
export function parseAuthority(authority: string): { type: string; dest: string } {
    const separator = authority.indexOf('+');
    return separator === -1
        ? { type: authority, dest: '' }
        : { type: authority.slice(0, separator), dest: authority.slice(separator + 1) };
}

/**
 * Whether a `ProxyJump`/`ProxyCommand` value means "do not proxy" — either unset
 * or the literal `none`.
 *
 * `none` is the documented OpenSSH way to *cancel* a proxy inherited from an
 * earlier or wildcard block (ssh_config(5)), and ssh-config's first-seen-wins
 * `compute()` faithfully hands it back to us. `'none'` is truthy, so a plain
 * `if (sshHostConfig['ProxyCommand'])` took the proxy branch anyway and spawned a
 * binary literally called `none` → ENOENT → "Could not establish connection";
 * `ProxyJump none` likewise tried to resolve a host named `none`. Folding the
 * unset case in here too keeps the call site a single check per branch.
 *
 * OpenSSH compares case-insensitively (`strcasecmp(*arg, "none")`), so we do too.
 * The array shape is the same defensive ssh-config-version compatibility path
 * {@link splitProxyCommand} carries.
 */
export function isProxyDisabled(value: string | string[] | undefined): boolean {
    // A whitespace-only value counts as unset: `splitProxyCommand` yields no
    // tokens for it, so the old truthiness check spawned `undefined` (ENOENT).
    const text = (Array.isArray(value) ? value.join(' ') : value ?? '').trim();
    return !text || text.toLowerCase() === 'none';
}

/** Which proxy a host's configuration asks for — see {@link chooseProxy}. */
export type ProxyChoice =
    | { kind: 'none' }
    | { kind: 'jump'; value: string }
    | { kind: 'command'; value: string | string[] };

/**
 * Fork: pick between `ProxyJump` and `ProxyCommand` the way OpenSSH does. ssh_config(5):
 * the two compete, and "whichever is specified first will prevent later instances of
 * the other from taking effect" — `none` included, so `ProxyJump none` in a host block
 * also cancels a `ProxyCommand` inherited from `Host *`. Upstream always tried
 * ProxyJump first, and a `none` there fell through to the ProxyCommand.
 *
 * "First" is read off the key order of ssh-config's `compute()` result, which lists
 * each option where it first saw it (pinned by test/authResolver.chooseProxy.test.ts).
 * A blank value specifies nothing and is skipped — see {@link isProxyDisabled}.
 */
export function chooseProxy(hostConfig: Readonly<Record<string, string | string[] | undefined>>): ProxyChoice {
    for (const [key, value] of Object.entries(hostConfig)) {
        if ((key !== 'ProxyJump' && key !== 'ProxyCommand') || value === undefined) {
            continue;
        }
        const text = (Array.isArray(value) ? value.join(' ') : value).trim();
        if (!text) {
            continue;
        }
        if (isProxyDisabled(value)) {
            return { kind: 'none' };
        }
        return key === 'ProxyJump' ? { kind: 'jump', value: text } : { kind: 'command', value };
    }
    return { kind: 'none' };
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

/**
 * Fork: the callback ssh2 hands an `authHandler`, as ssh2 really takes it (lib/client.js
 * `doNextAuth`): besides an auth method, `false` — no methods left, fail the connect —
 * and `null` — skip this attempt and ask again. @types/ssh2's `NextAuthHandler` declares
 * neither, hence the one cast where the handlers are passed to ssh2.
 */
type NextAuth = (nextAuth: ssh2.AnyAuthMethod | false | null) => void;

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
 * OpenSSH itself does no tokenization at all — it hands the string to a shell —
 * so this approximates what that shell would do, which is platform-dependent:
 * - whitespace separates tokens (outside quotes), on both platforms
 * - double quotes group a single token, on both platforms
 * - single quotes group a single token on a POSIX client only, with nothing inside
 *   them an escape (`sh -c 'nc %h %p'`); cmd.exe does not quote with them
 * - a backslash escapes the next character only on a POSIX client (`/bin/sh`),
 *   and even there only `"` and `\` are escapes *inside* double quotes — sh
 *   leaves every other backslash in a quoted span alone.
 *
 * The unconditional "backslash escapes anything, anywhere" rule this replaces
 * silently destroyed Windows ProxyCommands: `C:\Users\me\proxy.exe -H %h` came
 * out as `C:Usersmeproxy.exe` and spawned as ENOENT, and even a *quoted*
 * `"C:\Program Files\nc.exe"` came out as `C:Program Filesnc.exe` — despite the
 * `isWindows && /\.(bat|cmd)$/` branch at the call site showing Windows
 * ProxyCommands are a supported path. Trade-off: on Windows we lose shell-style
 * escaping entirely, so `\ ` no longer joins a path around a space — that path
 * must be double-quoted (which now works on both platforms). `\` is the path
 * separator in practically every Windows ProxyCommand and an escape in almost
 * none, so that is the cheaper half.
 *
 * `windows` is a parameter (not read straight from `isWindows`) so both
 * behaviours are unit-testable on either CI platform.
 *
 * Array inputs are passed through for defensive compatibility with older
 * ssh-config versions.
 */
export function splitProxyCommand(value: string | string[], windows: boolean = isWindows): string[] {
    if (Array.isArray(value)) {return value.slice();}
    const out: string[] = [];
    let cur = '';
    let i = 0;
    let quoted = false;
    let hasToken = false;
    while (i < value.length) {
        const ch = value[i];
        if (!windows && ch === '\\' && i + 1 < value.length && (!quoted || value[i + 1] === '"' || value[i + 1] === '\\')) {
            cur += value[i + 1];
            i += 2;
            hasToken = true;
            continue;
        }
        // An unterminated `'` is kept as an ordinary character rather than swallowing the rest.
        const closingQuote = !windows && !quoted && ch === '\'' ? value.indexOf('\'', i + 1) : -1;
        if (closingQuote !== -1) {
            cur += value.slice(i + 1, closingQuote);
            i = closingQuote + 1;
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
 * Resolve an SSH port: the port written in the destination (`host:2201`, a ProxyJump
 * `host:2201`) wins, else ssh_config `Port`, else `fallback` (22).
 *
 * Fork: upstream let ssh_config `Port` beat the destination's own port. OpenSSH does
 * the opposite — a port given on the command line (`-p`, `ssh://host:port`, a
 * ProxyJump spec) is never overridden by the config — so `box:2201` now means 2201.
 *
 * Shared by the destination, a hop's own connection port and the *next* hop's
 * forward-out destination port so all agree — the hop's own port previously fell back
 * to the final destination's port (`sshPort`) instead of 22, which is wrong
 * whenever the final host listens on a non-standard port.
 */
export function resolveHopPort(configuredPort: string | undefined, jumpPort: number | undefined, fallback = 22): number {
    return jumpPort || (configuredPort ? parseInt(configuredPort, 10) : fallback);
}

/**
 * Fork: the login user — the one written in the destination (`admin@box`, the
 * equivalent of `ssh admin@box` / `-l`), else ssh_config `User`, else the local user.
 * Upstream let the config win, so `admin@box` logged in as the config's user; OpenSSH
 * never lets the config override a user given on the command line.
 *
 * `localUser` is a function so it is only looked up as the last resort:
 * `os.userInfo()` throws for a UID with no passwd entry (containers), which must not
 * stop a connect that names its user.
 */
export function resolveUser(destinationUser: string | undefined, configuredUser: string | undefined, localUser: () => string): string {
    return destinationUser || configuredUser || localUser();
}

/**
 * The name to dial for `alias`: ssh_config `HostName` with `%h` (and `%%`) expanded,
 * else the alias itself. Fork: one rule for the destination and every ProxyJump hop —
 * upstream expanded `%h` for the destination only, so a hop was dialled as a literal
 * `%h.internal`.
 */
export function resolveHostName(configuredHostName: string | undefined, alias: string): string {
    return configuredHostName ? expandTokens(configuredHostName, { h: alias }) : alias;
}

/**
 * Fork: who and where a ProxyJump hop is. A hop is its own `ssh` invocation, so each
 * part comes from its ProxyJump entry (`user@host:port`), else from *that hop's* config,
 * else the default — the local user, port 22. The destination's login is deliberately
 * not a parameter: upstream fell back to it, and `admin@box` behind `ProxyJump bastion`
 * tried to log in to bastion as admin.
 */
export function resolveProxyJumpHop(
    hop: { hostname: string; user?: string; port?: number },
    hopConfig: { HostName?: string; User?: string; Port?: string },
    localUser: () => string
): { hostName: string; user: string; port: number } {
    return {
        hostName: resolveHostName(hopConfig.HostName, hop.hostname),
        user: resolveUser(hop.user, hopConfig.User, localUser),
        port: resolveHopPort(hopConfig.Port, hop.port),
    };
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

/** Longest unterminated stderr run we buffer before flushing it anyway — see
 * {@link drainProxyCommandStderr}. Generous enough for any real diagnostic line,
 * small enough that a proxy spewing newline-free binary can't grow our heap. */
const MAX_STDERR_LINE = 8192;

/**
 * Consume a ProxyCommand child's stderr, handing complete lines to `onLine`.
 *
 * `cp.spawn` pipes all three stdio streams by default, but only `stdout`/`stdin`
 * are wired up (into the ssh2 `sock`). Nothing read `stderr`, so as soon as the
 * proxy had written one pipe buffer (~64KB on Linux) to it the child blocked on
 * write *forever*: the connect then hung until `readyTimeout` with nothing in the
 * log to explain it. Verbose proxies (`ssh -v -W …`, `cloudflared`) reach that
 * routinely, and below the threshold every diagnostic they emitted was thrown
 * away. Draining fixes the hang; logging what we drained is the diagnostic that
 * was missing.
 *
 * Line-buffered so a chunk boundary mid-message doesn't produce two garbled log
 * entries, and defensive on every edge: `onLine` failures and stream `error`s are
 * swallowed (the point is to keep *reading*, and an unhandled stream 'error'
 * would take down the extension host), and an over-long unterminated run is
 * flushed rather than buffered without limit.
 *
 * Caller's responsibility: log this at trace level only. Proxy stderr is
 * attacker-influenced third-party output and may echo prompts; it is never
 * credentials we hold, but it does not belong in the default-visible log.
 */
export function drainProxyCommandStderr(stderr: stream.Readable | null | undefined, onLine: (line: string) => void): void {
    if (!stderr) {
        return;
    }
    let buffered = '';
    const emit = (line: string) => {
        const trimmed = line.replace(/\r$/, '');
        if (!trimmed.trim()) {
            return;
        }
        try {
            onLine(trimmed);
        } catch {
            // A failing logger must never stop us draining the pipe — that would
            // reinstate the very hang this function exists to prevent. It also
            // must not escape: we're inside a stream 'data' emit.
        }
    };
    stderr.setEncoding('utf8');
    stderr.on('data', (chunk: string) => {
        buffered += chunk;
        let newline = buffered.indexOf('\n');
        while (newline !== -1) {
            emit(buffered.slice(0, newline));
            buffered = buffered.slice(newline + 1);
            newline = buffered.indexOf('\n');
        }
        while (buffered.length > MAX_STDERR_LINE) {
            emit(buffered.slice(0, MAX_STDERR_LINE));
            buffered = buffered.slice(MAX_STDERR_LINE);
        }
    });
    const flush = () => {
        if (buffered) {
            emit(buffered);
            buffered = '';
        }
    };
    stderr.on('end', flush);
    stderr.on('close', flush);
    stderr.on('error', () => {
        // The child died mid-write (EPIPE/ECONNRESET on the pipe). Nothing to do
        // but stop; the resolver already surfaces the failure through the child's
        // own 'error' handler and the destroyed sock.
    });
}

/** Fork: ssh2 keepalive when the ssh config sets none (15 s × 3 → a dead link is noticed in ~45 s). */
const DEFAULT_KEEPALIVE_INTERVAL_S = 15;
const DEFAULT_KEEPALIVE_COUNT_MAX = 3;

/**
 * ssh2 keepalive settings from OpenSSH's `ServerAliveInterval` (seconds; `0` disables,
 * as in OpenSSH) and `ServerAliveCountMax`, else the defaults above. Without any, ssh2
 * never noticed a half-dead link (sleep, NAT drop): every channel open on it — a
 * terminal's exec, VS Code's SOCKS reconnect — waited forever.
 */
export function keepaliveConfig(serverAliveInterval: string | undefined, serverAliveCountMax: string | undefined): { keepaliveInterval: number; keepaliveCountMax: number } {
    const whole = (value: string | undefined) => value !== undefined && /^\d+$/.test(value.trim()) ? parseInt(value, 10) : undefined;
    return {
        keepaliveInterval: (whole(serverAliveInterval) ?? DEFAULT_KEEPALIVE_INTERVAL_S) * 1000,
        keepaliveCountMax: whole(serverAliveCountMax) || DEFAULT_KEEPALIVE_COUNT_MAX,
    };
}

/**
 * Open the channel through ProxyJump hop `hop` to the next hop (or the destination),
 * bounded: on a half-dead hop the channel open is never answered. The hop's own
 * connect (auth, which may prompt) stays governed by its `readyTimeout`.
 */
export async function openProxyJumpStream<T>(
    hop: { connect(): Promise<unknown>; forwardOut(srcIP: string, srcPort: number, destIP: string, destPort: number): Promise<T> },
    destIP: string,
    destPort: number,
    timeoutMs: number
): Promise<T> {
    await hop.connect();
    return withDeadline(hop.forwardOut('127.0.0.1', 0, destIP, destPort), timeoutMs, `ProxyJump channel to ${destIP}:${destPort}`);
}

/** A ProxyCommand refused before spawning; not retryable (the config will not change). */
export class ProxyCommandRejectedError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'ProxyCommandRejectedError';
    }
}

/**
 * Fork: ssh2 connect config that asks a server first for the host-key types already on
 * file for it (`knownKeyTypes`, known_hosts field 2) — see `serverHostKeyPreference`.
 * It only reorders ssh2's default offer (take the preferred names out, put them back in
 * front); the RegExp form of `prepend` adds nothing ssh2 does not support, where a
 * plain name would throw. Empty when nothing is on file: ssh2 keeps its own order.
 */
export function hostKeyAlgorithms(knownKeyTypes: readonly string[]): Pick<ssh2.ConnectConfig, 'algorithms'> {
    const preferred = serverHostKeyPreference(knownKeyTypes);
    if (!preferred.length) {
        return {};
    }
    const serverHostKey = {
        remove: preferred,
        prepend: preferred.map((name) => new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`)),
    };
    // ssh2 accepts a RegExp in these lists (lib/utils.js `generateAlgorithmList`); its
    // typings declare algorithm names only, and require an `append` we have no use for.
    return { algorithms: { serverHostKey: serverHostKey as unknown as ssh2.AlgorithmList<ssh2.ServerHostKeyAlgorithm> } };
}

// What a `%h`/`%n`/`%r` value expanded into a ProxyCommand may not contain. It starts
// from OpenSSH's own checks on a host or user name given on the command line (ssh.c
// `valid_hostname` / `valid_ruser`, CVE-2023-51385): no leading `-` (an option of the
// proxy program), no quote, no `;&<>|(){}`, no control character. It is deliberately
// stricter than OpenSSH from there: `valid_ruser` lets `$`, whitespace and `\` through,
// and the value may land inside the user's own `sh -c "… %r"` or a remote shell
// (`ssh bastion nc %h %p`). So anything a POSIX shell or a glob could interpret is
// refused for both: `$`, `\`, whitespace, `%`, `!`, `*`, `?`, `[`, `]`, `~`, `#`.
const UNSAFE_TOKEN_VALUE = /^-|['`"$\\;&<>|(){}\s%!*?[\]~#]|\p{Cc}/u;
// The one `%` a host name may carry: the zone of a link-local IPv6 literal (`fe80::1%eth0`).
const IPV6_ZONE = /^([0-9a-f.]*:[0-9a-f:.]*)%[A-Za-z0-9_.-]+$/i;

/**
 * The characters that follow a `%` in a ProxyCommand's words — i.e. the tokens it really
 * expands. Scanned as {@link expandTokens} does, so `%%r` is a literal `%r`, not a use.
 */
function usedTokens(templates: readonly string[]): Set<string> {
    const used = new Set<string>();
    for (const template of templates) {
        for (let i = 0; i < template.length - 1; i++) {
            if (template[i] === '%') {
                used.add(template[++i]);
            }
        }
    }
    return used;
}

// cmd.exe metacharacters (plus line breaks): inside a `%x` token they would be
// command syntax, not text — see buildProxyCommandSpawn().
const CMD_METACHARACTERS = /[&|<>^%"!()\r\n]/;

/**
 * How to spawn a ProxyCommand: argv split ({@link splitProxyCommand}), `%h %n %p %r`
 * expanded ({@link expandTokens}).
 *
 * `%h`, `%n` and `%r` come from the remote authority — a link, a workspace file — and
 * the command passes them on: `ssh bastion nc %h %p` to the bastion's shell,
 * `sh -c "nc %h %p"` to a local one. So on every platform a value that a shell could
 * interpret is refused before anything is spawned (`UNSAFE_TOKEN_VALUE` — stricter than
 * OpenSSH on purpose), and `%p` must be a number. Only the tokens the command really
 * uses are vetted: a value that is never expanded reaches nothing, and must not stop
 * `O'Brien@box` from connecting through `nc %h %p`. The error names the token, never
 * the value. A token in the first word — the program — is refused whatever its value.
 *
 * A Windows `.bat`/`.cmd` must run through cmd.exe
 * (`shell: true`, verbatim args), where a token value from the remote authority — a
 * link, a workspace file — containing `&`, `|`, `%`, `"`, … would be command syntax
 * (`ssh-remote+x&calc` ran `calc`). Such a value is refused before it reaches cmd.
 *
 * Arguments are quoted only when they contain a space, as upstream did: a `.bat` sees
 * its quotes in `%1`, so quoting every argument would break working scripts. With the
 * authority tokens vetted, what remains unquoted is the user's own config text.
 */
export function buildProxyCommandSpawn(
    value: string | string[],
    tokens: { h: string; n: string; p: string; r: string },
    windows: boolean = isWindows
): { command: string; args: string[]; options: cp.SpawnOptionsWithoutStdio } {
    const words = splitProxyCommand(value, windows);
    // The first word is the program to run, and the value checks below allow `/` and
    // `..`: a token there would let the authority choose what is launched.
    if (['h', 'n', 'r', 'p'].some((token) => usedTokens(words.slice(0, 1)).has(token))) {
        throw new ProxyCommandRejectedError('Refusing to run the ProxyCommand: its program name contains a % token; tokens are only expanded in arguments');
    }
    const used = usedTokens(words);
    const isUnsafe: Record<'h' | 'n' | 'r' | 'p', (tokenValue: string) => boolean> = {
        h: (host) => UNSAFE_TOKEN_VALUE.test(host.replace(IPV6_ZONE, '$1')),
        n: (host) => UNSAFE_TOKEN_VALUE.test(host.replace(IPV6_ZONE, '$1')),
        r: (user) => UNSAFE_TOKEN_VALUE.test(user),
        p: (port) => !/^\d+$/.test(port),
    };
    for (const token of ['h', 'n', 'r', 'p'] as const) {
        if (used.has(token) && isUnsafe[token](tokens[token])) {
            throw new ProxyCommandRejectedError(`Refusing to run the ProxyCommand: the %${token} value is not a safe ${token === 'r' ? 'user name' : token === 'p' ? 'port' : 'host name'}`);
        }
    }
    let args = words.map((arg) => expandTokens(arg, tokens));
    let command = args.shift()!;
    let options: cp.SpawnOptionsWithoutStdio = {};
    if (windows && /\.(bat|cmd)$/.test(command)) {
        for (const [token, tokenValue] of Object.entries(tokens)) {
            if (used.has(token) && CMD_METACHARACTERS.test(tokenValue)) {
                throw new ProxyCommandRejectedError(`Refusing to run a .bat/.cmd ProxyCommand: the %${token} value contains a cmd.exe metacharacter`);
            }
        }
        command = `"${command}"`;
        args = args.map((arg) => arg.includes(' ') ? `"${arg}"` : arg);
        options = { shell: true, windowsHide: true, windowsVerbatimArguments: true };
    }
    return { command, args, options };
}

/** The ProxyCommand for the log: its arguments can carry tokens or credentials. */
export function redactedProxyCommandLine(command: string, args: readonly string[]): string {
    return `${command} (${args.length} argument(s) redacted)`;
}

/** The one thing teardown needs of an `SSHConnection`. */
export interface ClosableConnection {
    close(): Promise<void>;
}

/**
 * Which connections `dispose()` (and a retry's teardown) must close. A ProxyJump
 * chain connects hop[0] for real (TCP); each later hop, and the destination
 * connection sitting on top of the chain, is layered on via a forwarded-out
 * stream (`sock:` in the ssh2 config) — ending hop[0] tends to cascade down
 * through those interrupted streams, but that's an implicit transport side
 * effect, not something this resolver should rely on to close connections it
 * created. Close every one of them explicitly instead of only hop[0].
 *
 * Typed structurally (not as `SSHConnection`) so {@link teardownAttempt} — its
 * only consumer besides `dispose()` — stays unit-testable without ssh2.
 */
export function connectionsToClose(sshConnection: ClosableConnection | undefined, proxyConnections: readonly ClosableConnection[]): ClosableConnection[] {
    return [sshConnection, ...proxyConnections].filter((connection): connection is ClosableConnection => connection !== undefined);
}

/**
 * One resolve attempt's disposable state, structurally typed — no ssh2, no
 * `child_process` — so the release order and failure-isolation below are unit
 * tested rather than only reachable through a live connection.
 */
export interface AttemptTeardown {
    /** Open tunnels. Emptied in place by `disposeAll`, so a retry neither
     * re-disposes them nor keeps growing the array. */
    readonly tunnels: vscode.Disposable[];
    /** The destination connection, if the attempt got that far. */
    readonly sshConnection: ClosableConnection | undefined;
    /** Every ProxyJump hop, in the order they were dialled. */
    readonly proxyConnections: readonly ClosableConnection[];
    /** The ProxyCommand child, if one was spawned. */
    readonly proxyCommandProcess: { kill(): unknown } | undefined;
}

/**
 * Release everything one resolve attempt allocated: tunnels first (they sit on
 * top of the connections), then every connection, then the ProxyCommand child
 * whose stdio the connections were riding on — outermost first, RAII order.
 *
 * Shared by `dispose()` and by the *start* of `resolve()`: one resolver instance
 * lives for the extension's lifetime and `resolve()` is re-entered on every
 * retry/reconnect, so without this each attempt silently abandoned the previous
 * attempt's authenticated connection, its listening local forwarding/SOCKS
 * servers, and its ProxyCommand child (`dispose()` only ever saw the *latest* of
 * each). A transient `installCodeServer` failure — TemporarilyNotAvailable, which
 * VS Code retries — leaked one full set per attempt, for the window's lifetime.
 *
 * Nothing here is allowed to throw: on the retry path a failure while releasing
 * attempt N-1 must neither abort attempt N nor strand the rest of attempt N-1's
 * handles. Every failure is reported through `onError` instead — which is also
 * why this doesn't let `disposeAll`'s deliberate rethrow escape.
 */
export function teardownAttempt(state: AttemptTeardown, onError: (message: string, err: unknown) => void): void {
    try {
        disposeAll(state.tunnels);
    } catch (err) {
        onError('Error disposing SSH tunnels', err);
    }
    for (const connection of connectionsToClose(state.sshConnection, state.proxyConnections)) {
        try {
            connection.close().catch((err) => onError('Error closing SSH connection', err));
        } catch (err) {
            onError('Error closing SSH connection', err);
        }
    }
    if (state.proxyCommandProcess) {
        try {
            state.proxyCommandProcess.kill();
        } catch (err) {
            onError('Error killing ProxyCommand process', err);
        }
    }
}

/** What the user and the log are told when a host key is refused. Message only —
 * there is deliberately no action/override field for a caller to wire a button to. */
export interface HostKeyRejectionNotice {
    readonly logMessage: string;
    readonly message: string;
}

/**
 * The operator-facing explanation for a refused host key, per verdict — the only
 * part of `buildHostVerifier`'s reaction that isn't already `verifyKnownHost`'s
 * (tested) decision, extracted so the wording itself is pinned by a test.
 *
 * `known` and `unknown` produce nothing: the first is a plain accept, the second
 * is handled by the first-connect consent prompt, not by an error.
 *
 * `mismatch` and `revoked` must never share wording. Mismatch means the key
 * changed — the honest remediation is "if that was legitimate, drop the stale
 * known_hosts entry and reconnect". Applying that advice to a `@revoked` record
 * (which `hostfile.ts` parses since it learned OpenSSH's markers — before that a
 * revoked key surfaced as `unknown` and the user was offered the ordinary
 * first-connect prompt for a key the admin had explicitly revoked) would be
 * telling the user to delete the revocation and then trust the revoked key.
 * OpenSSH hard-refuses a revoked key; so do we — no bypass, and no hint at one.
 */
export function hostKeyRejectionNotice(verdict: HostKeyVerdict, identity: string): HostKeyRejectionNotice | undefined {
    switch (verdict) {
        case 'mismatch':
            return {
                logMessage: `Host key verification failed for ${identity}: presented key does not match known_hosts`,
                message: `Host key verification failed for '${identity}': the key does not match the one recorded in known_hosts. This may indicate a man-in-the-middle attack, so the connection was refused. If the host key legitimately changed, remove the stale entry from your known_hosts file and reconnect.`,
            };
        case 'revoked':
            return {
                logMessage: `Host key verification failed for ${identity}: presented key is marked @revoked`,
                message: `The host key for '${identity}' has been revoked. Whoever administers this host marked the key as no longer valid, so the connection was refused. Ask them for the host's current key.`,
            };
        default:
            return undefined;
    }
}

export class RemoteSSHResolver implements vscode.RemoteAuthorityResolver, vscode.Disposable {

    private proxyConnections: SSHConnection[] = [];
    private sshConnection: SSHConnection | undefined;
    private sshAgentSock: string | undefined;
    private proxyCommandProcess: cp.ChildProcessWithoutNullStreams | undefined;

    private socksTunnel: SSHTunnelConfig | undefined;
    private tunnels: TunnelInfo[] = [];
    private tmuxCapability: TmuxCapability | undefined;
    /** Remote OS as reported by the server install (`linux`/`macos`/`windows`), captured for
     * the terminal layer: VS Code keys `terminal.integrated.defaultProfile.<suffix>` off the
     * REMOTE platform, so writing that setting needs this, not the client's platform. */
    private remotePlatform: string | undefined;
    /** The `ssh-remote+…` authority this resolver was last asked to resolve — see
     * {@link getAuthority}. */
    private resolvedAuthority: string | undefined;
    /** Terminal environment variables this resolver has already contributed, so a
     * re-resolve rewrites only what changed (`common/envCollection.ts`). Survives across
     * resolve attempts because the resolver instance does. */
    private readonly appliedEnvVariables = new Map<string, string>();

    private labelFormatterDisposable: vscode.Disposable | undefined;

    /** Exposed for tmux terminal provider wiring — the SSH connection after resolve completes. */
    getSSHConnection(): SSHConnection | undefined {
        return this.sshConnection;
    }

    /** Exposed for tmux terminal provider wiring — the probe result after resolve completes. */
    /** Remote OS after resolve completes — see {@link defaultProfileSettingKey}. */
    getRemotePlatform(): string | undefined {
        return this.remotePlatform;
    }

    /** The full `ssh-remote+<encoded-host>` authority of this connection, for addressing the
     * remote filesystem (`vscode.Uri`). Set as soon as `resolve` is entered, so it is
     * available even while the connection is still coming up. */
    getAuthority(): string | undefined {
        return this.resolvedAuthority;
    }

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

    /**
     * Release whatever the *previous* resolve attempt allocated, before this one
     * allocates its own.
     *
     * Ordering matters and is deliberate: this runs at the very top of the resolve
     * body, before a single new connection/tunnel/child is assigned to a field, so
     * it can only ever see state from an earlier attempt — it can never tear down
     * what the current attempt is building. The one case it does cut short is a
     * *still-in-flight* earlier attempt (VS Code awaits our promise before
     * retrying, so this needs a caller that re-enters concurrently): that attempt's
     * connection dies under it and it fails fast into the catch below. Newest
     * attempt wins, deliberately — the alternative is the leak this exists to fix.
     */
    private teardownPreviousAttempt(): void {
        teardownAttempt(
            {
                tunnels: this.tunnels,
                sshConnection: this.sshConnection,
                proxyConnections: this.proxyConnections,
                proxyCommandProcess: this.proxyCommandProcess,
            },
            (message, err) => this.logger.trace(`${message}: ${err instanceof Error ? err.message : String(err)}`)
        );
        this.sshConnection = undefined;
        this.proxyConnections = [];
        this.proxyCommandProcess = undefined;
        // Not closed explicitly: the SOCKS tunnel belongs to `sshConnection` and
        // went down with it (`SSHConnection#close` closes its tunnels). Dropping
        // the reference stops `openTunnel` routing the next attempt's traffic
        // through a dead tunnel's port.
        this.socksTunnel = undefined;
    }

    resolve(authority: string, context: vscode.RemoteAuthorityResolverContext): Thenable<vscode.ResolverResult> {
        const { type, dest } = parseAuthority(authority);
        if (type !== REMOTE_SSH_AUTHORITY) {
            throw new Error(`Invalid authority type for SSH resolver: ${type}`);
        }

        this.logger.info(`Resolving ssh remote authority '${authority}' (attempt #${context.resolveAttempt})`);

        // Remember the authority VS Code is actually connected through. It is the only
        // first-hand source of it — `vscode.env.remoteName` gives just the type (`ssh-remote`),
        // and the workspace-folder URI is absent in an empty window — and the clipboard bridge
        // needs the full string to address the remote filesystem (`getAuthority`).
        this.resolvedAuthority = authority;

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
                // Every attempt starts from a clean slate — see teardownPreviousAttempt().
                this.teardownPreviousAttempt();

                // Fork: Include problems (a legacy comma-separated list) go to the log.
                const sshconfig = await SSHConfiguration.loadFromFS(undefined, (message) => this.logger.info(`SSH config: ${message}`));
                const sshHostConfig = sshconfig.getHostConfiguration(sshDest.hostname);
                const sshHostName = resolveHostName(sshHostConfig['HostName'], sshDest.hostname);
                // Fork: a user/port written in the destination beats ssh_config, as in OpenSSH — see resolveUser(), resolveHopPort().
                const localUser = () => os.userInfo().username || '';
                const sshUser = resolveUser(sshDest.user, sshHostConfig['User'], localUser); // https://github.com/openssh/openssh-portable/blob/5ec5504f1d328d5bfa64280cd617c3efec4f78f3/sshconnect.c#L1561-L1562
                const sshPort = resolveHopPort(sshHostConfig['Port'], sshDest.port);

                this.sshAgentSock = sshHostConfig['IdentityAgent'] || process.env['SSH_AUTH_SOCK'] || (isWindows ? '\\\\.\\pipe\\openssh-ssh-agent' : undefined);
                this.sshAgentSock = this.sshAgentSock ? untildify(this.sshAgentSock) : undefined;
                const agentForward = enableAgentForwarding && (sshHostConfig['ForwardAgent'] || 'no').toLowerCase() === 'yes';
                const agent = agentForward && this.sshAgentSock ? new ssh2.OpenSSHAgent(this.sshAgentSock) : undefined;

                const preferredAuthentications = sshHostConfig['PreferredAuthentications'] ? sshHostConfig['PreferredAuthentications'].split(',').map(s => s.trim()) : ['publickey', 'password', 'keyboard-interactive'];

                const identityFiles: string[] = (sshHostConfig['IdentityFile'] as unknown as string[]) || [];
                const identitiesOnly = (sshHostConfig['IdentitiesOnly'] || 'no').toLowerCase() === 'yes';
                const identityKeys = await gatherIdentityFiles(identityFiles, this.sshAgentSock, identitiesOnly, this.logger);

                // Create proxy jump connections if any. `none` cancels an inherited
                // proxy and must not be treated as a host/command — see isProxyDisabled().
                // Fork: whichever of ProxyJump/ProxyCommand comes first wins — see chooseProxy().
                let proxyStream: ssh2.ClientChannel | stream.Duplex | undefined;
                const proxyChoice = chooseProxy(sshHostConfig);
                if (proxyChoice.kind === 'jump') {
                    const proxyJumps = proxyChoice.value.split(',').filter(i => !!i.trim())
                        .map(i => {
                            const proxy = SSHDestination.parse(i);
                            const proxyHostConfig = sshconfig.getHostConfiguration(proxy.hostname);
                            return [proxy, proxyHostConfig] as [SSHDestination, Record<string, string>];
                        });
                    for (let i = 0; i < proxyJumps.length; i++) {
                        const [proxy, proxyHostConfig] = proxyJumps[i];
                        // Fork: the hop's own user/host/port, never the destination's login — see resolveProxyJumpHop().
                        const { hostName: proxyHostName, user: proxyUser, port: proxyPort } = resolveProxyJumpHop(proxy, proxyHostConfig, localUser);

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
                            // Fork: notice a half-dead hop instead of waiting on it forever.
                            ...keepaliveConfig(proxyHostConfig['ServerAliveInterval'], proxyHostConfig['ServerAliveCountMax']),
                            strictVendor: false,
                            // Fork: ask for the host-key types already in known_hosts first.
                            ...await this.preferredHostKeyAlgorithms(proxyHostName, proxyPort, proxyHostConfig),
                            agentForward: proxyAgentForward,
                            agent: proxyAgent,
                            hostVerifier: this.buildHostVerifier(proxyHostName, proxyPort, proxyHostConfig),
                            authHandler: (arg0, arg1, arg2) => (proxyAuthHandler(arg0, arg1, arg2 as NextAuth), undefined)
                        });
                        this.proxyConnections.push(proxyConnection);

                        const nextProxyJump = i < proxyJumps.length - 1 ? proxyJumps[i + 1] : undefined;
                        const destIP = nextProxyJump ? resolveHostName(nextProxyJump[1]['HostName'], nextProxyJump[0].hostname) : sshHostName;
                        const destPort = nextProxyJump ? resolveHopPort(nextProxyJump[1]['Port'], nextProxyJump[0].port) : sshPort;
                        // Fork: bounded — an unanswered channel open on a dead hop hung the connect.
                        proxyStream = await openProxyJumpStream(proxyConnection, destIP, destPort, connectTimeout * 1000);
                    }
                } else if (proxyChoice.kind === 'command') {
                    // Fork: argv construction extracted (unsafe-token and cmd.exe injection guards) — see buildProxyCommandSpawn().
                    const { command: proxyCommand, args: proxyArgs, options } = buildProxyCommandSpawn(
                        proxyChoice.value,
                        { h: sshHostName, n: sshDest.hostname, p: sshPort.toString(), r: sshUser });

                    this.logger.trace(`Spawning ProxyCommand: ${redactedProxyCommandLine(proxyCommand, proxyArgs)}`);

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
                    // stdio is piped (spawn's default) but only stdout/stdin are wired
                    // up above; an unread stderr pipe fills at ~64KB and blocks the
                    // child forever. Drain it — at trace level, since it's third-party
                    // output — see drainProxyCommandStderr().
                    drainProxyCommandStderr(child.stderr, (line) => this.logger.trace(`ProxyCommand stderr: ${line}`));
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
                    // Fork: notice a half-dead link instead of waiting on it forever.
                    ...keepaliveConfig(sshHostConfig['ServerAliveInterval'], sshHostConfig['ServerAliveCountMax']),
                    strictVendor: false,
                    // Fork: ask for the host-key types already in known_hosts first.
                    ...await this.preferredHostKeyAlgorithms(sshHostName, sshPort, sshHostConfig),
                    agentForward,
                    agent,
                    hostVerifier: this.buildHostVerifier(sshHostName, sshPort, sshHostConfig),
                    authHandler: (arg0, arg1, arg2) => (sshAuthHandler(arg0, arg1, arg2 as NextAuth), undefined),
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

                this.remotePlatform = installResult.platform;
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

                // Update terminal env variables, but only where they actually changed.
                // A reconnect re-resolves the same socket path (it comes from the
                // already-running server), and re-writing it would mark every open terminal
                // stale — VS Code then offers to relaunch them, which for this fork's
                // tmux-backed terminals means discarding the session that survived the
                // reconnect in the first place. See `common/envCollection.ts`.
                const changedEnv = applyEnvCollection(
                    this.context.environmentVariableCollection,
                    this.appliedEnvVariables,
                    envVariables
                );
                if (changedEnv.length) {
                    this.logger.trace(`Terminal environment updated: ${changedEnv.join(', ')}`);
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
                // Fork: fire-and-forget — a context key never blocks resolving the authority.
                void vscode.commands.executeCommand('setContext', 'forwardedPortsViewEnabled', true);

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

                if (e instanceof ServerInstallError || e instanceof ProxyCommandRejectedError || !(e instanceof Error)) {
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
                    // Fork: `net.Server` ignores the listener's return value; the body
                    // catches every failure itself, so the promise is safe to drop.
                    .on('connection', (socket: net.Socket) => void (async () => {
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
                            // The SOCKS handshake failed, so this already-accepted client
                            // socket was never wired to anything — nothing else owns it. Left
                            // alone it stays open forever and the client just hangs. Destroy
                            // it, same as the equivalent path in `sshConnection.addTunnel`.
                            // Fork: one Info line — field logs show this only for a connection
                            // VS Code made on a link that had just died, which it recovers from.
                            this.logger.info(`SOCKS connection to 127.0.0.1:${remotePort} failed: ${error instanceof Error ? error.message : String(error)}`);
                            socket.destroy();
                        }
                    })())
                    .on('listening', () => resolve(server))
                    // Fork: loopback only (no host = every interface).
                    .listen(localPort, '127.0.0.1');
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
                    // Fork: fire-and-forget — closing a named tunnel never rejects, and
                    // `dispose` is synchronous by contract.
                    void this.sshConnection?.closeTunnel(tunnelConfig.name);
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
    private buildHostVerifier(
        host: string,
        port: number,
        // Fork: the known-hosts files and HostKeyAlias OpenSSH would use for this host.
        hostConfig: { UserKnownHostsFile?: string | string[]; GlobalKnownHostsFile?: string | string[]; HostKeyAlias?: string }
    ): ssh2.HostVerifier {
        const identity = knownHostsLookupName(host, port, hostConfig.HostKeyAlias);
        const files = knownHostsFiles(hostConfig.UserKnownHostsFile, hostConfig.GlobalKnownHostsFile);
        // We never set `hostHash`, so ssh2 hands us the raw wire-format host-key Buffer.
        // known_hosts stores that blob base64-encoded, which is what verifyKnownHost
        // compares against.
        return (key, callback) => {
            void verifyKnownHost({
                host: identity,
                key,
                promptForUnknownHost: (id, fingerprint) => this.promptNewHostKey(id, fingerprint),
            }, files).then(
                ({ verdict, verified }) => {
                    // A refusal is otherwise silent — ssh2 just fails the connect and the
                    // user sees "Could not establish connection" with no reason. Each
                    // refusing verdict gets its own wording; see hostKeyRejectionNotice().
                    const notice = hostKeyRejectionNotice(verdict, identity);
                    if (notice) {
                        this.logger.error(notice.logMessage);
                        void vscode.window.showErrorMessage(notice.message, { modal: true });
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
     * Fork: the host-key algorithm order for a target, from the key types its
     * known-hosts files (the same ones {@link buildHostVerifier} reads) hold for it.
     */
    private async preferredHostKeyAlgorithms(
        host: string,
        port: number,
        hostConfig: { UserKnownHostsFile?: string | string[]; GlobalKnownHostsFile?: string | string[]; HostKeyAlias?: string }
    ): Promise<Pick<ssh2.ConnectConfig, 'algorithms'>> {
        const identity = knownHostsLookupName(host, port, hostConfig.HostKeyAlias);
        const files = knownHostsFiles(hostConfig.UserKnownHostsFile, hostConfig.GlobalKnownHostsFile);
        return hostKeyAlgorithms(await readKnownHostKeyTypes(identity, files));
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
        return async (methodsLeft: string[] | null, _partialSuccess: boolean | null, callback: NextAuth) => {
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
                                override getIdentities(callback: ssh2.IdentityCallback<ParsedKey>): void {
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
                        return callback(null);
                    }

                    const keyBuffer = await fs.promises.readFile(identityKey.filename);
                    let result = ssh2.utils.parseKey(keyBuffer); // First try without passphrase
                    // Fork: every encrypted format (OpenSSH, legacy PEM, PPK) — see isPassphraseRequired().
                    if (isPassphraseRequired(result)) {
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
                        return callback(null);
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
                        prompt: (_name, _instructions, _instructionsLang, prompts, finish) => void (async () => {
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
                        })()
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
        // Same release step a retry performs, so the two can't drift apart.
        this.teardownPreviousAttempt();
        this.labelFormatterDisposable?.dispose();
    }
}
