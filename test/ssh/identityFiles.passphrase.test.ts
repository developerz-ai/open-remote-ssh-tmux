import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as ssh2 from 'ssh2';
import { afterEach, describe, expect, it } from 'vitest';
import { gatherIdentityFiles, isPassphraseRequired } from '../../src/ssh/identityFiles';
import Log from '../../src/common/logger';

// ssh2 words "this key needs a passphrase" differently per key format, and only the
// new-format OpenSSH wording was recognised. A legacy PEM key (`-----BEGIN RSA PRIVATE
// KEY-----` + `Proc-Type: 4,ENCRYPTED`, what `ssh-keygen -m PEM` and older ssh-keygen
// write) or a PPK was therefore never offered a passphrase prompt: it was logged as a
// parse error and dropped.
describe('isPassphraseRequired', () => {
    it('recognises every "no passphrase given" wording ssh2 has', () => {
        expect(isPassphraseRequired(new Error('Encrypted private OpenSSH key detected, but no passphrase given'))).toBe(true);
        expect(isPassphraseRequired(new Error('Encrypted OpenSSH private key detected, but no passphrase given'))).toBe(true);
        expect(isPassphraseRequired(new Error('Encrypted PPK private key detected, but no passphrase given'))).toBe(true);
    });

    it('is false for any other parse failure, and for a parsed key', () => {
        expect(isPassphraseRequired(new Error('Unsupported key format'))).toBe(false);
        expect(isPassphraseRequired(new Error('Malformed OpenSSH private key'))).toBe(false);
        expect(isPassphraseRequired(undefined)).toBe(false);
        expect(isPassphraseRequired({ type: 'ssh-rsa' })).toBe(false);
    });

    it('recognises what ssh2 really returns for an encrypted legacy PEM key', () => {
        expect(isPassphraseRequired(ssh2.utils.parseKey(encryptedPemKey()))).toBe(true);
    });
});

function encryptedPemKey(): string {
    return crypto.generateKeyPairSync('rsa', {
        modulusLength: 2048,
        publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
        privateKeyEncoding: { type: 'pkcs1', format: 'pem', cipher: 'aes-128-cbc', passphrase: 'testpass' },
    }).privateKey;
}

describe('gatherIdentityFiles — encrypted legacy PEM key', () => {
    let tmpDir: string;

    afterEach(async () => {
        if (tmpDir) {
            await fs.promises.rm(tmpDir, { recursive: true, force: true });
        }
    });

    it('keeps it (flagged isPrivate) so the auth handler can ask for the passphrase', async () => {
        tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'identity-files-test-'));
        const keyPath = path.join(tmpDir, 'id_rsa');
        await fs.promises.writeFile(keyPath, encryptedPemKey(), { mode: 0o600 });

        const keys = await gatherIdentityFiles([keyPath], undefined, false, new Log('test'));

        expect(keys).toEqual([{ filename: keyPath, isPrivate: true }]);
    });
});
