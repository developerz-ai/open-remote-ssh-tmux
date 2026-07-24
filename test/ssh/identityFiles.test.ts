import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';
import { afterEach, describe, expect, it } from 'vitest';
import { gatherIdentityFiles } from '../../src/ssh/identityFiles';
import Log from '../../src/common/logger';

const execFile = promisify(cp.execFile);

// gatherIdentityFiles reads each configured identity file (preferring a `.pub`
// sibling when present) and parses it to compute a fingerprint used for
// auth-handler ordering/logging. An encrypted private key with no `.pub`
// sibling fails that parse (no passphrase available yet) — it must be kept
// (flagged `isPrivate`) rather than silently dropped, so the SSH auth handler
// gets a chance to prompt for the passphrase later instead of the identity
// vanishing with no explanation.
describe('gatherIdentityFiles', () => {
    let tmpDir: string;
    const logger = new Log('test');

    afterEach(async () => {
        if (tmpDir) {
            await fs.promises.rm(tmpDir, { recursive: true, force: true });
        }
    });

    async function makeEncryptedKey(): Promise<string> {
        tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'identity-files-test-'));
        const keyPath = path.join(tmpDir, 'id_ed25519');
        await execFile('ssh-keygen', ['-t', 'ed25519', '-f', keyPath, '-N', 'testpass', '-C', '', '-q']);
        // No `.pub` sibling for this test — force parsing the private key file
        // itself, which is what triggers the "no passphrase given" parse error.
        await fs.promises.rm(`${keyPath}.pub`);
        return keyPath;
    }

    async function makePlainKey(): Promise<string> {
        tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'identity-files-test-'));
        const keyPath = path.join(tmpDir, 'id_ed25519');
        await execFile('ssh-keygen', ['-t', 'ed25519', '-f', keyPath, '-N', '', '-C', '', '-q']);
        await fs.promises.rm(`${keyPath}.pub`);
        return keyPath;
    }

    it('keeps an encrypted private key with no .pub sibling, flagged isPrivate', async () => {
        const keyPath = await makeEncryptedKey();

        const keys = await gatherIdentityFiles([keyPath], undefined, false, logger);

        expect(keys).toHaveLength(1);
        expect(keys[0].filename).toBe(keyPath);
        expect(keys[0].isPrivate).toBe(true);
    });

    it('does not attach a parsedKey/fingerprint for the flagged encrypted entry', async () => {
        const keyPath = await makeEncryptedKey();

        const keys = await gatherIdentityFiles([keyPath], undefined, false, logger);

        expect(keys[0].parsedKey).toBeUndefined();
        expect(keys[0].fingerprint).toBeUndefined();
    });

    it('still parses and returns an unencrypted private key with no .pub sibling', async () => {
        const keyPath = await makePlainKey();

        const keys = await gatherIdentityFiles([keyPath], undefined, false, logger);

        expect(keys).toHaveLength(1);
        expect(keys[0].filename).toBe(keyPath);
        expect(keys[0].isPrivate).toBeUndefined();
        expect(keys[0].parsedKey).toBeDefined();
        expect(keys[0].fingerprint).toBeDefined();
    });

    it('still drops a genuinely malformed identity file (not just a missing passphrase)', async () => {
        tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'identity-files-test-'));
        const keyPath = path.join(tmpDir, 'garbage');
        await fs.promises.writeFile(keyPath, 'not a key at all');

        const keys = await gatherIdentityFiles([keyPath], undefined, false, logger);

        expect(keys).toHaveLength(0);
    });
});
