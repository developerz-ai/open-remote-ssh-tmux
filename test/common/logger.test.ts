import { describe, expect, it, afterEach, vi } from 'vitest';
import { env } from '../mocks/vscode';
import Log from '../../src/common/logger';

// `now()` is private but its only observable effect is the timestamp prefix
// written into the output channel line — assert through `logLevel`/`info`
// rather than reaching into the private field.
function linesOf(log: Log): string[] {
    return (log as unknown as { output: { lines: string[] } }).output.lines;
}

describe('Log timestamp formatting', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('formats the time using UTC getters, independent of the host timezone offset', () => {
        // A host in +5:30 (e.g. IST) previously corrupted this: `now()` mixed
        // `getUTCHours()` with local `getMinutes()`/`getUTCSeconds()`, so a local
        // offset shifted the minutes field away from the UTC hours/seconds.
        process.env.TZ = 'Asia/Kolkata';
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-07-24T23:59:59.007Z'));

        const log = new Log('test');
        log.info('hello');

        const [line] = linesOf(log);
        expect(line).toContain('23:59:59.007');
    });

    it('pads milliseconds to 3 digits', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-01-01T00:00:00.007Z'));

        const log = new Log('test');
        log.info('hello');

        const [line] = linesOf(log);
        expect(line).toContain('00:00:00.007');
        expect(line).not.toContain('00:00:00.7]');
    });
});

// `trace` used to append unconditionally, so every connect dumped the full install
// script into the default-visible channel. It now follows VS Code's log level
// (`env.logLevel`, 1.74+; `Trace` = 1): trace lines only when the user asked for them.
describe('Log.trace level gating', () => {
    const mutableEnv = env as { logLevel?: number };

    afterEach(() => {
        delete mutableEnv.logLevel;
    });

    it('suppresses trace above the Trace level', () => {
        mutableEnv.logLevel = 3; // Info
        const log = new Log('test');
        log.trace('hidden');
        log.info('shown');

        expect(linesOf(log)).toHaveLength(1);
        expect(linesOf(log)[0]).toContain('shown');
    });

    it('emits trace at the Trace level', () => {
        mutableEnv.logLevel = 1; // Trace
        const log = new Log('test');
        log.trace('visible', 'data');

        expect(linesOf(log)).toHaveLength(2);
    });

    it('emits trace on a host without env.logLevel (pre-1.74), as before', () => {
        const log = new Log('test');
        log.trace('visible');

        expect(linesOf(log)).toHaveLength(1);
    });
});
