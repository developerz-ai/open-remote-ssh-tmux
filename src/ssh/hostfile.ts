import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { isNodeError } from '@zokugun/is-it-type';

const PATH_SSH_USER_DIR = path.join(os.homedir(), '.ssh');
const KNOW_HOST_FILE = path.join(PATH_SSH_USER_DIR, 'known_hosts');
const HASH_MAGIC = '|1|';
const HASH_DELIM = '|';

export async function checkNewHostInHostkeys(host: string, knownHostsFile: string = KNOW_HOST_FILE): Promise<boolean> {
    let fileContent: string;
    try {
        fileContent = await fs.promises.readFile(knownHostsFile, { encoding: 'utf8' });
    } catch (e) {
        // No known_hosts yet (fresh machine) — every host is new. Any other error
        // (e.g. EACCES) is a genuine failure and must surface to the caller.
        if (isNodeError(e) && e.code === 'ENOENT') {
            return true;
        }
        throw e;
    }

    const lines = fileContent.split(/\r?\n/);
    for (let line of lines) {
        line = line.trim();
        if (!line || line.startsWith('#')) {
            continue;
        }

        // The first whitespace-delimited field holds the host pattern(s): either a
        // single hashed `|1|salt|hash` token, or a comma-separated list of plaintext
        // patterns (`host`, `host,alias`, `[host]:port` for non-default ports).
        const hostsField = line.split(/\s+/)[0];
        if (hostsField.startsWith(HASH_MAGIC)) {
            const [salt_, hostHash_] = hostsField.substring(HASH_MAGIC.length).split(HASH_DELIM);
            if (!salt_ || !hostHash_) {
                continue;
            }
            const hostHash = crypto.createHmac('sha1', Buffer.from(salt_, 'base64')).update(host).digest();
            if (hostHash.toString('base64') === hostHash_) {
                return false;
            }
        } else if (hostsField.split(',').includes(host)) {
            // Upstream only ever matched hashed lines, so OpenSSH's default plaintext
            // and `[host]:port` records were reported "new" on every connect (→ a
            // duplicate append each time). Match those plaintext forms here too.
            return false;
        }
    }

    return true;
}

export async function addHostToHostFile(host: string, hostKey: Buffer, type: string, knownHostsFile: string = KNOW_HOST_FILE): Promise<void> {
    // `recursive: true` creates the parent chain and is a no-op when it already
    // exists. The previous guard never awaited `exists()`, so `!Promise` was always
    // false → the dir was never created → `appendFile` failed with ENOENT on
    // machines without ~/.ssh.
    await fs.promises.mkdir(path.dirname(knownHostsFile), { recursive: true, mode: 0o700 });

    const salt = crypto.randomBytes(20);
    const hostHash = crypto.createHmac('sha1', salt).update(host).digest();

    const entry = `${HASH_MAGIC}${salt.toString('base64')}${HASH_DELIM}${hostHash.toString('base64')} ${type} ${hostKey.toString('base64')}\n`;
    await fs.promises.appendFile(knownHostsFile, entry);
}
