import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { addHostToHostFile, checkNewHostInHostkeys, hostKeyFingerprint, hostKeyIdentity, verifyHostKey, verifyKnownHost } from '../../src/ssh/hostfile';

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

    it('does not treat a @revoked or @cert-authority record as a recorded host key', async () => {
        // Neither marker records "this is the host's key": @revoked says the opposite,
        // and a CA line holds the CA's key, not the host's. So the host is still new.
        const file = await withKnownHosts([
            '@revoked revoked.com ssh-ed25519 AAAAKEY',
            '@cert-authority ca.com ssh-ed25519 AAAAKEY',
        ].join('\n') + '\n');
        expect(await checkNewHostInHostkeys('revoked.com', file)).toBe(true);
        expect(await checkNewHostInHostkeys('ca.com', file)).toBe(true);
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

    it('separates the new record from a file with no trailing newline (no glued line)', async () => {
        // A known_hosts whose last line has no '\n' is legal (OpenSSH's own hostfile.c
        // guards against exactly this on append). Without the guard the new record is
        // glued onto the old one, which both hides the new host *and* corrupts the
        // pre-existing entry's key field → that host then reads as 'mismatch' forever.
        tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hostfile-test-'));
        const file = path.join(tmpDir, 'known_hosts');
        const oldKey = Buffer.from('the-old-host-key');
        await fs.promises.writeFile(file, `old.example ssh-ed25519 ${oldKey.toString('base64')}`);

        await addHostToHostFile('new.example', Buffer.from('the-new-host-key'), 'ssh-ed25519', file);

        const content = await fs.promises.readFile(file, 'utf8');
        expect(content.split('\n').filter((l) => l.trim()).length).toBe(2);
        expect(content.startsWith(`old.example ssh-ed25519 ${oldKey.toString('base64')}\n`)).toBe(true);
        // The untouched neighbour still verifies, and the new host is now on file.
        expect(verifyHostKey('old.example', oldKey, content)).toBe('known');
        expect(await checkNewHostInHostkeys('new.example', file)).toBe(false);
    });

    it('does not insert a blank line when the file already ends in a newline', async () => {
        tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hostfile-test-'));
        const file = path.join(tmpDir, 'known_hosts');
        await fs.promises.writeFile(file, 'old.example ssh-ed25519 AAAAOLD\n');

        await addHostToHostFile('new.example', Buffer.from('the-new-host-key'), 'ssh-ed25519', file);

        expect(await fs.promises.readFile(file, 'utf8')).not.toContain('\n\n');
    });

    it('does not start a brand-new or empty known_hosts with a blank line', async () => {
        tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hostfile-test-'));
        const created = path.join(tmpDir, 'created', 'known_hosts');
        const empty = path.join(tmpDir, 'known_hosts');
        await fs.promises.writeFile(empty, '');

        await addHostToHostFile('a.example', Buffer.from('key-bytes'), 'ssh-ed25519', created);
        await addHostToHostFile('b.example', Buffer.from('key-bytes'), 'ssh-ed25519', empty);

        expect((await fs.promises.readFile(created, 'utf8')).startsWith('\n')).toBe(false);
        expect((await fs.promises.readFile(empty, 'utf8')).startsWith('\n')).toBe(false);
    });
});

// Build a known_hosts record whose key blob is `key`, in either the hashed
// (`|1|salt|hash`) or plaintext host form, so verifyHostKey's byte-comparison
// path can be exercised deterministically. The base64 key field is exactly
// `key.toString('base64')` — the same encoding addHostToHostFile writes.
function khLine(host: string, key: Buffer, hashed = false, type = 'ssh-ed25519'): string {
    const keyB64 = key.toString('base64');
    if (hashed) {
        const salt = crypto.randomBytes(20);
        const hash = crypto.createHmac('sha1', salt).update(host).digest();
        return `${'|1|'}${salt.toString('base64')}|${hash.toString('base64')} ${type} ${keyB64}`;
    }
    return `${host} ${type} ${keyB64}`;
}

describe('verifyHostKey', () => {
    const keyA = Buffer.from('key-alpha-bytes');
    const keyB = Buffer.from('key-bravo-bytes');

    it('reports the same key bytes on a hashed entry as known', () => {
        expect(verifyHostKey('example.com', keyA, khLine('example.com', keyA, true) + '\n')).toBe('known');
    });

    it('reports the same key bytes on a plaintext entry as known', () => {
        expect(verifyHostKey('example.com', keyA, khLine('example.com', keyA) + '\n')).toBe('known');
    });

    it('reports a different key for a known (hashed) host as mismatch', () => {
        expect(verifyHostKey('example.com', keyB, khLine('example.com', keyA, true) + '\n')).toBe('mismatch');
    });

    it('reports a different key for a known (plaintext) host as mismatch', () => {
        expect(verifyHostKey('example.com', keyB, khLine('example.com', keyA) + '\n')).toBe('mismatch');
    });

    it('reports an unseen host as unknown', () => {
        expect(verifyHostKey('example.com', keyA, khLine('other.com', keyA) + '\n')).toBe('unknown');
    });

    it('reports empty known_hosts content as unknown', () => {
        expect(verifyHostKey('example.com', keyA, '')).toBe('unknown');
    });

    it('matches a [host]:port entry only for that exact port form', () => {
        const content = khLine('[example.com]:2222', keyA) + '\n';
        expect(verifyHostKey('[example.com]:2222', keyA, content)).toBe('known');
        expect(verifyHostKey('[example.com]:2222', keyB, content)).toBe('mismatch');
        // the bare host is a different identity → not seen on file
        expect(verifyHostKey('example.com', keyA, content)).toBe('unknown');
    });

    it('matches any host in a comma-separated host list', () => {
        const content = khLine('a.com,b.com', keyA) + '\n';
        expect(verifyHostKey('a.com', keyA, content)).toBe('known');
        expect(verifyHostKey('b.com', keyB, content)).toBe('mismatch');
        expect(verifyHostKey('c.com', keyA, content)).toBe('unknown');
    });

    it('accepts any one recorded key for a host with multiple keys', () => {
        // A host legitimately publishes several host keys (e.g. rsa + ed25519);
        // presenting any recorded one is known, an unrecorded one is a mismatch.
        const content = [khLine('h.com', keyA), khLine('h.com', keyB, true)].join('\n');
        expect(verifyHostKey('h.com', keyA, content)).toBe('known');
        expect(verifyHostKey('h.com', keyB, content)).toBe('known');
        expect(verifyHostKey('h.com', Buffer.from('key-charlie'), content)).toBe('mismatch');
    });

    it('ignores blank, comment and malformed lines and still decides', () => {
        const content = [
            '',
            '# a comment',
            '   ',
            'garbage-with-no-key-fields',
            '|1|truncated-hashed-entry',
            khLine('example.com', keyA),
        ].join('\n');
        expect(verifyHostKey('example.com', keyA, content)).toBe('known');
        expect(verifyHostKey('example.com', keyB, content)).toBe('mismatch');
        expect(verifyHostKey('nope.com', keyA, content)).toBe('unknown');
    });

    it('ignores a host-matching line that carries no key blob (no false mismatch)', () => {
        // A malformed host-only record must not flip a first connect into a hard
        // mismatch failure — it is not a valid recorded key.
        expect(verifyHostKey('example.com', keyA, 'example.com\n')).toBe('unknown');
    });

    it('hard-refuses a key an admin marked @revoked, plaintext or hashed', () => {
        // OpenSSH never accepts a revoked key — before this the marker made fields[0]
        // '@revoked', so the host never matched and the user got the ordinary
        // first-connect prompt for a key that was explicitly revoked.
        expect(verifyHostKey('example.com', keyA, `@revoked ${khLine('example.com', keyA)}\n`)).toBe('revoked');
        expect(verifyHostKey('example.com', keyA, `@revoked ${khLine('example.com', keyA, true)}\n`)).toBe('revoked');
    });

    it('lets a revocation win over an ordinary entry for the same key, in either order', () => {
        const revoked = `@revoked ${khLine('example.com', keyA)}`;
        const trusted = khLine('example.com', keyA);
        expect(verifyHostKey('example.com', keyA, [trusted, revoked].join('\n'))).toBe('revoked');
        expect(verifyHostKey('example.com', keyA, [revoked, trusted].join('\n'))).toBe('revoked');
    });

    it('does not let a revocation of some other key affect this one', () => {
        // Revoking the host's *old* key says nothing about the key it presents now:
        // it must not read as a recorded key (mismatch) — that would be a hard fail
        // with no override for a host whose new key is simply not on file yet.
        const revokedOther = `@revoked ${khLine('example.com', keyB)}`;
        expect(verifyHostKey('example.com', keyA, revokedOther + '\n')).toBe('unknown');
        expect(verifyHostKey('example.com', keyA, [revokedOther, khLine('example.com', keyA)].join('\n'))).toBe('known');
    });

    it('never treats a @cert-authority line as the host key itself', () => {
        // The blob on a CA line is the CA's key, not the host's; we do not implement
        // certificate verification, so such a line is neither a match nor evidence
        // that the host is on file.
        const ca = `@cert-authority ${khLine('example.com', keyA)}`;
        expect(verifyHostKey('example.com', keyA, ca + '\n')).toBe('unknown');
        expect(verifyHostKey('example.com', keyB, ca + '\n')).toBe('unknown');
    });

    it('ignores a line with an unrecognised @marker', () => {
        expect(verifyHostKey('example.com', keyA, `@bogus ${khLine('example.com', keyA)}\n`)).toBe('unknown');
    });

    it('finds the host among multiple valid entries', () => {
        const content = [
            khLine('other.com', keyB),
            khLine('example.com', keyA, true),
            '# trailing comment',
        ].join('\n');
        expect(verifyHostKey('example.com', keyA, content)).toBe('known');
    });
});

describe('hostKeyIdentity', () => {
    it('uses the bare hostname on the default SSH port', () => {
        expect(hostKeyIdentity('example.com', 22)).toBe('example.com');
    });

    it('uses OpenSSH [host]:port form for a non-default port', () => {
        expect(hostKeyIdentity('example.com', 2222)).toBe('[example.com]:2222');
    });

    it('treats a missing/zero port as the default (bare host, no brackets)', () => {
        expect(hostKeyIdentity('example.com', 0)).toBe('example.com');
    });
});

describe('hostKeyFingerprint', () => {
    it('formats an unpadded SHA256 base64 fingerprint with the SHA256: prefix', () => {
        const key = Buffer.from('some-host-key-bytes');
        const expected = `SHA256:${crypto.createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`;
        const fingerprint = hostKeyFingerprint(key);
        expect(fingerprint).toBe(expected);
        expect(fingerprint.startsWith('SHA256:')).toBe(true);
        expect(fingerprint.endsWith('=')).toBe(false);
    });

    it('produces different fingerprints for different keys', () => {
        expect(hostKeyFingerprint(Buffer.from('key-one'))).not.toBe(hostKeyFingerprint(Buffer.from('key-two')));
    });
});

// Build an SSH wire-format host-key blob: a uint32-length-prefixed algorithm name
// followed by the key payload — the exact shape ssh2 hands the hostVerifier, so
// the recorded known_hosts line gets a real field-2 type and re-verification works.
function wireHostKey(type: string, payload: string): Buffer {
    const typeBuf = Buffer.from(type, 'ascii');
    const len = Buffer.alloc(4);
    len.writeUInt32BE(typeBuf.length, 0);
    return Buffer.concat([len, typeBuf, Buffer.from(payload)]);
}

describe('verifyKnownHost', () => {
    const keyA = wireHostKey('ssh-ed25519', 'alpha-key-payload');
    const keyB = wireHostKey('ssh-ed25519', 'bravo-key-payload');
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

    // A prompt spy that records its args and answers with a fixed decision, so the
    // orchestration can be driven without any vscode UI (the prompt is injected).
    function spyPrompt(answer: boolean) {
        const calls: Array<{ host: string; fingerprint: string }> = [];
        return {
            calls,
            prompt: async (host: string, fingerprint: string): Promise<boolean> => {
                calls.push({ host, fingerprint });
                return answer;
            },
        };
    }

    it('accepts a known key without prompting or writing', async () => {
        const file = await withKnownHosts(khLine('h.example', keyA, true) + '\n');
        const before = await fs.promises.readFile(file, 'utf8');
        const spy = spyPrompt(true);

        const result = await verifyKnownHost({ host: 'h.example', key: keyA, promptForUnknownHost: spy.prompt }, file);

        expect(result).toEqual({ verdict: 'known', verified: true });
        expect(spy.calls).toHaveLength(0);
        expect(await fs.promises.readFile(file, 'utf8')).toBe(before);
    });

    it('rejects a changed key (mismatch) without prompting or writing — no bypass', async () => {
        const file = await withKnownHosts(khLine('h.example', keyA, true) + '\n');
        const before = await fs.promises.readFile(file, 'utf8');
        const spy = spyPrompt(true); // even a "yes" prompt must not be consulted

        const result = await verifyKnownHost({ host: 'h.example', key: keyB, promptForUnknownHost: spy.prompt }, file);

        expect(result).toEqual({ verdict: 'mismatch', verified: false });
        expect(spy.calls).toHaveLength(0);
        expect(await fs.promises.readFile(file, 'utf8')).toBe(before);
    });

    it('refuses a revoked key without prompting or writing — no click-through', async () => {
        const file = await withKnownHosts(`@revoked ${khLine('h.example', keyA, true)}\n`);
        const before = await fs.promises.readFile(file, 'utf8');
        const spy = spyPrompt(true); // a "yes" prompt must never be reachable here

        const result = await verifyKnownHost({ host: 'h.example', key: keyA, promptForUnknownHost: spy.prompt }, file);

        expect(result).toEqual({ verdict: 'revoked', verified: false });
        expect(spy.calls).toHaveLength(0);
        expect(await fs.promises.readFile(file, 'utf8')).toBe(before);
    });

    it('prompts on an unknown host and, on accept, records the key and accepts', async () => {
        const file = await withKnownHosts('');
        const spy = spyPrompt(true);

        const result = await verifyKnownHost({ host: 'h.example', key: keyA, promptForUnknownHost: spy.prompt }, file);

        expect(result).toEqual({ verdict: 'unknown', verified: true });
        expect(spy.calls).toEqual([{ host: 'h.example', fingerprint: hostKeyFingerprint(keyA) }]);
        // The key is now on file → a later verify is 'known'.
        expect(verifyHostKey('h.example', keyA, await fs.promises.readFile(file, 'utf8'))).toBe('known');
    });

    it('prompts on an unknown host and, on reject, records nothing and refuses', async () => {
        const file = await withKnownHosts('');
        const spy = spyPrompt(false);

        const result = await verifyKnownHost({ host: 'h.example', key: keyA, promptForUnknownHost: spy.prompt }, file);

        expect(result).toEqual({ verdict: 'unknown', verified: false });
        expect(spy.calls).toHaveLength(1);
        expect(await checkNewHostInHostkeys('h.example', file)).toBe(true);
    });

    it('treats a missing known_hosts as unknown and creates it on accept', async () => {
        tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hostfile-test-'));
        const file = path.join(tmpDir, 'nested', '.ssh', 'known_hosts');
        const spy = spyPrompt(true);

        const result = await verifyKnownHost({ host: 'h.example', key: keyA, promptForUnknownHost: spy.prompt }, file);

        expect(result).toEqual({ verdict: 'unknown', verified: true });
        expect(await checkNewHostInHostkeys('h.example', file)).toBe(false);
    });
});
