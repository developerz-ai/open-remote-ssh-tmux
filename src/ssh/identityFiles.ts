import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import type { ParsedKey } from 'ssh2-streams';
import * as ssh2 from 'ssh2';
import { untildify, exists as fileExists } from '../common/files';
import Log from '../common/logger';

const homeDir = os.homedir();
const PATH_SSH_CLIENT_ID_DSA = path.join(homeDir, '.ssh', '/id_dsa');
const PATH_SSH_CLIENT_ID_ECDSA = path.join(homeDir, '.ssh', '/id_ecdsa');
const PATH_SSH_CLIENT_ID_RSA = path.join(homeDir, '.ssh', '/id_rsa');
const PATH_SSH_CLIENT_ID_ED25519 = path.join(homeDir, '.ssh', '/id_ed25519');
const PATH_SSH_CLIENT_ID_XMSS = path.join(homeDir, '.ssh', '/id_xmss');
const PATH_SSH_CLIENT_ID_ECDSA_SK = path.join(homeDir, '.ssh', '/id_ecdsa_sk');
const PATH_SSH_CLIENT_ID_ED25519_SK = path.join(homeDir, '.ssh', '/id_ed25519_sk');

const DEFAULT_IDENTITY_FILES: string[] = [
    PATH_SSH_CLIENT_ID_RSA,
    PATH_SSH_CLIENT_ID_ECDSA,
    PATH_SSH_CLIENT_ID_ECDSA_SK,
    PATH_SSH_CLIENT_ID_ED25519,
    PATH_SSH_CLIENT_ID_ED25519_SK,
    PATH_SSH_CLIENT_ID_XMSS,
    PATH_SSH_CLIENT_ID_DSA,
];

export interface SSHKey {
    filename: string;
    // Absent for an encrypted private key kept via the `isPrivate` branch below —
    // we can't derive a parsedKey/fingerprint without the passphrase yet.
    parsedKey?: ParsedKey;
    fingerprint?: string;
    agentSupport?: boolean;
    isPrivate?: boolean;
}

// From https://github.com/openssh/openssh-portable/blob/acb2059febaddd71ee06c2ebf63dcf211d9ab9f2/sshconnect2.c#L1689-L1690
export async function gatherIdentityFiles(identityFiles: string[], sshAgentSock: string | undefined, identitiesOnly: boolean, logger: Log) {
    identityFiles = identityFiles.map(untildify).map(i => i.replace(/\.pub$/, ''));
    if (identityFiles.length === 0) {
        identityFiles.push(...DEFAULT_IDENTITY_FILES);
    }

    const identityFileContentsResult = await Promise.allSettled(identityFiles.map(async keyPath => {
        const usingPublicKey = await fileExists(keyPath + '.pub');
        const contents = await fs.promises.readFile(usingPublicKey ? keyPath + '.pub' : keyPath);
        return { contents, usingPublicKey };
    }));
    const fileKeys: SSHKey[] = identityFileContentsResult.map((result, i) => {
        if (result.status === 'rejected') {
            return undefined;
        }

        const { contents, usingPublicKey } = result.value;
        const parsedResult = ssh2.utils.parseKey(contents);
        if (parsedResult instanceof Error || !parsedResult) {
            // An encrypted private key with no `.pub` sibling fails to parse here
            // because we don't have its passphrase yet — that's expected, not a
            // real error. Keep the entry (flagged `isPrivate`, no parsedKey/
            // fingerprint yet) instead of silently dropping the identity, so the
            // SSH auth handler gets a chance to prompt for the passphrase.
            if (!usingPublicKey && parsedResult instanceof Error && parsedResult.message === 'Encrypted private OpenSSH key detected, but no passphrase given') {
                return {
                    filename: identityFiles[i],
                    isPrivate: true
                };
            }

            logger.error(`Error while parsing SSH public key ${identityFiles[i]}:`, parsedResult);
            return undefined;
        }

        const parsedKey = Array.isArray(parsedResult) ? parsedResult[0] : parsedResult;
        const fingerprint = crypto.createHash('sha256').update(parsedKey.getPublicSSH()).digest('base64');

        return {
            filename: identityFiles[i],
            parsedKey,
            fingerprint
        };
    }).filter(<T>(v: T | undefined): v is T => !!v);

    let sshAgentParsedKeys: ParsedKey[] = [];
    try {
        if (!sshAgentSock) {
            throw new Error(`SSH_AUTH_SOCK environment variable not defined`);
        }

        sshAgentParsedKeys = await new Promise<ParsedKey[]>((resolve, reject) => {
            const sshAgent = new ssh2.OpenSSHAgent(sshAgentSock);
            sshAgent.getIdentities((err, publicKeys) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(publicKeys || []);
                }
            });
        });
    } catch (e) {
        logger.error(`Couldn't get identities from OpenSSH agent`, e);
    }

    const sshAgentKeys: SSHKey[] = sshAgentParsedKeys.map(parsedKey => {
        const fingerprint = crypto.createHash('sha256').update(parsedKey.getPublicSSH()).digest('base64');
        return {
            filename: parsedKey.comment,
            parsedKey,
            fingerprint,
            agentSupport: true
        };
    });

    const agentKeys: SSHKey[] = [];
    const preferredIdentityKeys: SSHKey[] = [];
    for (const agentKey of sshAgentKeys) {
        const foundIdx = fileKeys.findIndex(k => agentKey.parsedKey && k.parsedKey && agentKey.parsedKey.type === k.parsedKey.type && agentKey.fingerprint === k.fingerprint);
        if (foundIdx >= 0) {
            preferredIdentityKeys.push({ ...fileKeys[foundIdx], agentSupport: true });
            fileKeys.splice(foundIdx, 1);
        } else if (!identitiesOnly) {
            agentKeys.push(agentKey);
        }
    }
    preferredIdentityKeys.push(...agentKeys);
    preferredIdentityKeys.push(...fileKeys);

    logger.trace(`Identity keys:`, preferredIdentityKeys.length ? preferredIdentityKeys.map(k => k.parsedKey ? `${k.filename} ${k.parsedKey.type} SHA256:${k.fingerprint}` : `${k.filename} (encrypted, passphrase required)`).join('\n') : 'None');

    return preferredIdentityKeys;
}
