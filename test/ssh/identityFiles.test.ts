import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';
import * as ssh2 from 'ssh2';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { gatherIdentityFiles } from '../../src/ssh/identityFiles';
import Log from '../../src/common/logger';

const execFile = promisify(cp.execFile);

// `gatherIdentityFiles` only calls `OpenSSHAgent#getIdentities` on the ssh2
// module — fake just that constructor (via `vi.hoisted` so the mock factory,
// which vitest hoists above these imports, can share the queued identities
// list with the test bodies below) rather than spinning up a real ssh-agent
// socket. `utils.parseKey` and everything else stay the real implementation.
const { agentIdentities } = vi.hoisted(() => ({ agentIdentities: { current: [] as unknown[] } }));
vi.mock('ssh2', async (importOriginal) => {
    const actual = await importOriginal<typeof import('ssh2')>();
    // A plain `{ ...actual }` spread only copies *own enumerable* properties —
    // `utils` (and other members) are reachable on the real module only via its
    // CJS/ESM-interop proxy fallback, not as an own enumerable key, so the
    // spread silently drops it and every `ssh2.utils.parseKey` call downstream
    // breaks. Pull it out explicitly instead of trusting the spread.
    return {
        ...actual,
        utils: actual.utils,
        // `new ssh2.OpenSSHAgent(sock)` is called with `new`, so the fake
        // constructor must be a real `function`/`class` — an arrow function
        // (even wrapped in `vi.fn().mockImplementation`) cannot be invoked with
        // `new` and vitest warns/fails on it.
        OpenSSHAgent: vi.fn().mockImplementation(function () {
            return {
                getIdentities: (cb: (err: Error | undefined, keys?: unknown[]) => void) => cb(undefined, agentIdentities.current),
            };
        }),
    };
});

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

    it('strips a configured ".pub" suffix and still resolves the same key pair', async () => {
        // gatherIdentityFiles is fed IdentityFile *private*-key paths by convention,
        // but a user-configured ".pub" path (or a stray one from copy/paste) must
        // resolve to the same identity, not a distinct/missing entry.
        tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'identity-files-test-'));
        const keyPath = path.join(tmpDir, 'id_ed25519');
        await execFile('ssh-keygen', ['-t', 'ed25519', '-f', keyPath, '-N', '', '-C', '', '-q']);

        const keys = await gatherIdentityFiles([`${keyPath}.pub`], undefined, false, logger);

        expect(keys).toHaveLength(1);
        expect(keys[0].filename).toBe(keyPath);
        expect(keys[0].parsedKey).toBeDefined();
    });

    // The "empty input -> 7 defaults" case needs a fake HOME (identityFiles.ts
    // resolves the default paths from `os.homedir()` at module load) so it never
    // touches the real developer machine's `~/.ssh` — see
    // `identityFiles.defaults.test.ts` for that case.

    async function makeKeyPairWithPub(name: string): Promise<{ keyPath: string; parsedKey: import('ssh2-streams').ParsedKey; fingerprint: string }> {
        tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'identity-files-test-'));
        const keyPath = path.join(tmpDir, name);
        await execFile('ssh-keygen', ['-t', 'ed25519', '-f', keyPath, '-N', '', '-C', '', '-q']);
        const pub = await fs.promises.readFile(`${keyPath}.pub`);
        const parsedResult = ssh2.utils.parseKey(pub);
        const parsedKey = (Array.isArray(parsedResult) ? parsedResult[0] : parsedResult) as import('ssh2-streams').ParsedKey;
        const crypto = await import('crypto');
        const fingerprint = crypto.createHash('sha256').update(parsedKey.getPublicSSH()).digest('base64');
        return { keyPath, parsedKey, fingerprint };
    }

    describe('SSH agent identities', () => {
        function mockAgent(identities: import('ssh2-streams').ParsedKey[]): void {
            agentIdentities.current = identities;
        }

        afterEach(() => {
            agentIdentities.current = [];
        });

        it('promotes a key present in both the agent and the file list, flagged agentSupport', async () => {
            const { keyPath, parsedKey } = await makeKeyPairWithPub('id_ed25519');
            mockAgent([parsedKey]);

            const keys = await gatherIdentityFiles([keyPath], '/tmp/fake-agent-sock', false, logger);

            expect(keys).toHaveLength(1);
            expect(keys[0].filename).toBe(keyPath);
            expect(keys[0].agentSupport).toBe(true);
        });

        it('lists an agent-only identity (no matching file) when identitiesOnly is false', async () => {
            // A non-empty, nonexistent path (not `[]`) — an empty array falls
            // back to the real DEFAULT_IDENTITY_FILES under the *actual* ~/.ssh,
            // which this test must not touch.
            const { parsedKey } = await makeKeyPairWithPub('id_ed25519');
            const noSuchFile = path.join(tmpDir, 'does-not-exist');
            mockAgent([parsedKey]);

            const keys = await gatherIdentityFiles([noSuchFile], '/tmp/fake-agent-sock', false, logger);

            expect(keys).toHaveLength(1);
            expect(keys[0].agentSupport).toBe(true);
        });

        it('excludes an agent-only identity (no matching file) when identitiesOnly is true', async () => {
            const { parsedKey } = await makeKeyPairWithPub('id_ed25519');
            const noSuchFile = path.join(tmpDir, 'does-not-exist');
            mockAgent([parsedKey]);

            const keys = await gatherIdentityFiles([noSuchFile], '/tmp/fake-agent-sock', true, logger);

            expect(keys).toEqual([]);
        });
    });
});
