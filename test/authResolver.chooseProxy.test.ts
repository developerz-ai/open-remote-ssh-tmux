import SSHConfig from 'ssh-config';
import { describe, expect, it } from 'vitest';
import { chooseProxy, hostKeyAlgorithms } from '../src/authResolver';

// ssh_config(5): ProxyJump "will compete with the ProxyCommand option - whichever is
// specified first will prevent later instances of the other from taking effect", and
// `none` counts as specified. The resolver always tried ProxyJump first and fell
// through to ProxyCommand when it was `none`, so
//
//     Host direct
//         ProxyJump none
//     Host *
//         ProxyCommand corp-proxy %h %p
//
// went through corp-proxy, and a host with its own ProxyCommand under a wildcard
// ProxyJump went through the jump host.
describe('chooseProxy', () => {
    it('uses no proxy when neither is set', () => {
        expect(chooseProxy({ HostName: 'x' })).toEqual({ kind: 'none' });
    });

    it('uses the only one that is set', () => {
        expect(chooseProxy({ ProxyJump: 'bastion' })).toEqual({ kind: 'jump', value: 'bastion' });
        expect(chooseProxy({ ProxyCommand: 'nc %h %p' })).toEqual({ kind: 'command', value: 'nc %h %p' });
    });

    it('lets a ProxyCommand specified first beat a later ProxyJump', () => {
        expect(chooseProxy({ ProxyCommand: 'nc %h %p', ProxyJump: 'bastion' })).toEqual({ kind: 'command', value: 'nc %h %p' });
    });

    it('lets a ProxyJump specified first beat a later ProxyCommand', () => {
        expect(chooseProxy({ ProxyJump: 'bastion', ProxyCommand: 'nc %h %p' })).toEqual({ kind: 'jump', value: 'bastion' });
    });

    it('lets `none` specified first cancel the other one too', () => {
        expect(chooseProxy({ ProxyJump: 'none', ProxyCommand: 'nc %h %p' })).toEqual({ kind: 'none' });
        expect(chooseProxy({ ProxyCommand: 'NONE', ProxyJump: 'bastion' })).toEqual({ kind: 'none' });
    });

    it('skips a blank value, which specifies nothing', () => {
        expect(chooseProxy({ ProxyJump: '  ', ProxyCommand: 'nc %h %p' })).toEqual({ kind: 'command', value: 'nc %h %p' });
    });

    it('passes an array-shaped ProxyCommand through', () => {
        expect(chooseProxy({ ProxyCommand: ['nc', '%h', '%p'] })).toEqual({ kind: 'command', value: ['nc', '%h', '%p'] });
    });

    // The rule above leans on ssh-config's `compute()` listing keys in the order it
    // first saw them. Pinned here so an ssh-config upgrade that changes it fails loudly.
    it('agrees with what ssh-config computes for a real config', () => {
        const direct = SSHConfig.parse('Host direct\n  ProxyJump none\nHost *\n  ProxyCommand corp-proxy %h %p\n').compute('direct');
        expect(chooseProxy(direct)).toEqual({ kind: 'none' });

        const own = SSHConfig.parse('Host own\n  ProxyCommand mine %h\nHost *\n  ProxyJump bastion\n').compute('own');
        expect(chooseProxy(own)).toEqual({ kind: 'command', value: 'mine %h' });

        const jump = SSHConfig.parse('Host j\n  ProxyJump bastion\nHost *\n  ProxyCommand corp-proxy %h %p\n').compute('j');
        expect(chooseProxy(jump)).toEqual({ kind: 'jump', value: 'bastion' });
    });
});

// The key types on file for a host (`serverHostKeyPreference`, hostfile.ts) as ssh2
// connect config. It must only ever reorder: the set ssh2 ends up offering stays exactly its default.
describe('hostKeyAlgorithms', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { generateAlgorithmList } = require('ssh2/lib/utils') as { generateAlgorithmList(list: unknown, defaults: string[], supported: string[]): string[] };
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { DEFAULT_SERVER_HOST_KEY, SUPPORTED_SERVER_HOST_KEY } = require('ssh2/lib/protocol/constants') as { DEFAULT_SERVER_HOST_KEY: string[]; SUPPORTED_SERVER_HOST_KEY: string[] };

    it('adds nothing when no key type is on file', () => {
        expect(hostKeyAlgorithms([])).toEqual({});
    });

    it('moves the preferred algorithms to the front of ssh2\'s default list', () => {
        const offered = generateAlgorithmList(hostKeyAlgorithms(['ssh-rsa']).algorithms?.serverHostKey, DEFAULT_SERVER_HOST_KEY, SUPPORTED_SERVER_HOST_KEY);

        expect(offered.slice(0, 3)).toEqual(['rsa-sha2-512', 'rsa-sha2-256', 'ssh-rsa']);
        expect([...offered].sort()).toEqual([...DEFAULT_SERVER_HOST_KEY].sort());
    });

    it('cannot make ssh2 offer an algorithm outside its default list', () => {
        const offered = generateAlgorithmList(hostKeyAlgorithms(['ssh-dss', 'ecdsa-sha2-nistp256']).algorithms?.serverHostKey, DEFAULT_SERVER_HOST_KEY, SUPPORTED_SERVER_HOST_KEY);

        expect(offered).not.toContain('ssh-dss');
        expect(offered[0]).toBe('ecdsa-sha2-nistp256');
        expect([...offered].sort()).toEqual([...DEFAULT_SERVER_HOST_KEY].sort());
    });
});
