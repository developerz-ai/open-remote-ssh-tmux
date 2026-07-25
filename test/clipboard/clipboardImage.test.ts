import { describe, expect, it } from 'vitest';
import {
    buildCleanupCommand,
    buildLocalCaptureCandidates,
    buildRemoteMkdirCommand,
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

    it('offers a PowerShell reader on win32 that writes a PNG to the given path', () => {
        const [first] = buildLocalCaptureCandidates('win32', 'C:\\tmp\\shot.png');
        expect(first.argv[0]).toBe('powershell.exe');
        expect(first.output).toBe('file');
        const script = first.argv.join(' ');
        expect(script).toContain('C:\\tmp\\shot.png');
        // Must save as PNG explicitly — the default `Save(path)` overload picks an encoder
        // from nothing and can write a non-PNG payload under a .png name.
        expect(script).toContain('Png');
    });

    // `Get-Clipboard -Format Image` (the first shipped attempt) is the wrong API here: it
    // exists only in Windows PowerShell 5.x — removed from PowerShell 7 — and returns null
    // for clipboard contents that arrive as a DIB, which is what Win+Shift+S produces.
    // `[Windows.Forms.Clipboard]::GetImage()` handles both, but needs its assembly loaded
    // and an STA apartment, so both are stated explicitly rather than assumed.
    it('loads the Windows.Forms assembly, requests STA, and uses Clipboard::GetImage', () => {
        const [first] = buildLocalCaptureCandidates('win32', 'C:\\tmp\\shot.png');
        const script = first.argv.join(' ');
        expect(script).toContain('Add-Type');
        expect(script).toContain('System.Windows.Forms');
        expect(script).toContain('Clipboard]::GetImage()');
        expect(first.argv).toContain('-STA');
    });

    // PowerShell single-quoted strings escape a quote by doubling it. A username with an
    // apostrophe ("C:\Users\O'Brien\...") would otherwise terminate the string early and
    // turn the rest of the path into code.
    it('escapes single quotes in the output path', () => {
        const [first] = buildLocalCaptureCandidates('win32', 'C:\\Users\\O\'Brien\\shot.png');
        expect(first.argv.join(' ')).toContain('O\'\'Brien');
    });

    it('exits non-zero when the Windows clipboard holds no image', () => {
        const [first] = buildLocalCaptureCandidates('win32', 'C:\\tmp\\shot.png');
        expect(first.argv.join(' ')).toContain('exit 1');
    });

    it('uses pngpaste on darwin', () => {
        const [first] = buildLocalCaptureCandidates('darwin', '/tmp/shot.png');
        expect(first.argv[0]).toBe('pngpaste');
        expect(first.argv).toContain('/tmp/shot.png');
        expect(first.output).toBe('file');
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

describe('remoteImageDir / remoteImagePath: per-user, non-colliding, predictable', () => {
    // /tmp is world-writable, so a shared fixed path lets any other local user pre-create
    // (or symlink) the directory and read every screenshot we drop in it — screenshots
    // routinely contain tokens, session cookies and customer data. The remote user id goes
    // in the directory name for the same reason server-setup.sh moved its install lock out
    // of the shared $TMP_DIR.
    it('scopes the directory to the remote user', () => {
        expect(remoteImageDir('1001')).toBe('/tmp/open-remote-ssh-tmux-1001/images');
        expect(remoteImageDir('1001')).not.toBe(remoteImageDir('1002'));
    });

    it('rejects a user id that could escape the path', () => {
        expect(() => remoteImageDir('../../etc')).toThrow();
        expect(() => remoteImageDir('a b')).toThrow();
        expect(() => remoteImageDir('')).toThrow();
    });

    it('builds a .png path under the user dir from an injected id', () => {
        expect(remoteImagePath('1001', 'ab12cd34')).toBe('/tmp/open-remote-ssh-tmux-1001/images/ab12cd34.png');
    });

    it('rejects an id that is not plain hex/alphanumeric (no traversal, no spaces)', () => {
        expect(() => remoteImagePath('1001', '../../../etc/passwd')).toThrow();
        expect(() => remoteImagePath('1001', 'a;rm -rf /')).toThrow();
    });
});

describe('buildRemoteMkdirCommand: 0700 before the first byte lands', () => {
    // `vscode.workspace.fs.writeFile` cannot set a mode, so the directory must already be
    // private when the file is created — otherwise the image is briefly world-readable.
    it('creates the directory with mode 700', () => {
        const cmd = buildRemoteMkdirCommand('/tmp/open-remote-ssh-tmux-1001/images');
        expect(cmd).toContain('mkdir -p -m 700');
        expect(cmd).toContain('\'/tmp/open-remote-ssh-tmux-1001/images\'');
    });

    it('quotes a path containing a single quote rather than breaking out of the command', () => {
        const cmd = buildRemoteMkdirCommand('/tmp/it\'s/images');
        expect(cmd).not.toMatch(/[^\\]'\/tmp\/it's/); // the inner quote is escaped, not raw
        expect(cmd.startsWith('mkdir -p -m 700 ')).toBe(true);
    });
});

describe('buildCleanupCommand: the 48h sweep', () => {
    // Same shape as the tmux session reaper: a connect-time sweep, conservative by
    // construction. Scoped with -maxdepth so it can never wander outside our own directory,
    // and restricted to regular .png files so a stray subdirectory is not deleted.
    it('deletes only regular .png files older than the given age, inside our dir only', () => {
        const cmd = buildCleanupCommand('/tmp/open-remote-ssh-tmux-1001/images', 48);
        expect(cmd).toContain('\'/tmp/open-remote-ssh-tmux-1001/images\'');
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
        const cmd = buildCleanupCommand('/tmp/open-remote-ssh-tmux-1001/images', 48);
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
