import { describe, expect, it } from 'vitest';
import { findRandomPort } from '../../src/common/ports';

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
