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

/**
 * The known_hosts host identity for a target: the bare hostname on the default
 * SSH port, or OpenSSH's `[host]:port` form otherwise. Every known_hosts
 * lookup/record for a host must use this same string so match and append agree.
 */
export function hostKeyIdentity(host: string, port: number): string {
    return port && port !== 22 ? `[${host}]:${port}` : host;
}

/**
 * OpenSSH-style SHA256 host-key fingerprint (`SHA256:` + unpadded base64), shown
 * in the first-connect consent prompt so the user can compare it out-of-band.
 */
export function hostKeyFingerprint(key: Buffer): string {
    return `SHA256:${crypto.createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`;
}

/**
 * The host-key algorithm name (e.g. `ssh-ed25519`) — the first length-prefixed
 * field of the SSH wire-format host-key blob, which known_hosts stores as field
 * 2. Returns `''` for a malformed/truncated blob (field 2 is cosmetic for our
 * base64-only matching, so an empty type never breaks re-verification).
 */
function hostKeyType(key: Buffer): string {
    if (key.length < 4) {
        return '';
    }
    const length = key.readUInt32BE(0);
    if (length <= 0 || key.length < 4 + length) {
        return '';
    }
    return key.toString('ascii', 4, 4 + length);
}

/**
 * The ssh2 `hostVerifier` decision for one host: read known_hosts, get the pure
 * verdict, and on a first connect obtain consent (injected — it is UI) before
 * recording the key. The one place that ties verify → prompt → append together;
 * kept free of vscode/ssh2 so it stays unit-testable (prompt is a callback, path
 * is injectable):
 *   - `known`    → accept; no prompt, no write.
 *   - `mismatch` → refuse; never prompt, never write (possible MITM, no bypass).
 *   - `unknown`  → prompt; on accept record the key and accept, else refuse.
 * A read error other than ENOENT (a missing file just means "no hosts yet")
 * rejects, so the caller fails closed.
 */
export async function verifyKnownHost(
    params: {
        host: string;
        key: Buffer;
        promptForUnknownHost: (host: string, fingerprint: string) => Promise<boolean>;
    },
    knownHostsFile: string = KNOW_HOST_FILE,
): Promise<{ verdict: HostKeyVerdict; verified: boolean }> {
    const { host, key, promptForUnknownHost } = params;

    let content = '';
    try {
        content = await fs.promises.readFile(knownHostsFile, { encoding: 'utf8' });
    } catch (e) {
        // No known_hosts yet (fresh machine) → treat as empty (verdict 'unknown').
        // Any other error (e.g. EACCES) is genuine — rethrow so the verifier fails
        // closed rather than silently accepting an unverifiable key.
        if (!(isNodeError(e) && e.code === 'ENOENT')) {
            throw e;
        }
    }

    const verdict = verifyHostKey(host, key, content);
    if (verdict !== 'unknown') {
        return { verdict, verified: verdict === 'known' };
    }

    const accepted = await promptForUnknownHost(host, hostKeyFingerprint(key));
    if (accepted) {
        await addHostToHostFile(host, key, hostKeyType(key), knownHostsFile);
    }
    return { verdict, verified: accepted };
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
