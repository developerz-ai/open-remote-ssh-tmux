import { describe, expect, it, vi } from 'vitest';

// os.homedir() is read once at module load in src/common/files.ts, so mock it
// before importing the module under test.
vi.mock('os', () => ({
    homedir: () => '/home/us$&er',
}));

describe('untildify', () => {
    it('substitutes a home directory containing `$&` literally, not as a replacement pattern', async () => {
        // String.prototype.replace treats a *string* replacement's `$&`/`$$`/`$1`
        // etc. as special patterns (`$&` = the matched substring). A username
        // containing `$&` must appear literally in the output, not be
        // interpreted as "insert the match" (which would have produced `~$&er`
        // duplicated/corrupted instead of the literal home path).
        const { untildify } = await import('../../src/common/files');
        expect(untildify('~/project')).toBe('/home/us$&er/project');
        expect(untildify('~')).toBe('/home/us$&er');
    });

    it('leaves paths not starting with a bare ~ untouched', async () => {
        const { untildify } = await import('../../src/common/files');
        expect(untildify('~user/project')).toBe('~user/project');
        expect(untildify('/absolute/path')).toBe('/absolute/path');
    });
});
