// Pure builders for the clipboard→remote image bridge.
//
// The workflow this exists for: you are developing against a remote server, you see a
// visual bug in a webapp on your LOCAL screen, and you want to hand that screenshot to a
// tool running on the REMOTE (Claude Code, in one of this fork's tmux terminals). The
// clipboard lives on your machine; the tool lives on the server; nothing bridges them.
// So: read the image locally, write it to the remote filesystem, and paste the path.
//
// Why this can't use the VS Code clipboard API: `vscode.env.clipboard` is text-only
// (`readText`/`writeText`, vscode.d.ts:10669) — there is no image read. Binary clipboard
// data exists only via `DataTransfer` for *editor* drop/paste providers, not terminals.
// The extension is `extensionKind: ["ui"]` though, so it runs as a Node process on the
// user's machine and can shell out to the platform's native clipboard tool. That is the
// only reason this is possible at all, and it is why these commands MUST run locally:
// run them on the remote and they read the server's (empty) clipboard.
//
// Deliberately independent of `src/tmux/*` — no imports either way. This is a clipboard
// concern, not a terminal-lifetime one, and keeping it separable means it can be lifted
// into its own extension without untangling anything.
//
// As with `tmuxSession.ts`, this module is the ONLY place these command lines are built,
// so quoting and path construction are auditable in one file.

/** Root under which every uploaded image lives, before the per-user suffix. */
const REMOTE_ROOT = '/tmp/open-remote-ssh-tmux';

/** Accepted shape for a remote user id / image id: no separators, no whitespace, no dots.
 * Anything outside this cannot traverse a path or break out of a quoted shell word. */
const SAFE_TOKEN = /^[A-Za-z0-9_-]+$/;

/** One way to get the clipboard's image off this machine. `output` says where the bytes
 * land: `file` means the tool wrote `outPath`, `stdout` means the caller reads them from
 * the process's standard output (xclip and wl-paste cannot write a file). */
export interface CaptureCandidate {
    readonly argv: string[];
    readonly output: 'file' | 'stdout';
    /** Name for the "tried: …" log line. Defaults to `argv[0]`, which is enough until two
     * candidates share a binary — the two Windows readers are both `powershell.exe`, and
     * "powershell.exe, powershell.exe" cannot tell you which clipboard API declined. */
    readonly label?: string;
}

/**
 * Ordered ways to read the LOCAL clipboard's image, best first — empty when the platform
 * has no known reader. The caller tries each in turn and, if they all miss, falls through
 * to the webview bridge (`clipboardWebview.ts`), which needs no external binary at all.
 *
 * A list rather than a single command because no one tool covers a platform: Linux splits
 * X11 and Wayland, and every binary here is optional (`pngpaste`, `xclip` and `wl-paste`
 * are all separate installs). A non-zero exit therefore means "no image OR no such tool",
 * and both simply advance to the next candidate.
 *
 * @param platform `process.platform` of the machine the extension runs on.
 * @param outPath local file a `file`-output tool should write the PNG to.
 */
export function buildLocalCaptureCandidates(platform: string, outPath: string): CaptureCandidate[] {
    switch (platform) {
        case 'win32':
            // Two readers, because Windows has no single dependable one.
            //
            // Not `Get-Clipboard -Format Image` (what shipped first, and did not work): it
            // exists only in Windows PowerShell 5.x — dropped from PowerShell 7 — and returns
            // $null for clipboard contents delivered as a DIB, which is exactly what
            // Win+Shift+S and most screenshot tools put there.
            //
            // WPF's `[Windows.Clipboard]::GetImage()` leads: it is the combination the
            // long-standing implementations settled on (vscode-paste-image's `pc.ps1`, itself
            // derived from img-clipboard-dump). WinForms follows as a second opinion — the two
            // negotiate clipboard formats differently, and a DIB one declines the other has
            // been observed to accept. Both need `-STA`: the clipboard is an STA-only OLE API
            // and silently yields nothing from an MTA host.
            //
            // Both go through `-EncodedCommand` rather than inline `-Command` text, which is
            // the fix for the reported "nothing happens" on Windows. The scripts contain
            // `$variables`, single quotes, semicolons and a Windows path, and every one of
            // those has to survive argument processing plus a CreateProcess command-line
            // round trip. `$` in particular does not reliably survive — a spawning runtime
            // stripping it outright is a documented failure (opencode #17616), and it turns
            // `$img` into the bare word `img` for reasons no log can explain. Base64 of
            // UTF-16LE is one opaque token with nothing left to interpret.
            return [
                {
                    output: 'file',
                    label: 'powershell (WPF clipboard)',
                    argv: [...POWERSHELL_FLAGS, encodePowerShellCommand(
                        'Add-Type -Assembly PresentationCore; '
                        + '$img = [Windows.Clipboard]::GetImage(); '
                        + 'if ($img -eq $null) { exit 1 }; '
                        + `$stream = [IO.File]::Open('${psQuote(outPath)}', 'Create'); `
                        + '$encoder = New-Object Windows.Media.Imaging.PngBitmapEncoder; '
                        + '$encoder.Frames.Add([Windows.Media.Imaging.BitmapFrame]::Create($img)) | Out-Null; '
                        + '$encoder.Save($stream) | Out-Null; '
                        + '$stream.Dispose(); exit 0'
                    )],
                },
                {
                    output: 'file',
                    label: 'powershell (WinForms clipboard)',
                    argv: [...POWERSHELL_FLAGS, encodePowerShellCommand(
                        'Add-Type -AssemblyName System.Windows.Forms,System.Drawing; '
                        + '$img = [System.Windows.Forms.Clipboard]::GetImage(); '
                        + 'if ($img -eq $null) { exit 1 }; '
                        // The PNG encoder is named explicitly — the default `Save(path)`
                        // overload picks a format from nothing and can emit a non-PNG payload
                        // under a .png name, which anything sniffing by extension mis-reads.
                        + `$img.Save('${psQuote(outPath)}', [System.Drawing.Imaging.ImageFormat]::Png); exit 0`
                    )],
                },
            ];
        case 'darwin':
            // pngpaste is not shipped with macOS (`brew install pngpaste`); a missing binary
            // exits non-zero exactly like an imageless clipboard, so it just falls through —
            // to AppleScript, which ships with the OS and is what Claude Code's own paste
            // relies on. Without that fallback a stock Mac has no native reader at all and
            // gets pushed to the visible webview panel for something the OS can do itself.
            return [
                { output: 'file', argv: ['pngpaste', outPath] },
                { output: 'file', argv: ['osascript', '-e', appleScriptClipboardToPng(outPath)] },
            ];
        case 'linux':
            // Wayland first. It is the default session on current GNOME and KDE, xclip cannot
            // speak to it at all, and a Wayland desktop running XWayland still answers an
            // xclip query — with an empty X11 clipboard. Asking wl-paste first avoids that
            // false negative; on X11 wl-paste is absent or errors and xclip takes over.
            // `--no-newline` matters because the bytes are binary: wl-paste otherwise appends
            // a newline that corrupts the PNG.
            return [
                { output: 'stdout', argv: ['wl-paste', '--no-newline', '--type', 'image/png'] },
                { output: 'stdout', argv: ['xclip', '-selection', 'clipboard', '-t', 'image/png', '-o'] },
            ];
        default:
            return [];
    }
}

/** Flags shared by both Windows readers. `-STA` is load-bearing (the clipboard is an STA-only
 * OLE API); `-NoProfile` keeps a user's profile from printing into our output or slowing the
 * spawn; `-NonInteractive` guarantees it can never sit waiting on a prompt. */
const POWERSHELL_FLAGS = ['powershell.exe', '-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand'];

/** Encode a script for `powershell.exe -EncodedCommand`: base64 of UTF-16LE, which is the
 * one form PowerShell accepts. See the win32 branch above for why the scripts are passed
 * this way instead of as inline `-Command` text. */
function encodePowerShellCommand(script: string): string {
    return Buffer.from(script, 'utf16le').toString('base64');
}

/** Escape a value for a PowerShell single-quoted string, where a literal quote is doubled.
 * Without this a username containing an apostrophe (`C:\Users\O'Brien\…`) would close the
 * string early and hand the rest of the path to the parser as code. */
function psQuote(value: string): string {
    return value.replace(/'/g, `''`);
}

/**
 * AppleScript that writes the clipboard's PNG to `outPath`, or fails if there isn't one.
 *
 * `set eof` truncates before writing: the candidate that ran before this one may have left a
 * partial file behind, and AppleScript's `write` appends from the current mark rather than
 * replacing the contents — which would produce a corrupt PNG with a valid-looking size.
 *
 * The `on error` arm closes the handle and re-raises. `the clipboard as «class PNGf»` throws
 * when the clipboard holds no image, which is an ordinary outcome here, but the file is
 * already open by then and leaving it open would leak the handle for the life of the process.
 * Re-raising keeps the non-zero exit the caller reads as "this reader found nothing".
 */
function appleScriptClipboardToPng(outPath: string): string {
    const target = asQuote(outPath);
    return [
        `set outFile to open for access (POSIX file "${target}") with write permission`,
        'try',
        '    set eof outFile to 0',
        '    write (the clipboard as «class PNGf») to outFile',
        '    close access outFile',
        'on error errMsg',
        '    close access outFile',
        '    error errMsg',
        'end try',
    ].join('\n');
}

/** Escape a value for an AppleScript double-quoted string: backslash first, then quote. */
function asQuote(value: string): string {
    return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * Directory holding this remote user's uploaded images.
 *
 * The user id is part of the path on purpose. `/tmp` is world-writable, so a single shared
 * directory lets any other account on that box pre-create it (or plant a symlink) and read
 * every screenshot dropped in — and screenshots routinely carry session cookies, tokens and
 * customer data. This mirrors the reasoning that moved `server-setup.sh`'s install lock out
 * of the shared `$TMP_DIR` into a per-user location.
 *
 * @throws if `remoteUserId` is not a plain safe token — a traversal or a shell metacharacter
 *   here would otherwise reach a command line.
 */
export function remoteImageDir(remoteUserId: string): string {
    if (!SAFE_TOKEN.test(remoteUserId)) {
        throw new Error(`unsafe remote user id for image directory: ${JSON.stringify(remoteUserId)}`);
    }
    return `${REMOTE_ROOT}-${remoteUserId}/images`;
}

/**
 * Full remote path for one image. `imageId` is injected (not generated here) so naming stays
 * deterministic under test; it is validated for the same reason as the user id.
 */
export function remoteImagePath(remoteUserId: string, imageId: string): string {
    if (!SAFE_TOKEN.test(imageId)) {
        throw new Error(`unsafe image id: ${JSON.stringify(imageId)}`);
    }
    return `${remoteImageDir(remoteUserId)}/${imageId}.png`;
}

/**
 * Create the image directory private *before* the first byte lands.
 * `vscode.workspace.fs.writeFile` cannot set a mode, so if the directory were created
 * world-readable the image would be exposed for the window between write and any later
 * `chmod`. `mkdir -p -m 700` closes that window.
 */
export function buildRemoteMkdirCommand(dir: string): string {
    return `mkdir -p -m 700 ${quote(dir)}`;
}

/**
 * The age-based sweep, same shape as the tmux session reaper: a connect-time housekeeping
 * pass, conservative by construction. `-maxdepth 1` keeps it inside our own directory,
 * `-type f -name '*.png'` keeps it to files we created, and stderr is discarded because
 * "no such directory" is the normal state on a remote nothing has been pasted to yet.
 *
 * @param maxAgeHours delete regular images last modified longer ago than this.
 */
export function buildCleanupCommand(dir: string, maxAgeHours: number): string {
    const minutes = Math.round(maxAgeHours * 60);
    return `find ${quote(dir)} -maxdepth 1 -type f -name '*.png' -mmin +${minutes} -delete 2>/dev/null`;
}

/**
 * Wrap `payload` in bracketed-paste markers.
 *
 * Full-screen TUIs treat typed input very differently from pasted input. Claude Code in
 * particular will act on a bare path as keystrokes — triggering completion, or submitting
 * early. `ESC[200~ … ESC[201~` tells the application "this arrived as a paste", which is
 * what makes the path land in the prompt intact. tmux forwards these sequences through to
 * the running application unchanged. No trailing newline: the user decides when to submit.
 */
export function bracketedPaste(payload: string): string {
    return `[200~${payload}[201~`;
}

/** POSIX single-quote quoting — identical rule to `tmuxSession.ts`'s `escapeShellArg`,
 * restated here rather than imported so this module keeps no dependency on the tmux layer. */
function quote(value: string): string {
    return `'${value.replace(/'/g, `'\\''`)}'`;
}
