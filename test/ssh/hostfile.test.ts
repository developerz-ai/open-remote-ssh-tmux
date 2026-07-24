import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { addHostToHostFile, checkNewHostInHostkeys } from '../../src/ssh/hostfile';

// Unit coverage for hostfile.ts — the sole owner of ~/.ssh/known_hosts reads and
// writes for host-key verification. Every test injects a temp known_hosts path so
// the real ~/.ssh is never touched; the injectable-path parameter exists for
// exactly this reason (the module hardcoded ~/.ssh/known_hosts, which blocked
// unit testing).

// Build a hashed (`|1|salt|hash`) known_hosts host field the same way OpenSSH and
// addHostToHostFile do, so the hashed-match path can be exercised deterministically.
function hashedLine(host: string, type = 'ssh-ed25519', key = 'AAAAC3NzaC1lZDI1NTE5'): string {
    const salt = crypto.randomBytes(20);
    const hash = crypto.createHmac('sha1', salt).update(host).digest();
    return `${'|1|'}${salt.toString('base64')}|${hash.toString('base64')} ${type} ${key}`;
}

describe('checkNewHostInHostkeys', () => {
    let tmpDir: string;

    afterEach(async () => {
        if (tmpDir) {
            await fs.promises.rm(tmpDir, { recursive: true, force: true });
        }
    });

    async function withKnownHosts(content: string): Promise<string> {
        tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hostfile-test-'));
        const knownHosts = path.join(tmpDir, 'known_hosts');
        await fs.promises.writeFile(knownHosts, content);
        return knownHosts;
    }

    it('reports a hashed entry for the same host as known', async () => {
        const file = await withKnownHosts(hashedLine('example.com') + '\n');
        expect(await checkNewHostInHostkeys('example.com', file)).toBe(false);
    });

    it('reports a hashed entry for a different host as new', async () => {
        const file = await withKnownHosts(hashedLine('other.com') + '\n');
        expect(await checkNewHostInHostkeys('example.com', file)).toBe(true);
    });

    it('matches a plaintext (unhashed) hostname entry — pins the |1|-only bug', async () => {
        const file = await withKnownHosts('example.com ssh-ed25519 AAAAKEY\n');
        expect(await checkNewHostInHostkeys('example.com', file)).toBe(false);
    });

    it('matches a [host]:port entry for that exact port', async () => {
        const file = await withKnownHosts('[example.com]:2222 ssh-ed25519 AAAAKEY\n');
        expect(await checkNewHostInHostkeys('[example.com]:2222', file)).toBe(false);
    });

    it('does not match a [host]:port entry against the bare host or a different port', async () => {
        const file = await withKnownHosts('[example.com]:2222 ssh-ed25519 AAAAKEY\n');
        expect(await checkNewHostInHostkeys('example.com', file)).toBe(true);
        expect(await checkNewHostInHostkeys('[example.com]:2200', file)).toBe(true);
    });

    it('matches any host in a comma-separated host list', async () => {
        const file = await withKnownHosts('a.com,b.com ssh-ed25519 AAAAKEY\n');
        expect(await checkNewHostInHostkeys('a.com', file)).toBe(false);
        expect(await checkNewHostInHostkeys('b.com', file)).toBe(false);
        expect(await checkNewHostInHostkeys('c.com', file)).toBe(true);
    });

    it('ignores blank, comment and malformed lines without throwing', async () => {
        const file = await withKnownHosts([
            '',
            '# a comment',
            '   ',
            'garbage-with-no-key-fields',
            '|1|truncated-hashed-entry',
            'example.com ssh-ed25519 AAAAKEY',
        ].join('\n'));
        expect(await checkNewHostInHostkeys('example.com', file)).toBe(false);
        expect(await checkNewHostInHostkeys('nope.com', file)).toBe(true);
    });

    it('treats a missing known_hosts file as "host is new" (fresh machine)', async () => {
        tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hostfile-test-'));
        const missing = path.join(tmpDir, 'no-such-dir', 'known_hosts');
        expect(await checkNewHostInHostkeys('example.com', missing)).toBe(true);
    });
});

describe('addHostToHostFile', () => {
    let tmpDir: string;

    afterEach(async () => {
        if (tmpDir) {
            await fs.promises.rm(tmpDir, { recursive: true, force: true });
        }
    });

    it('round-trips: an added host is then reported as known, others stay new', async () => {
        tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hostfile-test-'));
        const file = path.join(tmpDir, 'known_hosts');
        await addHostToHostFile('example.com', Buffer.from('the-key-bytes'), 'ssh-ed25519', file);
        expect(await checkNewHostInHostkeys('example.com', file)).toBe(false);
        expect(await checkNewHostInHostkeys('other.com', file)).toBe(true);
    });

    it('creates a missing parent directory (0700) instead of failing with ENOENT', async () => {
        tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hostfile-test-'));
        const sshDir = path.join(tmpDir, 'nested', '.ssh');
        const file = path.join(sshDir, 'known_hosts');
        await addHostToHostFile('example.com', Buffer.from('the-key-bytes'), 'ssh-ed25519', file);

        const stat = await fs.promises.stat(sshDir);
        expect(stat.isDirectory()).toBe(true);
        if (process.platform !== 'win32') {
            expect(stat.mode & 0o777).toBe(0o700);
        }
        expect(await checkNewHostInHostkeys('example.com', file)).toBe(false);
    });
});
