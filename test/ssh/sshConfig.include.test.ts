import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// A *relative* Include pattern (e.g. `Include config.d/*`, or one starting
// with `~`) resolves against `path.dirname(defaultSSHConfigPath)` —
// `~/.ssh` — regardless of which config file is actually being parsed
// (`sshConfig.ts`'s `resolveIncludes`/`defaultSSHConfigPath`, computed from
// `os.homedir()` at module load). The other sshConfig tests dodge this by
// using absolute Include paths; these characterise the relative/`~` forms
// directly, so `os.homedir()` must be mocked *before* import (same pattern
// as `common/files.test.ts` and `identityFiles.defaults.test.ts`) to keep the
// suite off the real developer machine's `~/.ssh`.
let fakeHome: string;

vi.mock('os', async (importOriginal) => {
    const actual = await importOriginal<typeof import('os')>();
    return { ...actual, homedir: () => fakeHome };
});

describe('SSHConfiguration Include — relative / ~-prefixed patterns', () => {
    let sshDir: string;

    beforeEach(async () => {
        fakeHome = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ssh-config-include-test-'));
        sshDir = path.join(fakeHome, '.ssh');
        await fs.promises.mkdir(sshDir, { recursive: true });
        vi.resetModules();
    });

    afterEach(async () => {
        await fs.promises.rm(fakeHome, { recursive: true, force: true });
    });

    async function loadFromContent(content: string) {
        const configPath = path.join(sshDir, 'config');
        await fs.promises.writeFile(configPath, content);
        const { configOverrides } = await import('../mocks/vscode');
        configOverrides.set('remote.SSH.configFile', configPath);
        const { default: SSHConfiguration } = await import('../../src/ssh/sshConfig');
        return SSHConfiguration.loadFromFS();
    }

    it('resolves a bare relative glob pattern against ~/.ssh', async () => {
        const includeDir = path.join(sshDir, 'config.d');
        await fs.promises.mkdir(includeDir, { recursive: true });
        await fs.promises.writeFile(path.join(includeDir, 'a.conf'), 'Host relglob\n    HostName rel.example.com\n');

        const config = await loadFromContent('Include config.d/*\n');
        expect(config.getHostConfiguration('relglob')['HostName']).toBe('rel.example.com');
    });

    it('expands a "~/…" Include pattern to the fake home directory', async () => {
        const includeDir = path.join(sshDir, 'tilde.d');
        await fs.promises.mkdir(includeDir, { recursive: true });
        await fs.promises.writeFile(path.join(includeDir, 'a.conf'), 'Host tildehost\n    HostName tilde.example.com\n');

        const config = await loadFromContent('Include ~/.ssh/tilde.d/*\n');
        expect(config.getHostConfiguration('tildehost')['HostName']).toBe('tilde.example.com');
    });
});
