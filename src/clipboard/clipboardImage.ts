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
            // `[Windows.Forms.Clipboard]::GetImage()`, not `Get-Clipboard -Format Image`
            // (what shipped first, and what did not work): the latter exists only in Windows
            // PowerShell 5.x — it was dropped from PowerShell 7 — and returns $null for
            // clipboard contents delivered as a DIB, which is exactly what Win+Shift+S and
            // most screenshot tools put there. GetImage() handles both, but it needs its
            // assembly loaded explicitly and a single-threaded apartment: the clipboard is an
            // STA-only OLE API, and it silently yields nothing from an MTA host.
            //
            // The PNG encoder is named explicitly too — the default `Save(path)` overload
            // picks a format from nothing and can emit a non-PNG payload under a .png name,
            // which anything sniffing by extension then mis-reads.
            return [{
                output: 'file',
                argv: [
                    'powershell.exe', '-NoProfile', '-NonInteractive', '-STA', '-Command',
                    'Add-Type -AssemblyName System.Windows.Forms,System.Drawing; '
                    + '$img = [System.Windows.Forms.Clipboard]::GetImage(); '
                    + 'if ($img -eq $null) { exit 1 }; '
                    + `$img.Save('${psQuote(outPath)}', [System.Drawing.Imaging.ImageFormat]::Png); exit 0`,
                ],
            }];
        case 'darwin':
            // pngpaste is not shipped with macOS (`brew install pngpaste`); a missing binary
            // exits non-zero exactly like an imageless clipboard, so it just falls through.
            return [{ output: 'file', argv: ['pngpaste', outPath] }];
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

/** Escape a value for a PowerShell single-quoted string, where a literal quote is doubled.
 * Without this a username containing an apostrophe (`C:\Users\O'Brien\…`) would close the
 * string early and hand the rest of the path to the parser as code. */
function psQuote(value: string): string {
    return value.replace(/'/g, `''`);
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
