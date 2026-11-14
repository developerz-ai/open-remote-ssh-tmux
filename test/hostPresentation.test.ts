import { describe, expect, it } from 'vitest';
import { connectedDestination, folderItemLook, hostAddress, hostItemLook, isConnectedFolder, isConnectedHost } from '../src/hostPresentation';
import SSHDestination from '../src/ssh/sshDestination';

// What "SSH Targets" and the Connect quick pick show about a host: which one this window is
// connected to (derived from the window's remote authority), and the address it resolves to
// through the SSH config. Pure, so the tree and the pick stay thin mappings.

const authorityFor = (dest: string): string => `ssh-remote+${SSHDestination.parse(dest).toEncodedString()}`;

describe('connectedDestination', () => {
    it('is undefined in a local window', () => {
        expect(connectedDestination(undefined)).toBeUndefined();
    });

    it('decodes this extension\'s authority, upper-case letters included', () => {
        const dest = connectedDestination(authorityFor('Me@Dev-Box:2222'));
        expect(dest?.hostname).toBe('Dev-Box');
        expect(dest?.user).toBe('Me');
        expect(dest?.port).toBe(2222);
    });

    it('ignores another remote type, even one sharing the prefix', () => {
        expect(connectedDestination('wsl+Ubuntu')).toBeUndefined();
        expect(connectedDestination('ssh-remote2+host')).toBeUndefined();
    });

    it('ignores an authority with no usable host', () => {
        expect(connectedDestination('ssh-remote+')).toBeUndefined();
    });
});

describe('isConnectedHost', () => {
    const connected = connectedDestination(authorityFor('dev'));

    it('matches the host this window is connected to', () => {
        expect(isConnectedHost('dev', connected)).toBe(true);
    });

    it('matches on hostname whatever user/port the connection used', () => {
        expect(isConnectedHost('dev', connectedDestination(authorityFor('me@dev:2222')))).toBe(true);
    });

    it('does not match another host, or anything in a local window', () => {
        expect(isConnectedHost('staging', connected)).toBe(false);
        expect(isConnectedHost('dev', undefined)).toBe(false);
    });
});

describe('isConnectedFolder', () => {
    it('matches the folder open in this window on that host', () => {
        expect(isConnectedFolder('dev', '/home/me/app', ['dev', '/home/me/app'])).toBe(true);
    });

    it('does not match a sibling folder, the same path on another host, or no workspace', () => {
        expect(isConnectedFolder('dev', '/home/me/other', ['dev', '/home/me/app'])).toBe(false);
        expect(isConnectedFolder('staging', '/home/me/app', ['dev', '/home/me/app'])).toBe(false);
        expect(isConnectedFolder('dev', '/home/me/app', undefined)).toBe(false);
    });
});

describe('hostAddress', () => {
    it('shows user@hostname:port from the SSH config', () => {
        expect(hostAddress('dev', { HostName: 'dev.example.com', User: 'john', Port: '2222' })).toBe('john@dev.example.com:2222');
    });

    it('falls back to the alias when the config names no HostName, and omits what is unset', () => {
        expect(hostAddress('dev', {})).toBe('dev');
        expect(hostAddress('dev', { User: 'john' })).toBe('john@dev');
    });

    it('prefers what the destination itself spells out over the config', () => {
        expect(hostAddress('me@dev:22', { HostName: 'dev.example.com', User: 'john', Port: '2222' })).toBe('me@dev.example.com:22');
    });

    it('ignores a non-numeric Port and non-string values', () => {
        expect(hostAddress('dev', { Port: 'ssh', User: ['a', 'b'] })).toBe('dev');
    });

    it('brackets an IPv6 HostName so the address stays unambiguous', () => {
        expect(hostAddress('v6', { HostName: '::1', Port: '22' })).toBe('[::1]:22');
    });
});

describe('item looks', () => {
    it('marks the connected host', () => {
        expect(hostItemLook(true)).toEqual({ icon: 'vm-active', description: 'connected' });
        expect(hostItemLook(false)).toEqual({ icon: 'vm', description: undefined });
    });

    it('marks the connected folder and keeps its parent directory', () => {
        expect(folderItemLook('/home/me', true)).toEqual({ icon: 'folder-opened', description: '/home/me · connected' });
        expect(folderItemLook('/home/me', false)).toEqual({ icon: 'folder', description: '/home/me' });
    });
});
