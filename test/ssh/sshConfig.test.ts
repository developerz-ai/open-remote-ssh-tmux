import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import SSHConfig from 'ssh-config';
import { afterEach, describe, expect, it } from 'vitest';
import { configOverrides } from '../mocks/vscode';
import SSHConfiguration from '../../src/ssh/sshConfig';

// Characterisation tests for SSHConfiguration, built directly from a parsed
// SSHConfig (bypassing loadFromFS's filesystem/glob I/O, which needs its own
// integration coverage). Exercises: per-host lookup, "Host" pattern matching
// (including wildcard precedence, which ssh-config's own `compute()` resolves
// per OpenSSH rules — first-seen value wins), and the configured-hosts listing
// that filters out patterns.
describe('SSHConfiguration#getHostConfiguration', () => {
    it('returns directive values for an exact Host match', () => {
        const config = new SSHConfiguration(SSHConfig.parse(
            'Host foo\n    HostName foo.example.com\n    User bob\n    Port 2222\n'
        ));
        const hostConfig = config.getHostConfiguration('foo');
        expect(hostConfig['HostName']).toBe('foo.example.com');
        expect(hostConfig['User']).toBe('bob');
        expect(hostConfig['Port']).toBe('2222');
    });

    it('returns an empty configuration for a host with no matching section', () => {
        const config = new SSHConfiguration(SSHConfig.parse('Host foo\n    HostName foo.example.com\n'));
        const hostConfig = config.getHostConfiguration('bar');
        expect(hostConfig['HostName']).toBeUndefined();
    });

    it('a wildcard Host contributes to any matching hostname', () => {
        const config = new SSHConfiguration(SSHConfig.parse('Host *\n    User globaluser\n'));
        expect(config.getHostConfiguration('anything.example.com')['User']).toBe('globaluser');
    });

    it('an earlier, more specific Host block wins over a later wildcard for the same key', () => {
        const config = new SSHConfiguration(SSHConfig.parse(
            'Host foo\n    User specific\n\nHost *\n    User globaluser\n'
        ));
        expect(config.getHostConfiguration('foo')['User']).toBe('specific');
    });

    it('a later wildcard fills in a key the earlier specific block did not set', () => {
        const config = new SSHConfiguration(SSHConfig.parse(
            'Host foo\n    User specific\n\nHost *\n    Port 2200\n'
        ));
        const hostConfig = config.getHostConfiguration('foo');
        expect(hostConfig['User']).toBe('specific');
        expect(hostConfig['Port']).toBe('2200');
    });

    // Directive-name normalization (lowercase source -> canonical casing, e.g.
    // "hostname" -> "HostName") happens in `normalizeSSHConfig`, a private helper
    // only wired up on the `loadFromFS` path — constructing SSHConfiguration
    // directly from `SSHConfig.parse()` (as above) bypasses it entirely and
    // `compute()` then returns whatever casing the source used. See the
    // `SSHConfiguration.loadFromFS` describe block below for that behaviour.
});

describe('SSHConfiguration.loadFromFS', () => {
    let tmpDir: string;

    afterEach(async () => {
        configOverrides.clear();
        if (tmpDir) {
            await fs.promises.rm(tmpDir, { recursive: true, force: true });
        }
    });

    async function loadFromContent(content: string): Promise<SSHConfiguration> {
        tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ssh-config-test-'));
        const configPath = path.join(tmpDir, 'config');
        await fs.promises.writeFile(configPath, content);
        configOverrides.set('remote.SSH.configFile', configPath);
        return SSHConfiguration.loadFromFS();
    }

    it('normalizes lowercase directive names to their canonical casing', async () => {
        const config = await loadFromContent('host foo\n    hostname foo.example.com\n    proxyjump bastion\n');
        const hostConfig = config.getHostConfiguration('foo');
        expect(hostConfig['HostName']).toBe('foo.example.com');
        expect(hostConfig['ProxyJump']).toBe('bastion');
    });

    it('inlines an Include directive\'s matched files in place', async () => {
        tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ssh-config-test-'));
        const includedPath = path.join(tmpDir, 'included.conf');
        await fs.promises.writeFile(includedPath, 'Host included-host\n    HostName included.example.com\n');
        const configPath = path.join(tmpDir, 'config');
        await fs.promises.writeFile(configPath, `Include ${includedPath}\nHost foo\n    HostName foo.example.com\n`);
        configOverrides.set('remote.SSH.configFile', configPath);

        const config = await SSHConfiguration.loadFromFS();
        expect(config.getHostConfiguration('included-host')['HostName']).toBe('included.example.com');
        expect(config.getHostConfiguration('foo')['HostName']).toBe('foo.example.com');
    });

    it('returns an empty configuration when the configured file does not exist', async () => {
        tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ssh-config-test-'));
        configOverrides.set('remote.SSH.configFile', path.join(tmpDir, 'does-not-exist'));

        const config = await SSHConfiguration.loadFromFS();
        expect(config.getAllConfiguredHosts()).toEqual([]);
    });

    // A self-including or mutually-including config previously recursed forever
    // (each Include re-parsed and re-expanded the same file endlessly), hanging
    // the resolver. Both must terminate and still yield the directives that were
    // reachable before the cycle was cut off.
    it('terminates and still resolves when a config includes itself', async () => {
        tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ssh-config-test-'));
        const configPath = path.join(tmpDir, 'config');
        await fs.promises.writeFile(configPath, `Include ${configPath}\nHost foo\n    HostName foo.example.com\n`);
        configOverrides.set('remote.SSH.configFile', configPath);

        const config = await SSHConfiguration.loadFromFS();
        expect(config.getHostConfiguration('foo')['HostName']).toBe('foo.example.com');
    });

    it('terminates and still resolves when two configs mutually include each other', async () => {
        tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ssh-config-test-'));
        const configPath = path.join(tmpDir, 'config');
        const otherPath = path.join(tmpDir, 'other.conf');
        await fs.promises.writeFile(configPath, `Include ${otherPath}\nHost foo\n    HostName foo.example.com\n`);
        await fs.promises.writeFile(otherPath, `Include ${configPath}\nHost bar\n    HostName bar.example.com\n`);
        configOverrides.set('remote.SSH.configFile', configPath);

        const config = await SSHConfiguration.loadFromFS();
        expect(config.getHostConfiguration('foo')['HostName']).toBe('foo.example.com');
        expect(config.getHostConfiguration('bar')['HostName']).toBe('bar.example.com');
    });

    it('applies an Include directive nested inside a Host block', async () => {
        tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ssh-config-test-'));
        const includedPath = path.join(tmpDir, 'included.conf');
        await fs.promises.writeFile(includedPath, 'HostName included.example.com\n    User included-user\n');
        const configPath = path.join(tmpDir, 'config');
        await fs.promises.writeFile(configPath, `Host foo\n    Include ${includedPath}\n    Port 2222\n`);
        configOverrides.set('remote.SSH.configFile', configPath);

        const config = await SSHConfiguration.loadFromFS();
        const hostConfig = config.getHostConfiguration('foo');
        expect(hostConfig['HostName']).toBe('included.example.com');
        expect(hostConfig['User']).toBe('included-user');
        expect(hostConfig['Port']).toBe('2222');
    });
});

describe('SSHConfiguration#getAllConfiguredHosts', () => {
    it('lists concrete Host entries', () => {
        const config = new SSHConfiguration(SSHConfig.parse('Host foo\n    HostName foo.example.com\n\nHost bar\n    HostName bar.example.com\n'));
        expect(config.getAllConfiguredHosts()).toEqual(['foo', 'bar']);
    });

    it('excludes wildcard/pattern and negated Host entries', () => {
        const config = new SSHConfiguration(SSHConfig.parse(
            'Host foo\n    HostName foo.example.com\n\nHost *\n    User globaluser\n\nHost !excluded\n    HostName excluded.example.com\n'
        ));
        expect(config.getAllConfiguredHosts()).toEqual(['foo']);
    });

    it('deduplicates a Host name that appears in more than one section', () => {
        const config = new SSHConfiguration(SSHConfig.parse('Host foo\n    User a\n\nHost foo\n    Port 22\n'));
        expect(config.getAllConfiguredHosts()).toEqual(['foo']);
    });

    it('lists every name in a multi-value "Host dev staging" line, not just the first', () => {
        const config = new SSHConfiguration(SSHConfig.parse('Host dev staging\n    User shared\n'));
        expect(config.getAllConfiguredHosts()).toEqual(['dev', 'staging']);
    });

    it('filters pattern names out of a multi-value Host line while keeping concrete ones', () => {
        const config = new SSHConfiguration(SSHConfig.parse('Host dev *.internal !excluded\n    User shared\n'));
        expect(config.getAllConfiguredHosts()).toEqual(['dev']);
    });
});
