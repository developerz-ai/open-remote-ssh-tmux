import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { isNodeError } from '@zokugun/is-it-type';

const PATH_SSH_USER_DIR = path.join(os.homedir(), '.ssh');
const KNOW_HOST_FILE = path.join(PATH_SSH_USER_DIR, 'known_hosts');
const HASH_MAGIC = '|1|';
const HASH_DELIM = '|';

/** The three-way host-key decision surfaced to the ssh2 `hostVerifier`. */
export type HostKeyVerdict = 'known' | 'unknown' | 'mismatch';

/**
 * Does a known_hosts host field (the first whitespace-delimited token) name
 * `host`? The field is either a single hashed `|1|salt|hash` token, or a
 * comma-separated list of plaintext patterns (`host`, `host,alias`, and the
 * `[host]:port` form OpenSSH uses for non-default ports). Sole owner of the
 * host-matching rule so `checkNewHostInHostkeys` and `verifyHostKey` agree.
 */
function hostFieldMatches(hostsField: string, host: string): boolean {
    if (hostsField.startsWith(HASH_MAGIC)) {
        const [salt_, hostHash_] = hostsField.substring(HASH_MAGIC.length).split(HASH_DELIM);
        if (!salt_ || !hostHash_) {
            return false;
        }
        const hostHash = crypto.createHmac('sha1', Buffer.from(salt_, 'base64')).update(host).digest();
        return hostHash.toString('base64') === hostHash_;
    }

    // Upstream only ever matched hashed lines, so OpenSSH's default plaintext and
    // `[host]:port` records were reported "new" on every connect (→ a duplicate
    // append each time). Match those plaintext forms here too.
    return hostsField.split(',').includes(host);
}

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

        if (hostFieldMatches(line.split(/\s+/)[0], host)) {
            return false;
        }
    }

    return true;
}

/**
 * Pure host-key decision over known_hosts *content* (no I/O), so the resolver's
 * ssh2 `hostVerifier` can stay a thin wrapper that reads the file, calls this,
 * and injects the consent prompt as a callback:
 *   - `'known'`    — a known_hosts record for `host` carries exactly this key.
 *   - `'mismatch'` — `host` is on file, but only with a *different* key (possible
 *                    MITM); the resolver must reject, never prompt-through.
 *   - `'unknown'`  — `host` is not on file at all (first connect → prompt).
 *
 * `key` is the raw wire-format host-key blob ssh2 hands the verifier; known_hosts
 * stores that same blob base64-encoded in its third field, so a byte-for-byte
 * match reduces to comparing base64. A host that publishes several keys (rsa +
 * ed25519) is `'known'` for any recorded one and `'mismatch'` only when none match.
 */
export function verifyHostKey(host: string, key: Buffer, knownHostsContent: string): HostKeyVerdict {
    const presented = key.toString('base64');
    let seenHost = false;

    for (let line of knownHostsContent.split(/\r?\n/)) {
        line = line.trim();
        if (!line || line.startsWith('#')) {
            continue;
        }

        const fields = line.split(/\s+/);
        if (!hostFieldMatches(fields[0], host)) {
            continue;
        }

        // fields: [hostPattern(s), keyType, base64Key, ...comment]. A record with
        // no key blob is malformed — skip it so it can't flip a first connect into
        // a spurious mismatch (a hard failure with no override).
        const storedKey = fields[2];
        if (!storedKey) {
            continue;
        }
        if (storedKey === presented) {
            return 'known';
        }
        seenHost = true;
    }

    return seenHost ? 'mismatch' : 'unknown';
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
