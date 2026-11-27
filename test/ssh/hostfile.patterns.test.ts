import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { addHostToHostFile, knownHostKeyTypes, readKnownHostKeyTypes, serverHostKeyPreference, verifyHostKey, verifyKnownHost } from '../../src/ssh/hostfile';

// known_hosts host fields are OpenSSH *pattern lists* (`match_pattern_list`): `*` and `?`
// globs, `!` negation, compared case-insensitively against the lower-cased host name.
// They were matched as literal strings, so the man page's own `@revoked * ssh-rsa …`
// never revoked anything, and a record OpenSSH wrote for `mybox` was invisible to a
// config that spelt it `MyBox` — turning a changed key into a first-connect prompt.

function wireHostKey(type: string, payload: string): Buffer {
    const typeBytes = Buffer.from(type, 'ascii');
    const length = Buffer.alloc(4);
    length.writeUInt32BE(typeBytes.length, 0);
    return Buffer.concat([length, typeBytes, Buffer.from(payload)]);
}

function hashedField(host: string): string {
    const salt = crypto.randomBytes(20);
    const hash = crypto.createHmac('sha1', salt).update(host).digest();
    return `|1|${salt.toString('base64')}|${hash.toString('base64')}`;
}

const keyA = wireHostKey('ssh-ed25519', 'alpha-key-payload');
const keyB = wireHostKey('ssh-ed25519', 'bravo-key-payload');
const rsaKey = wireHostKey('ssh-rsa', 'rsa-key-payload');
const b64 = (key: Buffer) => key.toString('base64');

describe('verifyHostKey — @revoked with a host pattern', () => {
    it('refuses a key revoked for every host (`@revoked *`)', () => {
        expect(verifyHostKey('box', keyA, `@revoked * ssh-ed25519 ${b64(keyA)}\n`)).toBe('revoked');
    });

    it('lets `@revoked *` win over an ordinary trusted record of the same key, in either order', () => {
        const trusted = `box ssh-ed25519 ${b64(keyA)}`;
        const revoked = `@revoked * ssh-ed25519 ${b64(keyA)}`;
        expect(verifyHostKey('box', keyA, `${trusted}\n${revoked}\n`)).toBe('revoked');
        expect(verifyHostKey('box', keyA, `${revoked}\n${trusted}\n`)).toBe('revoked');
    });

    it('refuses a key revoked for a matching glob only', () => {
        const content = `@revoked *.example.com ssh-ed25519 ${b64(keyA)}\n`;
        expect(verifyHostKey('a.example.com', keyA, content)).toBe('revoked');
        expect(verifyHostKey('a.example.org', keyA, content)).toBe('unknown');
    });

    it('does not let `@revoked *` of another key touch this one', () => {
        expect(verifyHostKey('box', keyA, `box ssh-ed25519 ${b64(keyA)}\n@revoked * ssh-ed25519 ${b64(keyB)}\n`)).toBe('known');
    });
});

describe('verifyHostKey — plaintext host patterns', () => {
    it('reports a different key under a matching wildcard record as mismatch, not unknown', () => {
        expect(verifyHostKey('a.example.com', keyB, `*.example.com ssh-ed25519 ${b64(keyA)}\n`)).toBe('mismatch');
    });

    it('reports the recorded key under a matching wildcard record as known', () => {
        expect(verifyHostKey('a.example.com', keyA, `*.example.com ssh-ed25519 ${b64(keyA)}\n`)).toBe('known');
    });

    it('matches `?` against exactly one character', () => {
        const content = `box? ssh-ed25519 ${b64(keyA)}\n`;
        expect(verifyHostKey('box1', keyB, content)).toBe('mismatch');
        expect(verifyHostKey('box', keyB, content)).toBe('unknown');
        expect(verifyHostKey('box12', keyB, content)).toBe('unknown');
    });

    it('lets a `!` pattern veto the whole line, wherever it sits in the list', () => {
        expect(verifyHostKey('box', keyA, `*,!box ssh-ed25519 ${b64(keyA)}\n`)).toBe('unknown');
        expect(verifyHostKey('box', keyA, `!box,* ssh-ed25519 ${b64(keyA)}\n`)).toBe('unknown');
        expect(verifyHostKey('other', keyA, `*,!box ssh-ed25519 ${b64(keyA)}\n`)).toBe('known');
    });

    it('never matches on a negated pattern alone', () => {
        expect(verifyHostKey('box', keyA, `!other ssh-ed25519 ${b64(keyA)}\n`)).toBe('unknown');
    });

    it('does not treat a glob character as a regular expression', () => {
        expect(verifyHostKey('aXexample.com', keyB, `a.example.com ssh-ed25519 ${b64(keyA)}\n`)).toBe('unknown');
        expect(verifyHostKey('[box]:2222', keyB, `[box]:2222 ssh-ed25519 ${b64(keyA)}\n`)).toBe('mismatch');
        expect(verifyHostKey('b', keyB, `[box]:2222 ssh-ed25519 ${b64(keyA)}\n`)).toBe('unknown');
    });

    it('matches a wildcard inside the [host]:port form', () => {
        expect(verifyHostKey('[a.example.com]:2222', keyB, `[*.example.com]:2222 ssh-ed25519 ${b64(keyA)}\n`)).toBe('mismatch');
    });
});

// Only the *pattern's* `*` and `?` are special. A lookup name may contain them too — a
// HostKeyAlias is free text — and there they are ordinary characters.
describe('verifyHostKey — glob characters in the lookup name', () => {
    it('lets the pattern\'s * match a name that itself starts with *', () => {
        expect(verifyHostKey('*edge-dev', keyB, `*dev ssh-ed25519 ${b64(keyA)}\n`)).toBe('mismatch');
        expect(verifyHostKey('*edge-dev', keyA, `*dev ssh-ed25519 ${b64(keyA)}\n`)).toBe('known');
    });

    it('lets the pattern\'s ? match a literal ? or * in the name, one character each', () => {
        expect(verifyHostKey('a?b', keyB, `a?b ssh-ed25519 ${b64(keyA)}\n`)).toBe('mismatch');
        expect(verifyHostKey('a*b', keyB, `a?b ssh-ed25519 ${b64(keyA)}\n`)).toBe('mismatch');
    });

    it('does not let a * in the name act as a wildcard', () => {
        expect(verifyHostKey('*', keyB, `box ssh-ed25519 ${b64(keyA)}\n`)).toBe('unknown');
        expect(verifyHostKey('b*', keyB, `box ssh-ed25519 ${b64(keyA)}\n`)).toBe('unknown');
    });
});

describe('verifyHostKey — a hostile pattern cannot stall the connect', () => {
    it('decides a many-star pattern against a long name in bounded time', () => {
        const name = 'a'.repeat(20_000);
        const pattern = `${'*a'.repeat(200)}*b`;
        const started = performance.now();

        expect(verifyHostKey(name, keyB, `${pattern} ssh-ed25519 ${b64(keyA)}\n`)).toBe('unknown');
        expect(verifyHostKey(name, keyB, `${'*a'.repeat(200)}* ssh-ed25519 ${b64(keyA)}\n`)).toBe('mismatch');

        expect(performance.now() - started).toBeLessThan(2000);
    });
});

describe('verifyHostKey — host name case', () => {
    it('finds a lower-case plaintext record for a mixed-case host (changed key → mismatch)', () => {
        expect(verifyHostKey('MyBox.Example.com', keyB, `mybox.example.com ssh-ed25519 ${b64(keyA)}\n`)).toBe('mismatch');
        expect(verifyHostKey('MyBox.Example.com', keyA, `mybox.example.com ssh-ed25519 ${b64(keyA)}\n`)).toBe('known');
    });

    it('finds a mixed-case plaintext record for a lower-case host', () => {
        expect(verifyHostKey('mybox', keyB, `MyBox ssh-ed25519 ${b64(keyA)}\n`)).toBe('mismatch');
    });

    it('finds the hashed record OpenSSH wrote (it hashes the lower-cased name)', () => {
        const content = `${hashedField('mybox.example.com')} ssh-ed25519 ${b64(keyA)}\n`;
        expect(verifyHostKey('MyBox.Example.com', keyB, content)).toBe('mismatch');
        expect(verifyHostKey('MyBox.Example.com', keyA, content)).toBe('known');
    });

    it('still finds a hashed record an earlier version wrote under the mixed-case name', () => {
        const content = `${hashedField('MyBox.Example.com')} ssh-ed25519 ${b64(keyA)}\n`;
        expect(verifyHostKey('MyBox.Example.com', keyB, content)).toBe('mismatch');
    });
});

describe('recording a host', () => {
    let tmpDir: string;

    afterEach(async () => {
        if (tmpDir) {
            await fs.promises.rm(tmpDir, { recursive: true, force: true });
        }
    });

    it('hashes the lower-cased name, so OpenSSH finds the record too', async () => {
        tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hostfile-test-'));
        const file = path.join(tmpDir, 'known_hosts');

        await addHostToHostFile('MyBox.Example.com', keyA, 'ssh-ed25519', file);

        const [field] = (await fs.promises.readFile(file, 'utf8')).trim().split(' ');
        const [salt, hash] = field.substring(3).split('|');
        const expected = crypto.createHmac('sha1', Buffer.from(salt, 'base64')).update('mybox.example.com').digest('base64');
        expect(hash).toBe(expected);
    });

    it('accepts on the next connect what it recorded for a mixed-case host', async () => {
        tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hostfile-test-'));
        const file = path.join(tmpDir, 'known_hosts');
        const prompt = async () => true;

        await verifyKnownHost({ host: 'MyBox', key: keyA, promptForUnknownHost: prompt }, file);

        const again = await verifyKnownHost({ host: 'MyBox', key: keyA, promptForUnknownHost: async () => false }, file);
        expect(again).toEqual({ verdict: 'known', verified: true });
        const changed = await verifyKnownHost({ host: 'mybox', key: keyB, promptForUnknownHost: prompt }, file);
        expect(changed).toEqual({ verdict: 'mismatch', verified: false });
    });
});

// ssh2 offers ed25519 first. A host on file with only its RSA (or ECDSA) key then
// presented its ed25519 key, which read as a changed key: a hard refusal for a host
// `ssh` connects to. OpenSSH asks for the key types it already has on file first.
describe('knownHostKeyTypes', () => {
    it('lists the key types on file for the host', () => {
        const content = [
            `box ssh-rsa ${b64(rsaKey)}`,
            `other ssh-ed25519 ${b64(keyA)}`,
            `${hashedField('box')} ecdsa-sha2-nistp256 ${b64(keyB)}`,
        ].join('\n');
        expect(knownHostKeyTypes('box', content)).toEqual(['ssh-rsa', 'ecdsa-sha2-nistp256']);
    });

    it('matches the host like the verifier does (case, patterns)', () => {
        expect(knownHostKeyTypes('Box.Example.com', `*.example.com ssh-rsa ${b64(rsaKey)}\n`)).toEqual(['ssh-rsa']);
    });

    it('ignores marker lines, keyless lines and other hosts', () => {
        const content = [
            `@revoked box ssh-rsa ${b64(rsaKey)}`,
            `@cert-authority box ssh-rsa ${b64(rsaKey)}`,
            'box ssh-ed25519',
            `other ssh-rsa ${b64(rsaKey)}`,
        ].join('\n');
        expect(knownHostKeyTypes('box', content)).toEqual([]);
    });

    it('lists a type once', () => {
        expect(knownHostKeyTypes('box', `box ssh-rsa ${b64(rsaKey)}\nbox ssh-rsa ${b64(keyA)}\n`)).toEqual(['ssh-rsa']);
    });
});

describe('serverHostKeyPreference', () => {
    it('is empty when nothing is on file (ssh2 keeps its own order)', () => {
        expect(serverHostKeyPreference([])).toEqual([]);
    });

    it('asks for the RSA signature algorithms when an ssh-rsa key is on file', () => {
        expect(serverHostKeyPreference(['ssh-rsa'])).toEqual(['rsa-sha2-512', 'rsa-sha2-256', 'ssh-rsa']);
    });

    it('keeps several known types in ssh2\'s own order', () => {
        expect(serverHostKeyPreference(['ssh-rsa', 'ssh-ed25519'])).toEqual(['ssh-ed25519', 'rsa-sha2-512', 'rsa-sha2-256', 'ssh-rsa']);
    });

    it('never prefers a type ssh2 does not offer by default', () => {
        expect(serverHostKeyPreference(['ssh-dss', 'sk-ssh-ed25519@openssh.com', 'ecdsa-sha2-nistp256'])).toEqual(['ecdsa-sha2-nistp256']);
    });
});

describe('readKnownHostKeyTypes', () => {
    let tmpDir: string;

    afterEach(async () => {
        if (tmpDir) {
            await fs.promises.rm(tmpDir, { recursive: true, force: true });
        }
    });

    it('reads every user and global file, skipping a missing one', async () => {
        tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hostfile-test-'));
        const user = path.join(tmpDir, 'user');
        const global = path.join(tmpDir, 'global');
        await fs.promises.writeFile(user, `box ssh-rsa ${b64(rsaKey)}\n`);
        await fs.promises.writeFile(global, `box ssh-ed25519 ${b64(keyA)}\n`);

        const types = await readKnownHostKeyTypes('box', { user: [user, path.join(tmpDir, 'absent')], global: [global] });

        expect(types).toEqual(['ssh-rsa', 'ssh-ed25519']);
    });

    it('reports nothing for an unreadable file (the verifier still fails closed on it)', async () => {
        tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hostfile-test-'));

        // A directory in place of the file: EISDIR, i.e. a read error that is not ENOENT.
        expect(await readKnownHostKeyTypes('box', { user: [tmpDir], global: [] })).toEqual([]);
    });
});
