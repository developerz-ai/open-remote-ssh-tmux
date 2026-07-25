import * as vscode from 'vscode';
import { execFile } from 'child_process';
import { randomBytes } from 'crypto';
import { readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
    bracketedPaste,
    buildCleanupCommand,
    buildLocalCaptureCandidates,
    buildRemoteMkdirCommand,
    remoteImageDir,
    remoteImagePath,
    type CaptureCandidate,
} from './clipboardImage';
import { MAX_IMAGE_BYTES, readClipboardImageViaWebview } from './clipboardWebview';

// Orchestration for "paste a local screenshot into a remote terminal".
//
// Flow: read the LOCAL clipboard (the extension is `extensionKind: ["ui"]`, so it runs on
// the user's machine) -> write the PNG to the remote over the already-open connection ->
// type the remote path into the focused terminal as a bracketed paste. Claude Code (or
// anything else running in that terminal) then reads the image by path. The clipboard never
// has to cross the SSH link itself.
//
// Reading is a *sequence* of attempts, not one command, because no single reader works
// everywhere: the platform binaries are all optional installs and each covers only part of
// its platform, and the webview reader always works but costs a visible panel. So: native
// first (silent), webview last (visible, but nothing to install). A run that finds no image
// says so in the log with the list of readers it tried — the first version returned a bare
// `false` here, which is why "not working" was all anyone could report.
//
// Depends on nothing in `src/tmux/*` — a clipboard bridge is not a terminal-lifetime
// concern, and keeping the two apart means this can be lifted into its own extension.

/** Remote command runner (same shape as the tmux layer's, redeclared to avoid the import). */
export type RemoteExec = (command: string) => Promise<{ stdout: string; stderr: string }>;

/** The narrow logger slice this module uses. */
export interface PasteLog {
    info(message: string): void;
    trace(message: string): void;
}

/** Collaborators, all injected so the orchestration is testable without a clipboard. */
export interface PasteImageDeps {
    readonly exec: RemoteExec;
    readonly log: PasteLog;
    /** `process.platform` of the machine the extension runs on. */
    readonly platform: string;
    /** Remote authority (`ssh-remote+…`) used to address the remote filesystem. */
    readonly authority: string;
}

/** One way of getting an image, named for the log. `run` resolves `undefined` for "this
 * reader found nothing", which is an ordinary outcome, not a failure. */
export interface CaptureAttempt {
    readonly label: string;
    run(): Promise<Uint8Array | undefined>;
}

/** What a run of the readers produced, plus enough detail to explain a miss. */
export interface CaptureResult {
    readonly bytes?: Uint8Array;
    /** Label of the reader that produced `bytes`. */
    readonly source?: string;
    /** Every reader that ran, in order — the log line that makes a miss diagnosable. */
    readonly tried: string[];
}

/** Delay before any progress UI appears. A screenshot over an open connection is usually
 * sub-second; showing a spinner for that is noise. Only a genuinely slow upload surfaces. */
const PROGRESS_DELAY_MS = 300;

/** Images older than this are swept on connect. */
export const IMAGE_MAX_AGE_HOURS = 48;

/**
 * Run `attempts` in order and take the first image any of them yields. A reader that finds
 * nothing, throws (a missing binary raises ENOENT rather than exiting non-zero), or returns
 * an empty payload is skipped — all three mean the same thing to the caller, and treating
 * any of them as fatal would stop the fallback chain before the reader that would have
 * worked. Pure over its injected attempts, so the ordering contract is unit-testable
 * without a clipboard.
 */
export async function decideCapturePlan(attempts: readonly CaptureAttempt[]): Promise<CaptureResult> {
    const tried: string[] = [];
    for (const attempt of attempts) {
        tried.push(attempt.label);
        let bytes: Uint8Array | undefined;
        try {
            bytes = await attempt.run();
        } catch {
            continue; // no such tool / it blew up — indistinguishable from "no image"
        }
        if (bytes && bytes.byteLength > 0) {
            return { bytes, source: attempt.label, tried };
        }
    }
    return { tried };
}

/**
 * Read the local clipboard image, upload it, and paste its remote path into the active
 * terminal. Resolves `false` when there was no image to paste, so the caller can fall
 * through to an ordinary text paste — never swallowing the user's paste.
 */
export async function pasteClipboardImage(deps: PasteImageDeps): Promise<boolean> {
    const terminal = vscode.window.activeTerminal;
    if (!terminal) {
        deps.log.trace('clipboard image: no active terminal');
        return false;
    }

    // Text on the clipboard means the user is very likely pasting text — that decides only
    // whether the *visible* reader may run (see {@link captureAttempts}); the silent native
    // readers run either way, because a browser's "copy image" puts a URL on the text
    // clipboard alongside the bitmap and the image is still the thing worth pasting.
    const hasText = (await vscode.env.clipboard.readText()).length > 0;

    const localPath = join(tmpdir(), `orst-clip-${randomBytes(8).toString('hex')}.png`);
    try {
        const capture = await decideCapturePlan(captureAttempts(deps, terminal, localPath, hasText));
        if (!capture.bytes) {
            // The line the silent version owed the user: what ran, so "no image on the
            // clipboard" is distinguishable from "no reader exists on this machine".
            deps.log.info(`clipboard image: no image found (tried: ${capture.tried.join(', ') || 'no reader for this platform'})`);
            return false;
        }
        if (capture.bytes.byteLength > MAX_IMAGE_BYTES) {
            vscode.window.showErrorMessage(`Clipboard image is too large to upload (${Math.round(capture.bytes.byteLength / 1048576)} MB).`);
            return true;
        }

        const remoteUserId = await resolveRemoteUserId(deps.exec);
        const dir = remoteImageDir(remoteUserId);
        const target = remoteImagePath(remoteUserId, randomBytes(8).toString('hex'));

        await withDelayedProgress(PROGRESS_DELAY_MS, 'Uploading image…', async () => {
            // Create the directory private BEFORE writing: `workspace.fs.writeFile` cannot
            // set a mode, so a world-readable directory would expose the screenshot for the
            // window between write and any later chmod. Screenshots routinely carry tokens.
            await deps.exec(buildRemoteMkdirCommand(dir));
            await vscode.workspace.fs.writeFile(remoteUri(deps.authority, target), capture.bytes!);
        });

        // Bracketed paste, not sendText: a TUI like Claude Code treats typed and pasted
        // input differently, and a bare path can trigger completion or submit early.
        terminal.sendText(bracketedPaste(target), false);
        deps.log.info(`clipboard image uploaded via ${capture.source} (${capture.bytes.byteLength} bytes) -> ${target}`);
        return true;
    } catch (err) {
        // An image was found but could not be delivered. Unlike "no image", this is a real
        // failure with nothing sensible to fall back to, so say it out loud rather than
        // performing a text paste the user did not ask for.
        deps.log.info(`clipboard image paste failed: ${errorText(err)}`);
        vscode.window.showErrorMessage(`Could not paste the image into the remote terminal: ${errorText(err)}`);
        return true;
    } finally {
        await rm(localPath, { force: true }).catch(() => { /* best-effort temp cleanup */ });
    }
}

/**
 * Connect-time sweep of images older than {@link IMAGE_MAX_AGE_HOURS}, mirroring the tmux
 * session reaper: best-effort, never throws, never blocks the connection. Scoped strictly to
 * this user's own image directory.
 */
export async function sweepOldImages(deps: Pick<PasteImageDeps, 'exec' | 'log'>): Promise<void> {
    try {
        const dir = remoteImageDir(await resolveRemoteUserId(deps.exec));
        await deps.exec(buildCleanupCommand(dir, IMAGE_MAX_AGE_HOURS));
        deps.log.trace(`clipboard images: swept anything older than ${IMAGE_MAX_AGE_HOURS}h in ${dir}`);
    } catch (err) {
        deps.log.trace(`clipboard image sweep failed: ${errorText(err)}`);
    }
}

/**
 * The readers to try, in order: every native candidate for this platform first (fast and
 * invisible), then the webview — always available and needing nothing installed, but it
 * opens a panel, so it goes last and only once the natives have all missed.
 *
 * `hasText` suppresses the webview entirely. Without that, pressing the paste key with an
 * ordinary command on the clipboard would flash a panel every single time, which is a far
 * worse regression than the case it would serve. The native readers are unaffected: they
 * cost nothing and are the ones that matter when an image and a text URL are both present.
 */
export function captureAttempts(
    deps: PasteImageDeps,
    terminal: vscode.Terminal,
    localPath: string,
    hasText: boolean,
): CaptureAttempt[] {
    const attempts: CaptureAttempt[] = buildLocalCaptureCandidates(deps.platform, localPath).map(candidate => ({
        label: candidate.label ?? candidate.argv[0],
        run: (): Promise<Uint8Array | undefined> => runCaptureCandidate(candidate, localPath),
    }));
    if (!hasText) {
        attempts.push({
            label: 'webview',
            run: (): Promise<Uint8Array | undefined> => readClipboardImageViaWebview(deps.log, terminal),
        });
    }
    return attempts;
}

/** Run one native reader and collect its bytes from wherever it puts them. */
function runCaptureCandidate(candidate: CaptureCandidate, outPath: string): Promise<Uint8Array | undefined> {
    const [command, ...args] = candidate.argv;
    return new Promise<Uint8Array | undefined>((resolve, reject) => {
        // `encoding: 'buffer'` because the stdout readers stream raw PNG bytes; decoding
        // them as text would corrupt every image. maxBuffer is raised for the same reason —
        // the default 1 MB truncates all but the smallest screenshots.
        execFile(
            command,
            args,
            { timeout: 15_000, windowsHide: true, encoding: 'buffer', maxBuffer: MAX_IMAGE_BYTES },
            (error, stdout) => {
                if (error) {
                    // Non-zero exit is the documented "no image" signal for all of these
                    // tools, and also what a missing binary produces. Both are "found
                    // nothing" — reject only so the caller's log records which one ran.
                    reject(error);
                    return;
                }
                if (candidate.output === 'stdout') {
                    resolve(stdout.byteLength > 0 ? new Uint8Array(stdout) : undefined);
                    return;
                }
                readFile(outPath)
                    .then(bytes => resolve(bytes.byteLength > 0 ? new Uint8Array(bytes) : undefined))
                    .catch(() => resolve(undefined)); // exited 0 but wrote nothing
            },
        );
    });
}

/** The remote's numeric uid, used to keep the image directory per-user in world-writable
 * `/tmp`. Falls back to a constant only if the probe returns something unusable, in which
 * case the path builders' validation still rejects anything unsafe. */
async function resolveRemoteUserId(exec: RemoteExec): Promise<string> {
    const { stdout } = await exec('id -u');
    const id = stdout.trim();
    return /^[0-9]+$/.test(id) ? id : 'shared';
}

/** Address a remote absolute path through the already-mounted remote filesystem, so the
 * bytes travel over the existing connection — no scp, no second channel, no daemon. */
function remoteUri(authority: string, remotePath: string): vscode.Uri {
    return vscode.Uri.from({ scheme: 'vscode-remote', authority, path: remotePath });
}

/** Show progress only if the work outlasts `delayMs`, so fast pastes stay silent.
 * `ProgressLocation.Window` keeps it in the status bar rather than a notification toast. */
async function withDelayedProgress<T>(delayMs: number, title: string, work: () => Promise<T>): Promise<T> {
    const task = work();
    let settled = false;
    void task.then(() => { settled = true; }, () => { settled = true; });

    await new Promise(resolve => setTimeout(resolve, delayMs));
    if (settled) {
        return task;
    }
    return vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title }, () => task);
}

function errorText(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}
