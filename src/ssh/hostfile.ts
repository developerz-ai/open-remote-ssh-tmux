import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { isNodeError } from '@zokugun/is-it-type';

const PATH_SSH_USER_DIR = path.join(os.homedir(), '.ssh');
const KNOW_HOST_FILE = path.join(PATH_SSH_USER_DIR, 'known_hosts');
const HASH_MAGIC = '|1|';
const HASH_DELIM = '|';

/** The host-key decision surfaced to the ssh2 `hostVerifier`. */
export type HostKeyVerdict = 'known' | 'unknown' | 'mismatch' | 'revoked';

/**
 * The OpenSSH known_hosts line markers we understand. A marker shifts the rest of
 * the line one field to the right (`marker hosts keytype key [comment]`), so a
 * parser that ignores markers reads `@revoked` itself as the host field — which is
 * how a revoked key used to slip through as an ordinary unknown host.
 */
const MARKER_REVOKED = '@revoked';
const MARKER_CERT_AUTHORITY = '@cert-authority';
type KnownHostsMarker = typeof MARKER_REVOKED | typeof MARKER_CERT_AUTHORITY;

interface KnownHostsRecord {
    /** `undefined` for an ordinary host-key record. */
    marker: KnownHostsMarker | undefined;
    /** The host field: one hashed token or a comma-separated pattern list. */
    hostsField: string;
    /** The base64 key blob (field 3), or `''` when the record carries none. */
    key: string;
}

/**
 * Split one known_hosts line into its parts, or `undefined` when the line carries
 * no record (blank, comment, or — as OpenSSH does — an unrecognised `@marker`,
 * which it refuses to guess at and skips). Sole owner of the line *shape* so the
 * marker rules can't drift between the two readers below.
 */
function parseKnownHostsLine(line: string): KnownHostsRecord | undefined {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
        return undefined;
    }

    const fields = trimmed.split(/\s+/);
    let marker: KnownHostsMarker | undefined;
    if (fields[0].startsWith('@')) {
        if (fields[0] !== MARKER_REVOKED && fields[0] !== MARKER_CERT_AUTHORITY) {
            return undefined;
        }
        marker = fields[0];
        fields.shift();
    }

    // A marker with nothing after it is not a record.
    if (!fields[0]) {
        return undefined;
    }

    return { marker, hostsField: fields[0], key: fields.length > 2 ? fields[2] : '' };
}

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
    for (const line of lines) {
        const record = parseKnownHostsLine(line);
        // A marked line never records "this is the host's key": `@revoked` says the
        // opposite, and a `@cert-authority` line holds the CA's key, not the host's.
        // Either way the host still has no key on file, i.e. it is still new.
        if (!record || record.marker) {
            continue;
        }

        if (hostFieldMatches(record.hostsField, host)) {
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
 *   - `'revoked'`  — an `@revoked` record names exactly this key; OpenSSH never
 *                    accepts one, so neither do we — reject, never prompt-through.
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
    let matched = false;

    for (const line of knownHostsContent.split(/\r?\n/)) {
        const record = parseKnownHostsLine(line);
        if (!record || !hostFieldMatches(record.hostsField, host)) {
            continue;
        }

        // A record with no key blob is malformed — skip it so it can't flip a first
        // connect into a spurious mismatch (a hard failure with no override).
        if (!record.key) {
            continue;
        }

        if (record.marker === MARKER_CERT_AUTHORITY) {
            // The blob is the *CA's* key, not the host's. We don't implement
            // certificate verification, so such a line is neither a match nor
            // evidence the host is on file — comparing it against the presented
            // host key would only manufacture a bogus mismatch.
            continue;
        }

        if (record.marker === MARKER_REVOKED) {
            if (record.key === presented) {
                // Nothing later in the file can un-revoke a key, so decide now.
                return 'revoked';
            }
            // Revoking the host's *old* key says nothing about the one it presents
            // now, so this must not count as "host is on file" — otherwise a host
            // whose new key simply isn't recorded yet would hard-fail as a mismatch.
            continue;
        }

        if (record.key === presented) {
            // Deliberately no early return: a later `@revoked` line for this same
            // key must still win over an ordinary trusted record of it.
            matched = true;
            continue;
        }
        seenHost = true;
    }

    if (matched) {
        return 'known';
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
 *   - `revoked`  → refuse; never prompt, never write (admin-revoked key, no bypass).
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

    // A known_hosts whose last line has no '\n' is legal, and a bare append would
    // glue our record onto it — hiding the new host (re-prompted, re-appended every
    // connect) *and* corrupting the previous line's key field, which then reads as
    // 'mismatch' for a host that worked yesterday: a hard refusal with no override.
    // OpenSSH's hostfile.c guards the same way. One `a+` handle does the length probe
    // and the append, so there is no stat/write race with another writer, and `a`
    // keeps the write itself at the end of the file.
    const handle = await fs.promises.open(knownHostsFile, 'a+', 0o600);
    try {
        const { size } = await handle.stat();
        let separator = '';
        if (size > 0) {
            const lastByte = Buffer.alloc(1);
            await handle.read(lastByte, 0, 1, size - 1);
            separator = lastByte[0] === 0x0a ? '' : '\n';
        }
        await handle.appendFile(`${separator}${entry}`);
    } finally {
        await handle.close();
    }
}
