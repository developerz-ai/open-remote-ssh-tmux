import { describe, expect, it, vi } from 'vitest';
import { captureAttempts, decideCapturePlan, type CaptureAttempt, type PasteImageDeps } from '../../src/clipboard/pasteImage';

// The orchestration decision that shipped broken: `pasteClipboardImage` ran exactly one
// native command, and if it produced nothing it returned `false` and let an ordinary text
// paste happen — silently. On Windows that command was `Get-Clipboard -Format Image`, which
// answers $null for the DIB that Win+Shift+S puts on the clipboard, so the feature did
// nothing at all and said nothing about it. Reported from the field as simply "not working".
//
// Two things had to become explicit and therefore testable: WHICH readers get tried and in
// what order, and WHAT the user is told when none of them produced an image.

/** A run of candidates producing the given results, in order. */
const attempts = (...results: Array<Uint8Array | undefined>): CaptureAttempt[] =>
    results.map((bytes, index) => ({ label: `tool${index}`, run: vi.fn(async () => bytes) }));

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

describe('decideCapturePlan: try readers in order, fall back, never fail silently', () => {
    it('uses the first reader that returns bytes', async () => {
        const plan = attempts(PNG, PNG);
        const result = await decideCapturePlan(plan);

        expect(result.bytes).toBe(PNG);
        expect(result.source).toBe('tool0');
        expect(plan[1].run).not.toHaveBeenCalled(); // no pointless second read
    });

    // The whole point of a candidate list: on Linux wl-paste is absent under X11 and xclip
    // is useless under Wayland, so "the first one missed" is the normal case, not an error.
    it('advances past readers that find nothing', async () => {
        const plan = attempts(undefined, PNG);
        const result = await decideCapturePlan(plan);

        expect(result.bytes).toBe(PNG);
        expect(result.source).toBe('tool1');
        expect(plan[0].run).toHaveBeenCalled();
    });

    // A missing binary throws ENOENT rather than exiting non-zero, and that must be
    // indistinguishable from an imageless clipboard — otherwise not having pngpaste
    // installed would abort the run before the webview fallback ever got a turn.
    it('treats a reader that throws as one that found nothing', async () => {
        const plan: CaptureAttempt[] = [
            { label: 'missing', run: vi.fn(async () => { throw new Error('ENOENT'); }) },
            { label: 'webview', run: vi.fn(async () => PNG) },
        ];
        const result = await decideCapturePlan(plan);

        expect(result.bytes).toBe(PNG);
        expect(result.source).toBe('webview');
    });

    it('reports every reader it tried when none produced an image', async () => {
        const result = await decideCapturePlan(attempts(undefined, undefined));

        expect(result.bytes).toBeUndefined();
        // The diagnosis the silent version never gave: which readers ran, so a support log
        // distinguishes "no image on the clipboard" from "no reader on this machine".
        expect(result.tried).toEqual(['tool0', 'tool1']);
    });

    it('reports no readers at all on a platform with none', async () => {
        const result = await decideCapturePlan([]);

        expect(result.bytes).toBeUndefined();
        expect(result.tried).toEqual([]);
    });

    it('rejects an empty payload rather than uploading a zero-byte file', async () => {
        const result = await decideCapturePlan(attempts(new Uint8Array(0), PNG));

        expect(result.bytes).toBe(PNG);
        expect(result.source).toBe('tool1');
    });
});

describe('captureAttempts: native readers are silent, the webview one is not', () => {
    const deps = (platform: string): PasteImageDeps => ({
        platform,
        exec: vi.fn(),
        log: { info: vi.fn(), trace: vi.fn() },
        authority: 'ssh-remote+host',
    });
    const terminal = {} as unknown as import('vscode').Terminal;
    const labels = (platform: string, hasText: boolean): string[] =>
        captureAttempts(deps(platform), terminal, '/tmp/shot.png', hasText).map(a => a.label);

    it('puts the platform readers first and the webview last', () => {
        expect(labels('linux', false)).toEqual(['wl-paste', 'xclip', 'webview']);
    });

    // The webview opens a panel. Offering it whenever the clipboard already holds text
    // would flash one on every ordinary command paste — a worse regression than the case it
    // would cover, so text on the clipboard removes it from the chain entirely.
    it('drops the webview when the clipboard already holds text', () => {
        expect(labels('linux', true)).toEqual(['wl-paste', 'xclip']);
    });

    // Native readers still run with text present: a browser's "copy image" puts the source
    // URL on the text clipboard next to the bitmap, and the bitmap is the point.
    it('still runs the native readers when the clipboard holds text', () => {
        expect(labels('win32', true)).toEqual(['powershell (WPF clipboard)', 'powershell (WinForms clipboard)']);
    });

    // Two candidates on the same binary must stay distinguishable in the log, or the line
    // that explains a miss reads "powershell.exe, powershell.exe" and says nothing about
    // which clipboard API actually declined.
    it('carries the per-candidate label rather than the binary name', () => {
        expect(new Set(labels('win32', false)).size).toBe(labels('win32', false).length);
    });

    // macOS has two natives now: pngpaste if it was installed, then AppleScript, which is
    // always there. The webview stays last — it is the only one that shows a panel.
    it('tries pngpaste then osascript on darwin before the webview', () => {
        expect(labels('darwin', false)).toEqual(['pngpaste', 'osascript', 'webview']);
    });

    // The platforms with no native reader at all are exactly the ones that need the
    // webview most — it must not be conditional on a native list being non-empty.
    it('offers the webview alone on a platform with no native reader', () => {
        expect(labels('aix', false)).toEqual(['webview']);
    });
});
