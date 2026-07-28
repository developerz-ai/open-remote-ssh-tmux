import { describe, expect, it } from 'vitest';
import { PassThrough } from 'stream';
import { drainProxyCommandStderr } from '../src/authResolver';

/** Let the stream's 'data'/'end' events be delivered before asserting. */
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

// `cp.spawn` pipes all three stdio streams by default, but the ProxyCommand code
// only ever consumed `stdout`/`stdin` (via `Duplex.from`). Nothing read
// `child.stderr`, so once the proxy had written ~64KB (the pipe buffer) to it the
// child blocked on write *forever* — the connect then hung until `readyTimeout`
// with nothing in the log to explain it. Verbose proxies (`ssh -v -W`,
// `cloudflared`) reach that threshold routinely, and below it every diagnostic the
// proxy emitted was discarded anyway. Draining it into the log fixes both.
describe('drainProxyCommandStderr', () => {
    it('forwards each complete line to the log', async () => {
        const stderr = new PassThrough();
        const lines: string[] = [];
        drainProxyCommandStderr(stderr, (line) => lines.push(line));
        stderr.write('debug1: connecting\ndebug1: authenticated\n');
        await flush();
        expect(lines).toEqual(['debug1: connecting', 'debug1: authenticated']);
    });

    it('reassembles a line split across chunk boundaries', async () => {
        const stderr = new PassThrough();
        const lines: string[] = [];
        drainProxyCommandStderr(stderr, (line) => lines.push(line));
        stderr.write('debug1: con');
        await flush();
        expect(lines).toEqual([]);
        stderr.write('necting\n');
        await flush();
        expect(lines).toEqual(['debug1: connecting']);
    });

    it('flushes a trailing unterminated line when the child exits', async () => {
        const stderr = new PassThrough();
        const lines: string[] = [];
        drainProxyCommandStderr(stderr, (line) => lines.push(line));
        stderr.end('no trailing newline');
        await flush();
        expect(lines).toEqual(['no trailing newline']);
    });

    it('strips CR so a Windows proxy does not log a stray carriage return', async () => {
        const stderr = new PassThrough();
        const lines: string[] = [];
        drainProxyCommandStderr(stderr, (line) => lines.push(line));
        stderr.write('winline\r\n');
        await flush();
        expect(lines).toEqual(['winline']);
    });

    it('drops blank lines rather than filling the log with them', async () => {
        const stderr = new PassThrough();
        const lines: string[] = [];
        drainProxyCommandStderr(stderr, (line) => lines.push(line));
        stderr.write('\n   \nreal\n');
        await flush();
        expect(lines).toEqual(['real']);
    });

    // The point of draining is that the pipe never fills; a proxy that emits a huge
    // *unterminated* blob (a binary banner, a stack trace with no newline) must not
    // just move the unbounded growth from the pipe into our buffer.
    it('flushes an over-long unterminated run instead of buffering it without limit', async () => {
        const stderr = new PassThrough();
        const lines: string[] = [];
        drainProxyCommandStderr(stderr, (line) => lines.push(line));
        stderr.write('x'.repeat(9000));
        await flush();
        expect(lines).toHaveLength(1);
        expect(lines[0].length).toBeLessThanOrEqual(8192);
    });

    it('consumes the stream even when the log callback throws', async () => {
        const stderr = new PassThrough();
        drainProxyCommandStderr(stderr, () => { throw new Error('logger boom'); });
        expect(() => { stderr.write('boom\n'); }).not.toThrow();
        await flush();
        // Consumed, so the child is never blocked on a full pipe.
        expect(stderr.readableLength).toBe(0);
    });

    it('swallows a stream error rather than crashing the extension host', async () => {
        const stderr = new PassThrough();
        const lines: string[] = [];
        drainProxyCommandStderr(stderr, (line) => lines.push(line));
        expect(() => stderr.emit('error', new Error('EPIPE'))).not.toThrow();
        await flush();
    });

    it('tolerates a missing stderr (stdio was not piped)', () => {
        expect(() => drainProxyCommandStderr(null, () => {})).not.toThrow();
    });
});
