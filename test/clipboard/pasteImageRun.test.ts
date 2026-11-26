import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('child_process', () => ({ execFile: vi.fn() }));

import { execFile } from 'child_process';
import {
    decideCapturePlan,
    ImageTooLargeError,
    runCaptureCandidate,
    uploadWithDeadline,
    UPLOAD_DEADLINE_MS,
} from '../../src/clipboard/pasteImage';
import { MAX_IMAGE_BYTES } from '../../src/clipboard/clipboardWebview';

type ExecCallback = (error: (Error & { code?: string }) | null, stdout: Buffer) => void;

/** Make the next `execFile` call finish with the given error and (possibly truncated) stdout. */
const execFinishes = (error: (Error & { code?: string }) | null, stdout: Buffer): void => {
    vi.mocked(execFile).mockImplementationOnce(((...args: unknown[]) => {
        (args[args.length - 1] as ExecCallback)(error, stdout);
    }) as unknown as typeof execFile);
};

const stdoutCandidate = { output: 'stdout' as const, argv: ['wl-paste'] };

describe('runCaptureCandidate: an oversized stdout image is "too large", not "no image"', () => {
    afterEach(() => vi.mocked(execFile).mockReset());

    // node kills the child and reports ERR_CHILD_PROCESS_STDIO_MAXBUFFER once stdout passes
    // maxBuffer. That used to read as "tool missing / no image", so a 25 MB screenshot fell
    // through to the next reader and finally to a text paste with no explanation.
    it('rejects with ImageTooLargeError when stdout overflows maxBuffer', async () => {
        const err = Object.assign(new Error('maxBuffer length exceeded'), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' });
        execFinishes(err, Buffer.alloc(16));
        await expect(runCaptureCandidate(stdoutCandidate, '/tmp/x.png')).rejects.toBeInstanceOf(ImageTooLargeError);
    });

    it('still treats an ordinary failure as a plain rejection', async () => {
        execFinishes(Object.assign(new Error('spawn wl-paste ENOENT'), { code: 'ENOENT' }), Buffer.alloc(0));
        const result = runCaptureCandidate(stdoutCandidate, '/tmp/x.png');
        await expect(result).rejects.toThrow('ENOENT');
        await expect(result).rejects.not.toBeInstanceOf(ImageTooLargeError);
    });

    it('lets the too-large error stop the fallback chain instead of being skipped', async () => {
        const second = vi.fn(async () => new Uint8Array([1]));
        const attempts = [
            { label: 'a', run: async (): Promise<Uint8Array | undefined> => { throw new ImageTooLargeError(MAX_IMAGE_BYTES); } },
            { label: 'b', run: second },
        ];
        await expect(decideCapturePlan(attempts)).rejects.toBeInstanceOf(ImageTooLargeError);
        expect(second).not.toHaveBeenCalled();
    });
});

describe('uploadWithDeadline: a stalled remote write cannot hang the paste', () => {
    afterEach(() => vi.useRealTimers());

    it('uses a 60 s deadline: 20 MB at roughly 340 KB/s still completes', () => {
        expect(UPLOAD_DEADLINE_MS).toBe(60_000);
    });

    it('rejects when the write never settles', async () => {
        vi.useFakeTimers();
        const result = uploadWithDeadline(() => new Promise<void>(() => { /* never */ }), 1000);
        const assertion = expect(result).rejects.toThrow(/did not finish within 1000ms/);
        await vi.advanceTimersByTimeAsync(1000);
        await assertion;
    });

    it('resolves when the write finishes in time', async () => {
        await expect(uploadWithDeadline(async () => undefined, 1000)).resolves.toBeUndefined();
    });
});
