import { describe, expect, it, afterEach, vi } from 'vitest';
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
