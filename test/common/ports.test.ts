import * as net from 'net';
import { describe, expect, it } from 'vitest';
import { findFreePort, findFreePortFaster, findRandomPort } from '../../src/common/ports';

// Characterisation tests for the port-pick helpers. These do real socket I/O on
// 127.0.0.1 (no mocking net) since the whole point of the module is OS port
// allocation — a pure-logic stub would test nothing meaningful.
describe('findRandomPort', () => {
    it('resolves a port number the OS assigns', async () => {
        const port = await findRandomPort();
        expect(port).toBeGreaterThan(0);
        expect(port).toBeLessThan(65536);
    });

    it('resolves a different port on each call (OS-assigned, not fixed)', async () => {
        const a = await findRandomPort();
        const b = await findRandomPort();
        expect(a).not.toBe(b);
    });
});

describe('findFreePort', () => {
    it('returns the start port when it is free', async () => {
        const startPort = await findRandomPort();
        const port = await findFreePort(startPort, 5, 2000);
        expect(port).toBe(startPort);
    });

    it('steps past a port that is already listening', async () => {
        const startPort = await findRandomPort();
        const server = net.createServer();
        await new Promise<void>(resolve => server.listen(startPort, '127.0.0.1', resolve));
        try {
            const port = await findFreePort(startPort, 5, 2000);
            expect(port).not.toBe(startPort);
            expect(port).toBeGreaterThan(0);
        } finally {
            await new Promise<void>(resolve => server.close(() => resolve()));
        }
    });

    it('returns 0 when giveUpAfter is 0', async () => {
        const port = await findFreePort(12345, 0, 2000);
        expect(port).toBe(0);
    });
});

describe('findFreePortFaster', () => {
    it('returns the start port when it is free', async () => {
        const startPort = await findRandomPort();
        const port = await findFreePortFaster(startPort, 5, 2000);
        expect(port).toBe(startPort);
    });

    it('steps past a port that is already bound', async () => {
        const startPort = await findRandomPort();
        const server = net.createServer();
        await new Promise<void>(resolve => server.listen(startPort, '127.0.0.1', resolve));
        try {
            const port = await findFreePortFaster(startPort, 5, 2000);
            expect(port).not.toBe(0);
            expect(port).not.toBe(startPort);
        } finally {
            await new Promise<void>(resolve => server.close(() => resolve()));
        }
    });
});
