import { describe, expect, it } from 'vitest';
import {
    buildCleanupCommand,
    buildLocalCaptureCandidates,
    buildRemoteMkdirCommand,
    MKDIR_OK_MARKER,
    bracketedPaste,
    remoteImageDir,
    remoteImagePath,
} from '../../src/clipboard/clipboardImage';

// Pure builders for the clipboard->remote image bridge. Everything that touches a real
// clipboard, a real filesystem, or a real SSH channel is injected elsewhere; these are the
// decisions worth pinning, and — as with the tmux command builders — the ONLY place local
// capture commands and remote shell commands are constructed.

describe('buildLocalCaptureCandidates: read the LOCAL clipboard (extension runs on the user machine)', () => {
    // The extension is `extensionKind: ["ui"]`, so it runs on the user's machine and these
    // commands read THEIR clipboard — which is the whole point. Running any of these on the
    // remote would read the server's (empty) clipboard instead.
    //
    // A *list* rather than one command because no single tool covers a platform: Linux
    // splits X11/Wayland, and every one of these binaries is optional. The caller tries
    // them in order and falls through to the webview bridge when they all miss.

    /** The script a `-EncodedCommand` candidate actually runs, decoded back for assertions.
     *  PowerShell expects base64 of UTF-16LE, so this is the inverse of that. */
    const decodePowerShell = (candidate: { argv: string[] }): string => {
        const encoded = candidate.argv[candidate.argv.indexOf('-EncodedCommand') + 1];
        return Buffer.from(encoded, 'base64').toString('utf16le');
    };

    it('offers a PowerShell reader on win32 that writes a PNG to the given path', () => {
        const [first] = buildLocalCaptureCandidates('win32', 'C:\\tmp\\shot.png');
        expect(first.argv[0]).toBe('powershell.exe');
        expect(first.output).toBe('file');
        const script = decodePowerShell(first);
        expect(script).toContain('C:\\tmp\\shot.png');
        // Must encode as PNG explicitly — an encoder chosen by default can write a non-PNG
        // payload under a .png name, which anything sniffing by extension then mis-reads.
        expect(script).toContain('Png');
    });

    // THE FIELD BUG, and the reason the script is no longer passed as inline `-Command` text.
    //
    // The script needs `$variables`, and `$` does not survive every layer between here and
    // PowerShell's parser: argument processing in the spawning runtime can strip it outright
    // (documented in the wild — opencode #17616, "Bun spawn strips $ in PowerShell"), leaving
    // `$img` as the bare word `img` and a script that fails for reasons no log can explain.
    // Quoting is the same story: the command carries single quotes, semicolons and a Windows
    // path, all of which have to cross a CreateProcess command-line round trip intact.
    //
    // `-EncodedCommand` sidesteps the entire class: base64 of UTF-16LE is one opaque token
    // with no character any layer wants to interpret. It is also what the established
    // implementations reach for after hitting exactly this.
    it('passes the script as -EncodedCommand so quoting and $ cannot be mangled', () => {
        const [first] = buildLocalCaptureCandidates('win32', 'C:\\tmp\\shot.png');
        expect(first.argv).toContain('-EncodedCommand');
        expect(first.argv).not.toContain('-Command');
        // Base64 only: nothing for a shell, cmd.exe or CreateProcess quoting to touch.
        const encoded = first.argv[first.argv.indexOf('-EncodedCommand') + 1];
        expect(encoded).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
        // And it must round-trip to a script that still has its variables.
        expect(decodePowerShell(first)).toContain('$img');
    });

    // `Get-Clipboard -Format Image` (the first shipped attempt) is the wrong API here: it
    // exists only in Windows PowerShell 5.x — removed from PowerShell 7 — and returns null
    // for clipboard contents that arrive as a DIB, which is what Win+Shift+S produces.
    // Both replacements need an STA apartment: the clipboard is an STA-only OLE API and
    // silently yields nothing from an MTA host.
    it('requests STA and skips the profile on every Windows candidate', () => {
        for (const candidate of buildLocalCaptureCandidates('win32', 'C:\\tmp\\shot.png')) {
            expect(candidate.argv).toContain('-STA');
            expect(candidate.argv).toContain('-NoProfile');
        }
    });

    // WPF's `[Windows.Clipboard]::GetImage()` + PngBitmapEncoder is the combination the
    // long-standing implementations use (vscode-paste-image's pc.ps1, itself from
    // img-clipboard-dump), so it leads. WinForms' `Clipboard::GetImage()` follows as a
    // second opinion: the two go through different clipboard-format negotiation, and a DIB
    // one declines the other has been observed to accept.
    it('tries the WPF clipboard reader first, then WinForms as a second opinion', () => {
        const candidates = buildLocalCaptureCandidates('win32', 'C:\\tmp\\shot.png');
        expect(candidates).toHaveLength(2);

        const wpf = decodePowerShell(candidates[0]);
        expect(wpf).toContain('PresentationCore');
        expect(wpf).toContain('[Windows.Clipboard]::GetImage()');
        expect(wpf).toContain('PngBitmapEncoder');

        const forms = decodePowerShell(candidates[1]);
        expect(forms).toContain('System.Windows.Forms');
        expect(forms).toContain('Clipboard]::GetImage()');
    });

    // Two candidates on one binary: without distinct labels the "tried: ..." log line reads
    // "powershell.exe, powershell.exe" and cannot say which API declined the clipboard.
    it('labels the two Windows candidates distinctly for the log', () => {
        const [wpf, forms] = buildLocalCaptureCandidates('win32', 'C:\\tmp\\shot.png');
        expect(wpf.label).toBeDefined();
        expect(forms.label).toBeDefined();
        expect(wpf.label).not.toBe(forms.label);
    });

    // PowerShell single-quoted strings escape a quote by doubling it. A username with an
    // apostrophe ("C:\Users\O'Brien\...") would otherwise terminate the string early and
    // turn the rest of the path into code.
    it('escapes single quotes in the output path', () => {
        for (const candidate of buildLocalCaptureCandidates('win32', 'C:\\Users\\O\'Brien\\shot.png')) {
            expect(decodePowerShell(candidate)).toContain('O\'\'Brien');
        }
    });

    it('exits non-zero when the Windows clipboard holds no image', () => {
        for (const candidate of buildLocalCaptureCandidates('win32', 'C:\\tmp\\shot.png')) {
            expect(decodePowerShell(candidate)).toContain('exit 1');
        }
    });

    it('uses pngpaste on darwin', () => {
        const [first] = buildLocalCaptureCandidates('darwin', '/tmp/shot.png');
        expect(first.argv[0]).toBe('pngpaste');
        expect(first.argv).toContain('/tmp/shot.png');
        expect(first.output).toBe('file');
    });

    // pngpaste is a `brew install`, so on a stock Mac the only native reader is absent and
    // the user is pushed to the visible webview panel for something the OS can do itself.
    // AppleScript's `the clipboard as «class PNGf»` ships with macOS — it is what Claude
    // Code's own paste relies on — so it belongs in the chain as the no-install fallback.
    it('falls back to osascript on darwin, so pngpaste is not required', () => {
        const candidates = buildLocalCaptureCandidates('darwin', '/tmp/shot.png');
        expect(candidates.map(c => c.argv[0])).toEqual(['pngpaste', 'osascript']);

        const script = candidates[1].argv.join('\n');
        expect(script).toContain('«class PNGf»');
        expect(script).toContain('/tmp/shot.png');
        // Truncate first: the failed candidate before it may have left a partial file, and
        // AppleScript's `write` appends from the current mark rather than replacing.
        expect(script).toContain('set eof');
        // The handle must be closed even when the clipboard holds no PNG, or a miss leaks a
        // file handle for the life of the process.
        expect(script).toContain('close access');
    });

    it('escapes double quotes and backslashes in the osascript path', () => {
        const candidates = buildLocalCaptureCandidates('darwin', '/tmp/we"ird\\shot.png');
        const script = candidates[1].argv.join('\n');
        expect(script).toContain('we\\"ird');
        expect(script).toContain('\\\\shot.png');
    });

    // Wayland is the default on current GNOME/KDE and xclip cannot talk to it at all, so a
    // Wayland desktop had no working reader whatsoever. wl-paste goes first because a
    // Wayland session running XWayland would otherwise answer through xclip with nothing.
    it('tries wl-paste before xclip on linux, both reading image/png from stdout', () => {
        const candidates = buildLocalCaptureCandidates('linux', '/tmp/shot.png');
        expect(candidates.map(c => c.argv[0])).toEqual(['wl-paste', 'xclip']);
        for (const candidate of candidates) {
            expect(candidate.argv.join(' ')).toContain('image/png');
            // Neither tool can write to a file; both stream the bytes to stdout.
            expect(candidate.output).toBe('stdout');
            expect(candidate.argv).not.toContain('/tmp/shot.png');
        }
    });

    it('returns no candidates for a platform with no known clipboard reader', () => {
        expect(buildLocalCaptureCandidates('aix', '/tmp/shot.png')).toEqual([]);
    });
});

describe('remoteImageDir / remoteImagePath: under the user\'s own home, never world-writable /tmp', () => {
    // This used to be `/tmp/open-remote-ssh-tmux-<uid>/images`, and the uid was documented as
    // the thing that stopped another account pre-creating the directory or planting a
    // symlink. It did not. The uid is public (`/etc/passwd`, `ps`), so the whole path is
    // guessable before the victim ever pastes, and `/tmp`'s sticky bit prevents DELETION,
    // not creation. Two working attacks on a shared box:
    //
    //   * `mkdir -m 777 -p /tmp/open-remote-ssh-tmux-1000/images` up front. `mkdir -p -m 700`
    //     applies its mode ONLY to directories it actually creates — on an existing one it is
    //     a silent no-op, no error, no chmod. Every screenshot then lands in an attacker-
    //     readable directory, and screenshots routinely carry tokens and session cookies.
    //   * `ln -s /home/victim/.ssh /tmp/open-remote-ssh-tmux-1000`. `mkdir -p` follows the
    //     symlink for intermediate components, so images are written inside the victim's
    //     directory and the 48h `find … -delete` sweep runs there too.
    //
    // `$HOME` is not world-writable, so neither attack has anywhere to stand. That also
    // removes the need to put a uid in the path at all.
    it('places the directory under the remote user\'s home, not /tmp', () => {
        expect(remoteImageDir('/home/alice')).toBe('/home/alice/.cache/open-remote-ssh-tmux/images');
        expect(remoteImageDir('/home/alice')).not.toContain('/tmp');
        expect(remoteImageDir('/home/alice')).not.toBe(remoteImageDir('/home/bob'));
    });

    it('tolerates a home path with a trailing slash (root\'s home is "/")', () => {
        expect(remoteImageDir('/')).toBe('/.cache/open-remote-ssh-tmux/images');
        expect(remoteImageDir('/home/alice/')).toBe('/home/alice/.cache/open-remote-ssh-tmux/images');
    });

    it('rejects a home path that is not absolute, or that could escape', () => {
        expect(() => remoteImageDir('relative/path')).toThrow();
        expect(() => remoteImageDir('')).toThrow();
        expect(() => remoteImageDir('/home/../etc')).toThrow();
        expect(() => remoteImageDir('/home/alice/..')).toThrow();
    });

    it('rejects a home path carrying a NUL or a newline', () => {
        expect(() => remoteImageDir('/home/a\0b')).toThrow();
        expect(() => remoteImageDir('/home/a\nb')).toThrow();
    });

    it('builds a .png path under the image dir from an injected id', () => {
        expect(remoteImagePath('/home/alice', 'ab12cd34'))
            .toBe('/home/alice/.cache/open-remote-ssh-tmux/images/ab12cd34.png');
    });

    it('rejects an id that is not plain hex/alphanumeric (no traversal, no spaces)', () => {
        expect(() => remoteImagePath('/home/alice', '../../../etc/passwd')).toThrow();
        expect(() => remoteImagePath('/home/alice', 'a;rm -rf /')).toThrow();
        expect(() => remoteImagePath('/home/alice', '')).toThrow();
    });
});

describe('buildRemoteMkdirCommand: 0700 before the first byte lands, and provably so', () => {
    // `vscode.workspace.fs.writeFile` cannot set a mode, so the directory must already be
    // private when the file is created — otherwise the image is briefly world-readable.
    it('creates the directory with mode 700', () => {
        const cmd = buildRemoteMkdirCommand('/home/alice/.cache/open-remote-ssh-tmux/images');
        expect(cmd).toContain('mkdir -p -m 700');
        expect(cmd).toContain('\'/home/alice/.cache/open-remote-ssh-tmux/images\'');
    });

    // `-m` is honoured only for directories mkdir actually CREATES. An existing directory
    // keeps whatever mode it already had, silently — so the mode has to be asserted, not
    // assumed, every time.
    it('also chmods an already-existing directory rather than trusting -m', () => {
        expect(buildRemoteMkdirCommand('/home/alice/x')).toContain('chmod 700');
    });

    // `SSHConnection#exec` surfaces no exit code — it resolves on channel close whatever the
    // command did. So a `mkdir` that failed (read-only home, a plain FILE already at that
    // path, no `mkdir` on a Windows remote) used to be indistinguishable from success, and
    // the upload proceeded straight into `writeFile` with only a generic error to show for
    // it. An explicit success marker on stdout is the only reliable signal available here.
    it('emits a success marker the caller can require on stdout', () => {
        expect(buildRemoteMkdirCommand('/home/alice/x')).toContain(MKDIR_OK_MARKER);
        // Chained with && so the marker cannot print unless every step succeeded.
        expect(buildRemoteMkdirCommand('/home/alice/x')).toMatch(/mkdir[^&]*&&[^&]*chmod[^&]*&&.*echo/);
    });

    it('quotes a path containing a single quote rather than breaking out of the command', () => {
        const cmd = buildRemoteMkdirCommand('/home/it\'s/images');
        expect(cmd).not.toMatch(/[^\\]'\/home\/it's/); // the inner quote is escaped, not raw
        expect(cmd.startsWith('mkdir -p -m 700 ')).toBe(true);
    });
});

describe('buildCleanupCommand: the 48h sweep', () => {
    // Same shape as the tmux session reaper: a connect-time sweep, conservative by
    // construction. Scoped with -maxdepth so it can never wander outside our own directory,
    // and restricted to regular .png files so a stray subdirectory is not deleted.
    it('deletes only regular .png files older than the given age, inside our dir only', () => {
        const cmd = buildCleanupCommand('/home/alice/.cache/open-remote-ssh-tmux/images', 48);
        expect(cmd).toContain('\'/home/alice/.cache/open-remote-ssh-tmux/images\'');
        expect(cmd).toContain('-maxdepth 1');
        expect(cmd).toContain('-type f');
        expect(cmd).toContain('-name \'*.png\'');
        expect(cmd).toContain('-mmin +2880'); // 48h in minutes
        expect(cmd).toContain('-delete');
    });

    it('converts hours to minutes for any age', () => {
        expect(buildCleanupCommand('/d', 1)).toContain('-mmin +60');
        expect(buildCleanupCommand('/d', 24)).toContain('-mmin +1440');
    });

    it('never emits a bare recursive delete', () => {
        const cmd = buildCleanupCommand('/home/alice/.cache/open-remote-ssh-tmux/images', 48);
        expect(cmd).not.toContain('rm -rf');
    });

    it('tolerates a missing directory instead of erroring on every connect', () => {
        // Nothing has been pasted yet on a fresh remote — that is the normal case, not a
        // failure worth a log line.
        expect(buildCleanupCommand('/d', 48)).toContain('2>/dev/null');
    });
});

describe('bracketedPaste: hand the path to a TUI as PASTED text, not typed', () => {
    // Claude Code and other full-screen TUIs treat typed input very differently from pasted
    // input: without the ESC[200~ / ESC[201~ wrapper a path can trigger autocomplete or be
    // submitted early on an embedded newline. tmux passes these sequences straight through.
    it('wraps the payload in the bracketed-paste markers', () => {
        expect(bracketedPaste('/tmp/x/ab.png')).toBe('\u001b[200~/tmp/x/ab.png\u001b[201~');
    });

    it('does not append a newline (the user decides when to submit)', () => {
        expect(bracketedPaste('/tmp/x/ab.png')).not.toContain('\n');
    });
});
