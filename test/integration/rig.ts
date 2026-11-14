import * as fs from 'node:fs';
import { Client, ClientChannel } from 'ssh2';
import { describe } from 'vitest';
import SSHConnection from '../../src/ssh/sshConnection';
import { escapeShellArg } from '../../src/common/shellQuote';
import { createRemoteExec, RawExec, RemoteExec } from '../../src/tmux/remoteExec';

// Shared plumbing for the real-tmux integration tests (`*.itest.ts`). `test/rig/run.sh`
// starts one sshd + tmux container per matrix version and exports:
//   RIG_TARGETS  `<version>=<host>:<port>,…` (ports are docker-chosen, 127.0.0.1 only)
//   RIG_KEY      path to the run's throwaway ed25519 private key
// Without them (a plain `vitest run --project integration`) every rig suite is skipped
// rather than failed: only run.sh knows how to stand the remote up.

/** One running rig container. */
export interface RigTarget {
    /** tmux release under test, e.g. `3.4`. */
    readonly version: string;
    readonly host: string;
    readonly port: number;
}

/** Deadline per tmux round-trip — mirrors `TMUX_EXEC_DEADLINE_MS` (src/extension.ts),
 * which is not imported because that module drags in the whole extension. */
const TMUX_EXEC_DEADLINE_MS = 8000;

/** A test-side command result WITH the exit status, for assertions about the remote. */
export interface RunResult {
    readonly stdout: string;
    readonly stderr: string;
    readonly code: number;
}

/** tmux as installed in every rig image (`make install` under `/usr/local`) — what
 * `probeTmux` resolves, and the `shellPath` production would launch. */
export const RIG_TMUX = '/usr/local/bin/tmux';

/** One login user per shell (Dockerfile), for tests whose subject is shell-sensitivity. */
export const SHELL_USERS = ['u-bash', 'u-zsh', 'u-fish', 'u-dash', 'u-tcsh'] as const;

/** One bash worker user per itest file. tmux sockets are per uid, so each file owns a
 * private tmux server and files can run in parallel without seeing each other's sessions.
 * Kept in one table so two files can never silently share a server. */
export const WORKERS = {
    attachOrCreate: 'w1',
    listParse: 'w2',
    reaper: 'w3',
    handoff: 'w4',
    hardening: 'w5',
    deadlines: 'w6',
} as const;

/** Parse `RIG_TARGETS`; empty when the rig is not up. */
export function rigTargets(): RigTarget[] {
    const raw = process.env.RIG_TARGETS ?? '';
    return raw.split(',').filter(entry => entry !== '').map(entry => {
        const match = /^([^=]+)=(.+):(\d+)$/.exec(entry);
        if (!match) {
            throw new Error(`malformed RIG_TARGETS entry: ${entry}`);
        }
        return { version: match[1], host: match[2], port: Number(match[3]) };
    });
}

/** `version >= floor`, comparing `major.minor` only (a letter suffix is a patch release). */
export function versionAtLeast(version: string, floor: string): boolean {
    const parse = (value: string): [number, number] => {
        const match = /^(\d+)\.(\d+)/.exec(value);
        if (!match) {
            throw new Error(`unparseable tmux version: ${value}`);
        }
        return [Number(match[1]), Number(match[2])];
    };
    const [major, minor] = parse(version);
    const [floorMajor, floorMinor] = parse(floor);
    return major !== floorMajor ? major > floorMajor : minor >= floorMinor;
}

/** `describe` one suite per rig version (`tmux 3.4 › …`), skipped when the rig is down. */
export function describeRig(title: string, body: (target: RigTarget) => void): void {
    const targets = rigTargets();
    describe.skipIf(targets.length === 0)(title, () => {
        for (const target of targets) {
            describe(`tmux ${target.version}`, () => body(target));
        }
    });
}

function privateKey(): Buffer {
    const keyPath = process.env.RIG_KEY;
    if (!keyPath) {
        throw new Error('RIG_KEY is not set; run the rig through test/rig/run.sh');
    }
    return fs.readFileSync(keyPath);
}

/**
 * A production `SSHConnection` to the rig as `user`, exposed as the two runners production
 * builds over it, plus a test-side `run` that reports the exit status.
 */
export class RigSession {
    /** `lazyExec`'s shape (src/extension.ts): `SSHConnection#exec` — stdout + stderr, no
     * exit code, no deadline. What `probeTmux` is handed. */
    readonly rawExec: RawExec;
    /** `tmuxExec`'s shape (src/extension.ts): the raw exec behind the exit-code marker and
     * the per-call deadline. What the terminal provider and the reaper are handed. */
    readonly exec: RemoteExec;

    private constructor(private readonly connection: SSHConnection) {
        this.rawExec = (command: string) => this.connection.exec(command);
        this.exec = createRemoteExec(this.rawExec, TMUX_EXEC_DEADLINE_MS);
    }

    static async open(target: RigTarget, user: string): Promise<RigSession> {
        const connection = new SSHConnection({
            host: target.host,
            port: target.port,
            username: user,
            privateKey: privateKey(),
            readyTimeout: 20_000,
        });
        await connection.connect();
        return new RigSession(connection);
    }

    /** Run `script` under POSIX sh (whatever the login shell) and capture its status. The
     * script travels base64-encoded so no login shell (tcsh rejects a newline inside
     * quotes; fish quotes differently) ever parses a byte of it. */
    async run(script: string): Promise<RunResult> {
        const encoded = Buffer.from(`${script}\necho "__rc=$?"\n`, 'utf8').toString('base64');
        const { stdout, stderr } = await this.rawExec(`echo ${encoded} | base64 -d | sh`);
        const match = /__rc=(\d+)\s*$/.exec(stdout);
        if (!match) {
            throw new Error(`no exit status from remote; stdout=${JSON.stringify(stdout)} stderr=${JSON.stringify(stderr)}`);
        }
        return { stdout: stdout.slice(0, match.index), stderr, code: Number(match[1]) };
    }

    /** `run`, but throw unless it exited 0. Returns trimmed stdout. */
    async ok(script: string): Promise<string> {
        const result = await this.run(script);
        if (result.code !== 0) {
            throw new Error(`remote command failed (${result.code}): ${script}\n${result.stderr}`);
        }
        return result.stdout.trim();
    }

    /** `tmux <args>` with each argument quoted; exit status included. */
    tmux(...args: string[]): Promise<RunResult> {
        return this.run([RIG_TMUX, ...args].map(escapeShellArg).join(' '));
    }

    /** Fresh tmux state for this user: no server, no stray clients or holders. */
    async resetTmux(): Promise<void> {
        await this.run(`${RIG_TMUX} kill-server 2>/dev/null; pkill -KILL -u "$(id -u)" -x script; pkill -KILL -u "$(id -u)" -x sleep; true`);
    }

    /** Session names on this user's server (empty when no server runs). */
    async sessionNames(): Promise<string[]> {
        const { stdout } = await this.tmux('list-sessions', '-F', '#{session_name}');
        return stdout.split('\n').map(line => line.trim()).filter(line => line !== '');
    }

    /** Client count on an exact session (`=name`). */
    async clientCount(name: string): Promise<number> {
        const { stdout } = await this.tmux('list-clients', '-t', `=${name}`, '-F', '#{client_pid}');
        return stdout.split('\n').filter(line => line.trim() !== '').length;
    }

    /** pids of the tmux clients attached to an exact session (`=name`). */
    async clientPids(name: string): Promise<number[]> {
        const { stdout } = await this.tmux('list-clients', '-t', `=${name}`, '-F', '#{client_pid}');
        return stdout.split('\n').filter(line => line.trim() !== '').map(Number);
    }

    /** Whether the tmux client a held holder spawned is still attached to `name`. */
    async heldClientAttached(holderPid: number, name: string): Promise<boolean> {
        const client = Number((await this.run(`pgrep -P ${holderPid}`)).stdout.trim());
        return client > 0 && (await this.clientPids(name)).includes(client);
    }

    /** Poll `probe` until it returns true, or fail after `timeoutMs`. */
    async waitUntil(what: string, probe: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            if (await probe()) {
                return;
            }
            await sleep(100);
        }
        throw new Error(`timed out after ${timeoutMs}ms waiting for: ${what}`);
    }

    /**
     * Start a tmux client that outlives this test's connection — the model of a VS Code
     * terminal. VS Code's pty host lives in the remote vscode-server, not in the window:
     * when the window closes, crashes or is SIGKILLed, the pty (and the tmux client in it)
     * stays alive for the reconnection grace (3 h by default). `script` holds the pty, its
     * stdin is a FIFO kept open by a sleeper so it never sees EOF, and `setsid` detaches
     * it from the ssh session. Returns the holder's pid; `closeHeldClient` is the clean
     * close (the pty host disposing the terminal: SIGHUP to the client).
     */
    async spawnHeldClient(shellPath: string, shellArgs: readonly string[]): Promise<number> {
        const command = `exec ${[shellPath, ...shellArgs].map(escapeShellArg).join(' ')}`;
        const pid = await this.ok([
            'd=$(mktemp -d)',
            'mkfifo "$d/in"',
            'sleep 86400 < /dev/null > "$d/in" 2>/dev/null &',
            `TERM=xterm-256color setsid script -qfc ${escapeShellArg(command)} /dev/null < "$d/in" > /dev/null 2>&1 &`,
            'echo $!',
        ].join('\n'));
        return Number(pid);
    }

    /** Clean close of a held client: what the pty host does when a terminal is disposed —
     * SIGHUP to the process it spawned (the tmux client, the holder's child), which makes
     * tmux detach it. The holder then exits with its child. */
    async closeHeldClient(pid: number): Promise<void> {
        await this.run(`pkill -HUP -P ${pid}; true`);
    }

    /** Close the ssh connection cleanly. */
    async close(): Promise<void> {
        await this.connection.close();
    }
}

/**
 * An interactive tmux client on a real remote pty over its own ssh2 connection — for
 * tests that type into the terminal and read what comes back (key bytes, Esc latency).
 * The pty dies with the connection, unlike `RigSession#spawnHeldClient`.
 */
export class PtyClient {
    private output = '';

    private constructor(private readonly client: Client, private readonly channel: ClientChannel) {
        channel.on('data', (data: Buffer) => {
            this.output += data.toString('utf8');
        });
    }

    static open(target: RigTarget, user: string, shellPath: string, shellArgs: readonly string[]): Promise<PtyClient> {
        const command = `exec ${[shellPath, ...shellArgs].map(escapeShellArg).join(' ')}`;
        return new Promise((resolve, reject) => {
            const client = new Client();
            client.on('error', reject);
            client.on('ready', () => {
                client.exec(command, { pty: { term: 'xterm-256color', rows: 24, cols: 80 } }, (err, channel) => {
                    if (err) {
                        client.end();
                        reject(err);
                        return;
                    }
                    resolve(new PtyClient(client, channel));
                });
            });
            client.connect({ host: target.host, port: target.port, username: user, privateKey: privateKey(), readyTimeout: 20_000 });
        });
    }

    /** Everything the terminal has printed so far. */
    get text(): string {
        return this.output;
    }

    write(data: string): void {
        this.channel.write(data);
    }

    /** Wait until the terminal output matches `pattern`; resolves with the time it took. */
    async waitFor(pattern: RegExp, timeoutMs = 10_000): Promise<number> {
        const started = Date.now();
        while (Date.now() - started < timeoutMs) {
            if (pattern.test(this.output)) {
                return Date.now() - started;
            }
            await sleep(5);
        }
        throw new Error(`timed out after ${timeoutMs}ms waiting for ${pattern}; got ${JSON.stringify(this.output.slice(-400))}`);
    }

    close(): void {
        this.client.end();
    }
}

export function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}
