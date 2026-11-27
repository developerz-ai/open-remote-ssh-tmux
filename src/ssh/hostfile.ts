import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { isNodeError } from '@zokugun/is-it-type';
import { untildify } from '../common/files';
import { isWindows } from '../common/platform';

const PATH_SSH_USER_DIR = path.join(os.homedir(), '.ssh');
const KNOW_HOST_FILE = path.join(PATH_SSH_USER_DIR, 'known_hosts');
// OpenSSH's defaults when `UserKnownHostsFile` / `GlobalKnownHostsFile` are unset.
const DEFAULT_USER_KNOWN_HOSTS_FILES = [KNOW_HOST_FILE, path.join(PATH_SSH_USER_DIR, 'known_hosts2')];
const SYSTEM_SSH_DIR = isWindows ? path.resolve(process.env.ALLUSERSPROFILE || 'C:\\ProgramData', 'ssh') : '/etc/ssh';
const DEFAULT_GLOBAL_KNOWN_HOSTS_FILES = [path.join(SYSTEM_SSH_DIR, 'ssh_known_hosts'), path.join(SYSTEM_SSH_DIR, 'ssh_known_hosts2')];
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
    /** The key type (field 2, e.g. `ssh-ed25519`), or `''` when the record carries none. */
    keyType: string;
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

    return { marker, hostsField: fields[0], keyType: fields[1] ?? '', key: fields.length > 2 ? fields[2] : '' };
}

/**
 * Lower-case the ASCII letters only — what OpenSSH's `lowercase()` / `tolower` on bytes
 * do to a host name and a pattern. `String#toLowerCase` also folds non-ASCII letters,
 * which would match (and hash) names differently from `ssh`.
 */
function asciiLowerCase(value: string): string {
    return value.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
}

const STAR = 0x2a;
const QUESTION_MARK = 0x3f;

/**
 * OpenSSH's `match_pattern`: `*` matches any run of bytes (including none), `?` exactly
 * one byte, everything else itself. Both sides are UTF-8 bytes, as in OpenSSH — on
 * UTF-16 code units `?` would cover a whole `é` here and half of it in `ssh`, and a
 * `??` revocation `ssh` honours would be missed. Only the *pattern's* `*` and `?` are
 * special: `text` is a name (a HostKeyAlias may hold any character), so the pattern's
 * `*` is tried before literal equality — otherwise a `*` in the name consumed it as a
 * literal.
 *
 * The standard iterative matcher with a single backtrack point (the last `*` and where
 * in `text` it resumed), O(text × pattern) at worst — not a RegExp and not recursive,
 * so a hostile known_hosts line can neither inject regex syntax nor stall the connect.
 */
function matchPattern(text: Buffer, pattern: Buffer): boolean {
    let t = 0;
    let p = 0;
    let star = -1;
    let resume = 0;
    while (t < text.length) {
        if (p < pattern.length && pattern[p] === STAR) {
            star = p++;
            resume = t;
        } else if (p < pattern.length && (pattern[p] === QUESTION_MARK || pattern[p] === text[t])) {
            t++;
            p++;
        } else if (star !== -1) {
            p = star + 1;
            t = ++resume;
        } else {
            return false;
        }
    }
    while (p < pattern.length && pattern[p] === STAR) {
        p++;
    }
    return p === pattern.length;
}

/**
 * OpenSSH's `match_pattern_list` as `match_hostname` uses it: `host` (already
 * lower-cased) must match at least one pattern of the comma-separated list, compared
 * case-insensitively (ASCII), and a matching `!pattern` vetoes the whole line wherever
 * it sits.
 */
function matchPatternList(host: string, patternList: string): boolean {
    const hostBytes = Buffer.from(host, 'utf8');
    let matched = false;
    for (const entry of patternList.split(',')) {
        const negated = entry.startsWith('!');
        const pattern = asciiLowerCase(negated ? entry.substring(1) : entry);
        if (!pattern || !matchPattern(hostBytes, Buffer.from(pattern, 'utf8'))) {
            continue;
        }
        if (negated) {
            return false;
        }
        matched = true;
    }
    return matched;
}

/**
 * Does a known_hosts host field (the first whitespace-delimited token) name
 * `host`? The field is either a single hashed `|1|salt|hash` token, or a
 * comma-separated list of plaintext patterns (`host`, `host,alias`, `*.example.com`,
 * `!host`, and the `[host]:port` form OpenSSH uses for non-default ports). Sole owner
 * of the host-matching rule so `checkNewHostInHostkeys` and `verifyHostKey` agree.
 *
 * OpenSSH lower-cases the host name before it matches or records it, so `host` is
 * lower-cased here: a record `ssh` wrote for `mybox` must be found for `MyBox`, or a
 * changed key reads as a first connect.
 */
function hostFieldMatches(hostsField: string, host: string): boolean {
    const lowerHost = asciiLowerCase(host);
    if (hostsField.startsWith(HASH_MAGIC)) {
        const [salt_, hostHash_] = hostsField.substring(HASH_MAGIC.length).split(HASH_DELIM);
        if (!salt_ || !hostHash_) {
            return false;
        }
        const salt = Buffer.from(salt_, 'base64');
        // The verbatim spelling too: before this lower-casing, a mixed-case name was
        // hashed as written, and those records must keep guarding their host.
        const candidates = lowerHost === host ? [lowerHost] : [lowerHost, host];
        return candidates.some((name) => crypto.createHmac('sha1', salt).update(name).digest().toString('base64') === hostHash_);
    }

    // Upstream only ever matched hashed lines, so OpenSSH's default plaintext and
    // `[host]:port` records were reported "new" on every connect (→ a duplicate
    // append each time). Match those plaintext forms here too.
    return matchPatternList(lowerHost, hostsField);
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
 * The key types (known_hosts field 2) on file for `host`, in file order, each once.
 * Marker lines hold no host key and keyless lines are malformed; both are skipped, as
 * in {@link verifyHostKey}.
 */
export function knownHostKeyTypes(host: string, knownHostsContent: string): string[] {
    const types = new Set<string>();
    for (const line of knownHostsContent.split(/\r?\n/)) {
        const record = parseKnownHostsLine(line);
        if (record && !record.marker && record.key && record.keyType && hostFieldMatches(record.hostsField, host)) {
            types.add(record.keyType);
        }
    }
    return [...types];
}

// ssh2's default host-key algorithms, in its order of preference, grouped by the
// known_hosts key type each one verifies (an `ssh-rsa` key signs with any of three).
const HOST_KEY_ALGORITHMS: ReadonlyArray<readonly [keyType: string, algorithms: readonly string[]]> = [
    ['ssh-ed25519', ['ssh-ed25519']],
    ['ecdsa-sha2-nistp256', ['ecdsa-sha2-nistp256']],
    ['ecdsa-sha2-nistp384', ['ecdsa-sha2-nistp384']],
    ['ecdsa-sha2-nistp521', ['ecdsa-sha2-nistp521']],
    ['ssh-rsa', ['rsa-sha2-512', 'rsa-sha2-256', 'ssh-rsa']],
];

/**
 * The host-key algorithms to ask a server for first, given the key types on file for
 * it — what OpenSSH does (`order_hostkeyalgs`). Without it ssh2 negotiates ed25519
 * whenever the server has one, and a host on file with only its RSA or ECDSA key
 * presents a key we have never seen: a `'mismatch'` refusal for a host that is fine.
 *
 * Only names from ssh2's default list are returned, in ssh2's order, so the caller can
 * reorder its offer but never widen it (`ssh-dss`, an `sk-` key type: ignored).
 */
export function serverHostKeyPreference(knownKeyTypes: readonly string[]): string[] {
    return HOST_KEY_ALGORITHMS.filter(([keyType]) => knownKeyTypes.includes(keyType)).flatMap(([, algorithms]) => algorithms);
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
 * The name a host's key is looked up and recorded under: `HostKeyAlias` verbatim when
 * set (OpenSSH then ignores the port too), else {@link hostKeyIdentity}. Its case is
 * kept for display; matching and recording lower-case it (`hostFieldMatches`,
 * `addHostToHostFile`).
 */
export function knownHostsLookupName(host: string, port: number, hostKeyAlias: string | undefined): string {
    return hostKeyAlias || hostKeyIdentity(host, port);
}

/**
 * The known_hosts files for a host, as OpenSSH uses them: every file is read, a new
 * key is recorded only in the first `user` file, `global` files are never written.
 */
export interface KnownHostsFiles {
    readonly user: readonly string[];
    readonly global: readonly string[];
}

/**
 * Resolve `UserKnownHostsFile` / `GlobalKnownHostsFile` (string or list, `~` expanded,
 * `none` = no file) to {@link KnownHostsFiles}, defaulting each to OpenSSH's files.
 * `%`-token expansion (`%d`, `%u`, ...) is not supported.
 */
export function knownHostsFiles(userKnownHostsFile: string | string[] | undefined, globalKnownHostsFile: string | string[] | undefined): KnownHostsFiles {
    const resolve = (value: string | string[] | undefined, defaults: string[]) => {
        if (value === undefined) {
            return defaults;
        }
        return ([] as string[]).concat(value).filter((file) => file.toLowerCase() !== 'none').map(untildify);
    };
    return {
        user: resolve(userKnownHostsFile, DEFAULT_USER_KNOWN_HOSTS_FILES),
        global: resolve(globalKnownHostsFile, DEFAULT_GLOBAL_KNOWN_HOSTS_FILES),
    };
}

/** All files' content, in order; a missing file reads as empty, any other error throws. */
async function readKnownHostsFiles(files: readonly string[]): Promise<string> {
    const contents = await Promise.all(files.map(async (file) => {
        try {
            return await fs.promises.readFile(file, { encoding: 'utf8' });
        } catch (e) {
            // No such file → nothing on file. Any other error (e.g. EACCES) is genuine —
            // rethrow so the verifier fails closed rather than accepting an unverifiable key.
            if (isNodeError(e) && e.code === 'ENOENT') {
                return '';
            }
            throw e;
        }
    }));
    return contents.join('\n');
}

/**
 * {@link knownHostKeyTypes} over every known-hosts file of a host. A file that cannot
 * be read yields no preference rather than an error: this only orders the offer, and
 * the verifier reads the same files again and fails closed on that error itself.
 */
export async function readKnownHostKeyTypes(host: string, files: KnownHostsFiles): Promise<string[]> {
    let content: string;
    try {
        content = await readKnownHostsFiles([...files.user, ...files.global]);
    } catch {
        return [];
    }
    return knownHostKeyTypes(host, content);
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
    knownHosts: string | KnownHostsFiles = knownHostsFiles(undefined, undefined),
): Promise<{ verdict: HostKeyVerdict; verified: boolean }> {
    const { host, key, promptForUnknownHost } = params;
    // A single path is the one file read and written, as before.
    const files = typeof knownHosts === 'string' ? { user: [knownHosts], global: [] } : knownHosts;

    // One verdict over every file's records: a revocation in any file still wins.
    const content = await readKnownHostsFiles([...files.user, ...files.global]);

    const verdict = verifyHostKey(host, key, content);
    if (verdict !== 'unknown') {
        return { verdict, verified: verdict === 'known' };
    }

    const accepted = await promptForUnknownHost(host, hostKeyFingerprint(key));
    // `UserKnownHostsFile none` leaves nowhere to record it: accepted for this connect only.
    if (accepted && files.user.length) {
        await addHostToHostFile(host, key, hostKeyType(key), files.user[0]);
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
    // Lower-cased, as OpenSSH records it (`write_host_entry`) and looks it up.
    const hostHash = crypto.createHmac('sha1', salt).update(asciiLowerCase(host)).digest();

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
