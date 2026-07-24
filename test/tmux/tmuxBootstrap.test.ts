import { describe, expect, it, vi } from 'vitest';
import { probeTmux } from '../../src/tmux/tmuxBootstrap';

// The capability probe is dependency-inverted: it takes an exec function (not an
// `SSHConnection`), so the whole gate is unit-testable here with no ssh2. It
// decides, per connection, whether tmux-backed terminals are available — Unix
// remote + a tmux binary new enough for the options the session model uses (floor
// 2.6). Anything else must degrade to plain upstream behaviour (hard requirement:
// never break the base SSH connect), so the Windows and no-tmux paths are the ones
// exercised most.

/** Exact remote command the probe issues — pinned so a change is visible (it runs
 * on the remote via a shell; this is security-relevant surface). Wrapped in
 * `sh -c '…'` so it runs under POSIX sh even when the remote login shell is
 * csh/tcsh (which choke on `command -v` and POSIX `&&`). */
const PROBE_COMMAND = `sh -c 'command -v tmux && tmux -V'`;

/** A canned exec that resolves with the given stdout (stderr empty). */
const execWith = (stdout: string) => vi.fn(async () => ({ stdout, stderr: '' }));

describe('probeTmux — available', () => {
    it('parses a found tmux (command -v path + version line) as available with its path', async () => {
        const exec = execWith('/usr/bin/tmux\ntmux 3.2a\n');
        expect(await probeTmux(exec)).toEqual({ available: true, version: '3.2a', path: '/usr/bin/tmux' });
    });

    it('accepts the 2.6 floor exactly', async () => {
        expect(await probeTmux(execWith('tmux 2.6'))).toEqual({ available: true, version: '2.6' });
    });

    it('accepts a newer major version', async () => {
        expect(await probeTmux(execWith('tmux 3.4'))).toEqual({ available: true, version: '3.4' });
    });

    it('issues exactly `command -v tmux && tmux -V`, once', async () => {
        const exec = execWith('tmux 3.2a');
        await probeTmux(exec);
        expect(exec).toHaveBeenCalledTimes(1);
        expect(exec).toHaveBeenCalledWith(PROBE_COMMAND);
    });
});

describe('probeTmux — not installed', () => {
    it('reports not-installed when `command -v` fails and short-circuits (no version line)', async () => {
        expect(await probeTmux(execWith(''))).toEqual({ available: false, reason: 'not-installed' });
    });

    it('reports not-installed when only the resolved path is present but no version', async () => {
        // Defensive: tmux resolved but `tmux -V` produced nothing usable.
        expect(await probeTmux(execWith('/usr/bin/tmux'))).toEqual({ available: false, reason: 'not-installed' });
    });

    it('degrades to not-installed if the probe channel errors (never breaks the connect)', async () => {
        const exec = vi.fn(async () => { throw new Error('channel closed'); });
        expect(await probeTmux(exec)).toEqual({ available: false, reason: 'not-installed' });
    });

    it('degrades (no throw) on a csh-style failure — error on stderr, empty stdout', async () => {
        // A csh/tcsh login shell that still choked on the probe: its complaint on
        // stderr, nothing usable on stdout. Must resolve unavailable, never throw.
        const exec = vi.fn(async () => ({ stdout: '', stderr: 'command: Command not found.' }));
        await expect(probeTmux(exec)).resolves.toEqual({ available: false, reason: 'not-installed' });
    });

    it('degrades when csh writes its error to stdout (no path, no version line)', async () => {
        const exec = execWith('command: Command not found.\ntmux: Command not found.');
        expect(await probeTmux(exec)).toEqual({ available: false, reason: 'not-installed' });
    });
});

describe('probeTmux — too old', () => {
    it('rejects a version below the 2.6 floor, keeping the reported version', async () => {
        expect(await probeTmux(execWith('tmux 2.1')))
            .toEqual({ available: false, version: '2.1', reason: 'too-old' });
    });

    it('rejects an ancient 1.x build', async () => {
        expect(await probeTmux(execWith('tmux 1.8')))
            .toEqual({ available: false, version: '1.8', reason: 'too-old' });
    });
});

describe('probeTmux — exotic build', () => {
    it('treats an unparseable version as available but version-unknown (does not punish exotic builds)', async () => {
        const result = await probeTmux(execWith('tmux master'));
        expect(result).toEqual({ available: true });
        expect(result.version).toBeUndefined();
    });

    it('still reports the resolved path for an exotic build with no comparable version', async () => {
        const exec = execWith('/opt/tmux/bin/tmux\ntmux master');
        expect(await probeTmux(exec)).toEqual({ available: true, path: '/opt/tmux/bin/tmux' });
    });
});

describe('probeTmux — resolved path', () => {
    it('captures the `command -v` path line alongside the version', async () => {
        const exec = execWith('/usr/local/bin/tmux\ntmux 3.4\n');
        expect(await probeTmux(exec)).toEqual({ available: true, version: '3.4', path: '/usr/local/bin/tmux' });
    });

    it('omits path when only the version line is present (no `command -v` line)', async () => {
        expect(await probeTmux(execWith('tmux 3.4'))).toEqual({ available: true, version: '3.4' });
    });

    it('does not mistake the `tmux <version>` line for a path (must be an absolute path)', async () => {
        const result = await probeTmux(execWith('tmux 3.2a'));
        expect(result.path).toBeUndefined();
    });
});

describe('probeTmux — version token edges', () => {
    it('accepts a lettered patch release (3.0a)', async () => {
        expect(await probeTmux(execWith('tmux 3.0a'))).toEqual({ available: true, version: '3.0a' });
    });

    it('accepts a double-digit major (10.0)', async () => {
        expect(await probeTmux(execWith('tmux 10.0'))).toEqual({ available: true, version: '10.0' });
    });

    it('accepts a prerelease token (next-3.4)', async () => {
        expect(await probeTmux(execWith('tmux next-3.4'))).toEqual({ available: true, version: 'next-3.4' });
    });
});

describe('probeTmux — platform gate', () => {
    it('short-circuits on a Windows remote without touching exec', async () => {
        const exec = execWith('tmux 3.2a');
        expect(await probeTmux(exec, 'windows')).toEqual({ available: false, reason: 'windows' });
        expect(exec).not.toHaveBeenCalled();
    });

    it('still probes when the platform is unlabelled (a Unix remote serverSetup left undefined)', async () => {
        const exec = execWith('tmux 3.2a');
        await probeTmux(exec, undefined);
        expect(exec).toHaveBeenCalledTimes(1);
    });

    it('probes an explicitly non-Windows platform', async () => {
        const exec = execWith('tmux 3.2a');
        await probeTmux(exec, 'linux');
        expect(exec).toHaveBeenCalledTimes(1);
    });
});
