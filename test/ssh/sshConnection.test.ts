import { beforeEach, describe, expect, it, vi } from 'vitest';

// A minimal stand-in for ssh2's `Client` — an EventEmitter whose `connect`/`end`
// are no-op spies instead of real network I/O, so these tests can drive the
// 'ready'/'error'/'close' lifecycle explicitly and assert how many *real*
// connection attempts (`new Client()`) `SSHConnection` made. Defined inside
// `vi.hoisted` so both the `vi.mock('ssh2', ...)` factory (which vitest hoists
// above this file's imports) and the test bodies below can share `fakeClients`.
const { fakeClients, Client } = vi.hoisted(() => {
    class MiniEmitter {
        private listeners: Record<string, Array<(...args: unknown[]) => void>> = {};

        on(event: string, cb: (...args: unknown[]) => void): this {
            if (!this.listeners[event]) {
                this.listeners[event] = [];
            }
            this.listeners[event].push(cb);
            return this;
        }

        emit(event: string, ...args: unknown[]): void {
            for (const cb of this.listeners[event] ?? []) {
                cb(...args);
            }
        }
    }

    // A fake `exec()` channel: just enough of ssh2's `ClientChannel` for
    // `SSHConnection.exec`/`execPartial` to attach `'close'`/`'data'` handlers
    // (on the stream and its `.stderr`) and for a test to drive them.
    class FakeExecStream extends MiniEmitter {
        stderr = new MiniEmitter();
    }

    class FakeClient extends MiniEmitter {
        connectCalls = 0;
        execCalls: string[] = [];
        execStreams: FakeExecStream[] = [];

        connect(): this {
            this.connectCalls++;
            return this;
        }

        end(): void {
            // Real ssh2 tears the socket down and later emits 'close' itself;
            // tests drive 'error'/'close' explicitly to control timing.
        }

        exec(cmd: string, optionsOrCallback: unknown, maybeCallback?: unknown): this {
            const callback = (typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback) as
                (err: Error | undefined, stream: FakeExecStream) => void;
            this.execCalls.push(cmd);
            const stream = new FakeExecStream();
            this.execStreams.push(stream);
            callback(undefined, stream);
            return this;
        }
    }

    const fakeClients: FakeClient[] = [];

    class Client extends FakeClient {
        constructor() {
            super();
            fakeClients.push(this);
        }
    }

    return { fakeClients, Client };
});

vi.mock('ssh2', () => ({ Client }));

const { default: SSHConnection } = await import('../../src/ssh/sshConnection');

beforeEach(() => {
    fakeClients.length = 0;
});

// `connect()` incremented `__retries` on *every* call, including calls that
// just returned the already-pending/settled `__$connectPromise` — e.g. every
// `shell()`/`exec()`/tunnel handler calls `this.connect()` whenever it needs
// the connection. That inflated the counter with zero real connection
// attempts, so the auto-reconnect gate in the 'close' handler
// (`__retries <= reconnectTries`) could already be exhausted the first time a
// connection actually failed. See `src/ssh/sshConnection.ts` `connect()`.
describe('connect(): retry counting reflects real connection attempts only', () => {
    it('does not inflate the retry count on calls that just return the pending connect promise', async () => {
        const conn = new SSHConnection({ host: 'h', username: 'u', reconnect: true, reconnectTries: 2, reconnectDelay: 1 });

        const first = conn.connect();
        // Extra calls while the first attempt is still pending — harmless
        // re-entrant calls, not additional connection attempts.
        conn.connect();
        conn.connect();

        expect(fakeClients).toHaveLength(1);

        // The one real attempt fails.
        const err = Object.assign(new Error('boom'), { level: 'unknown' });
        fakeClients[0].emit('error', err);
        fakeClients[0].emit('close');

        // reconnectTries is 2: a single real attempt must still leave room for a
        // retry — if the counter were inflated by the two re-entrant calls above,
        // the gate would already read 3 > 2 and give up without retrying.
        await vi.waitFor(() => expect(fakeClients).toHaveLength(2), { timeout: 1000 });

        fakeClients[1].emit('ready');
        await expect(first).resolves.toBe(conn);
    });

    it('still counts each real failed attempt so reconnectTries is eventually honoured', async () => {
        const conn = new SSHConnection({ host: 'h', username: 'u', reconnect: true, reconnectTries: 1, reconnectDelay: 1 });

        const first = conn.connect();
        const err = Object.assign(new Error('boom'), { level: 'unknown' });

        fakeClients[0].emit('error', err);
        fakeClients[0].emit('close');
        await vi.waitFor(() => expect(fakeClients).toHaveLength(2), { timeout: 1000 });

        // Second real attempt also fails — reconnectTries (1) is now exhausted.
        fakeClients[1].emit('error', err);
        fakeClients[1].emit('close');

        await expect(first).rejects.toBe(err);
        expect(fakeClients).toHaveLength(2);
    });
});

// `close()` ended the underlying client but never reset `__$connectPromise` /
// `sshConnection`, so a later `connect()` saw the stale cached (already
// resolved, already-ended) promise and returned it instead of actually
// reconnecting. See `src/ssh/sshConnection.ts` `close()`.
describe('close(): resets connect state so a later connect() reconnects for real', () => {
    it('creates a fresh underlying client on connect() after close()', async () => {
        const conn = new SSHConnection({ host: 'h', username: 'u' });

        const first = conn.connect();
        fakeClients[0].emit('ready');
        await first;

        await conn.close();

        const second = conn.connect();
        expect(fakeClients).toHaveLength(2); // a real new attempt, not the stale closed one

        fakeClients[1].emit('ready');
        await expect(second).resolves.toBe(conn);
    });
});

// `exec`/`execPartial` joined `params` into the command line with a bare
// space (`cmd += ' ' + params.join(' ')`) — a param containing `;`, `$( )`,
// backticks, or a space was not a single argument on the remote, it was
// additional shell syntax. E.g. `exec('echo', ['a; rm -rf /'])` ran `rm -rf /`
// as a second command instead of printing the literal string. Every param
// must be quoted (`escapeShellArg`, shared with `src/tmux/tmuxSession.ts` via
// `src/common/shellQuote.ts`) so it lands as exactly one remote token.
describe('exec()/execPartial(): shell-quote params so each lands as one remote token', () => {
    async function connectedFakeClient() {
        const conn = new SSHConnection({ host: 'h', username: 'u' });
        const connectPromise = conn.connect();
        fakeClients[0].emit('ready');
        await connectPromise;
        return { conn, client: fakeClients[0] };
    }

    it('quotes each exec() param individually', async () => {
        const { conn, client } = await connectedFakeClient();

        const result = conn.exec('echo', ['a; rm -rf /', '$(id)', '`id`', 'a b', 'a\'b']);
        await vi.waitFor(() => expect(client.execStreams).toHaveLength(1));
        client.execStreams[0].emit('close');
        await result;

        expect(client.execCalls).toEqual([
            `echo 'a; rm -rf /' '$(id)' '\`id\`' 'a b' 'a'\\''b'`
        ]);
    });

    it('quotes each execPartial() param individually', async () => {
        const { conn, client } = await connectedFakeClient();

        const result = conn.execPartial('echo', () => true, ['a; rm -rf /', '$(id)']);
        await vi.waitFor(() => expect(client.execStreams).toHaveLength(1));
        client.execStreams[0].emit('close');
        await result;

        expect(client.execCalls).toEqual([`echo 'a; rm -rf /' '$(id)'`]);
    });

    it('leaves a command with no params untouched', async () => {
        const { conn, client } = await connectedFakeClient();

        const result = conn.exec('uname -s');
        await vi.waitFor(() => expect(client.execStreams).toHaveLength(1));
        client.execStreams[0].emit('close');
        await result;

        expect(client.execCalls).toEqual(['uname -s']);
    });
});
