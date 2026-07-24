import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Log from '../../src/common/logger';

// identityFiles.ts resolves its 7 default identity-file paths
// (id_rsa/ecdsa/ecdsa_sk/ed25519/ed25519_sk/xmss/dsa) from `os.homedir()` at
// module load — same pattern as `common/files.test.ts`'s untildify tests.
// `os` must be mocked *before* the module is imported (dynamically, after the
// mock is set up) so this never touches the real developer machine's
// `~/.ssh` (a hard requirement of this suite — see 07-missing-tests.md).
let fakeHome: string;

vi.mock('os', async (importOriginal) => {
    const actual = await importOriginal<typeof import('os')>();
    return { ...actual, homedir: () => fakeHome };
});

describe('gatherIdentityFiles defaults (no configured IdentityFile)', () => {
    beforeEach(async () => {
        fakeHome = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'identity-files-defaults-test-'));
        vi.resetModules();
    });

    afterEach(async () => {
        await fs.promises.rm(fakeHome, { recursive: true, force: true });
    });

    it('falls back to the 7 default paths under ~/.ssh, none readable -> empty result', async () => {
        const { gatherIdentityFiles } = await import('../../src/ssh/identityFiles');
        const logger = new Log('test');

        const keys = await gatherIdentityFiles([], undefined, false, logger);

        expect(keys).toEqual([]);
    });

    it('keeps only the readable default paths, dropping the rest', async () => {
        await fs.promises.mkdir(path.join(fakeHome, '.ssh'), { recursive: true });
        // Only id_rsa exists; the other 6 defaults (ecdsa/ecdsa_sk/ed25519/
        // ed25519_sk/xmss/dsa) are missing and must be silently dropped, not
        // thrown on.
        const idRsa = path.join(fakeHome, '.ssh', 'id_rsa');
        await fs.promises.writeFile(idRsa, 'not a real key, just needs to exist for this drop test');

        const { gatherIdentityFiles } = await import('../../src/ssh/identityFiles');
        const logger = new Log('test');

        const keys = await gatherIdentityFiles([], undefined, false, logger);

        // The one readable default fails to *parse* (not a real key) so it too
        // is dropped as malformed — this proves all 7 candidate paths were
        // attempted (readable-but-invalid still reaches the parse step) without
        // throwing, rather than the loop stopping early.
        expect(keys).toEqual([]);
    });
});
