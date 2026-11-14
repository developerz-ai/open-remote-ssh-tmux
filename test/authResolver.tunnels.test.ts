import * as net from 'net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import Log from '../src/common/logger';
import { DeadlineError } from '../src/common/deadline';
import { findRandomPort } from '../src/common/ports';
import { openProxyJumpStream, RemoteSSHResolver } from '../src/authResolver';

type OpenTunnel = { openTunnel(localPort: number, remote: number | string): Promise<vscode.Disposable & { localPort: number }> };

function lines(log: Log): string[] {
    return (log as unknown as { output: { lines: string[] } }).output.lines;
}

// The SOCKS forwarding server VS Code connects through listened on every interface.
describe('RemoteSSHResolver forwarding server', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    async function forwardingServer(log: Log) {
        const resolver = new RemoteSSHResolver({} as vscode.ExtensionContext, log);
        // A SOCKS port nothing listens on: every SOCKS handshake fails at once.
        (resolver as unknown as { socksTunnel: { localPort: number } }).socksTunnel = { localPort: await findRandomPort() };
        const listen = vi.spyOn(net.Server.prototype, 'listen');
        const tunnel = await (resolver as unknown as OpenTunnel).openTunnel(0, 4321);
        // The last listen: `openTunnel` first picks its port with a throwaway server.
        const server = listen.mock.contexts.at(-1) as net.Server;
        return { tunnel, server };
    }

    it('binds 127.0.0.1 only', async () => {
        const { tunnel, server } = await forwardingServer(new Log('test'));
        try {
            expect((server.address() as net.AddressInfo).address).toBe('127.0.0.1');
        } finally {
            tunnel.dispose();
        }
    });

    // Field logs: "Error while creating SOCKS connection … Proxy connection timed out"
    // with a full stack, once per stale connection after a dropped link. It is a
    // per-connection event VS Code recovers from; log one Info line naming the target.
    it('logs a failed SOCKS connection as one Info line with its destination', async () => {
        const log = new Log('test');
        const { tunnel } = await forwardingServer(log);
        try {
            const socket = net.connect(tunnel.localPort, '127.0.0.1');
            socket.on('error', () => { /* destroyed by the server */ });
            await new Promise<void>((resolve) => socket.on('close', () => resolve()));
            await vi.waitFor(() => expect(lines(log).some(l => l.includes('SOCKS'))).toBe(true));

            const socksLines = lines(log).filter(l => l.includes('SOCKS'));
            expect(socksLines).toHaveLength(1);
            expect(socksLines[0]).toMatch(/^\[Info/);
            expect(socksLines[0]).toContain('127.0.0.1:4321');
            expect(lines(log).some(l => l.startsWith('[Error') || l.includes('    at '))).toBe(false);
        } finally {
            tunnel.dispose();
        }
    });
});

// The ProxyJump channel open (`forwardOut`) had no bound: on a half-dead hop the
// connect hung until VS Code gave up on the whole window.
describe('openProxyJumpStream', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('returns the hop channel', async () => {
        const hop = { connect: async () => undefined, forwardOut: vi.fn(async () => 'stream') };

        await expect(openProxyJumpStream(hop, 'next', 2222, 1000)).resolves.toBe('stream');
        expect(hop.forwardOut).toHaveBeenCalledWith('127.0.0.1', 0, 'next', 2222);
    });

    it('gives up when the hop never answers the channel open', async () => {
        vi.useFakeTimers();
        const hop = { connect: async () => undefined, forwardOut: () => new Promise<never>(() => { /* dead hop */ }) };

        const result = openProxyJumpStream(hop, 'next', 22, 1000);
        const assertion = expect(result).rejects.toBeInstanceOf(DeadlineError);
        await vi.advanceTimersByTimeAsync(1000);

        await assertion;
    });
});
