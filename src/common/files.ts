import * as fs from 'fs';
import * as os from 'os';

const homeDir = os.homedir();

export async function exists(path: string) {
    try {
        await fs.promises.access(path);
        return true;
    } catch {
        return false;
    }
}

export function untildify(path: string){
    // Replacer *function* (not the plain `homeDir` string) — a string
    // replacement is scanned for `$&`/`$$`/`$1`… patterns, so a home
    // directory containing `$` (e.g. Windows usernames) would corrupt the
    // result. A function's return value is inserted literally.
    return path.replace(/^~(?=$|\/|\\)/, () => homeDir);
}

export function normalizeToSlash(path: string) {
    return path.replace(/\\/g, '/');
}
