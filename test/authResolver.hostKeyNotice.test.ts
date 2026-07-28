import { describe, expect, it } from 'vitest';
import { hostKeyRejectionNotice } from '../src/authResolver';

// `buildHostVerifier` refuses a bad host key by handing ssh2 `callback(false)` —
// correct but silent, so the user just sees an opaque "Could not establish
// connection". The modal explaining *why* is the only part of that decision that
// isn't already covered by `verifyKnownHost`'s own tests, and it lives behind a
// private method plus vscode UI, so the wording choice is extracted here as data.
//
// The important thing this pins down: `'revoked'` (added to `HostKeyVerdict` when
// `hostfile.ts` learned to parse OpenSSH `@revoked` markers — before that a
// revoked key surfaced as `'unknown'` and the user was offered the ordinary
// first-connect prompt for a key the admin had explicitly revoked) must NOT reuse
// the mismatch wording. The mismatch modal tells the user to remove the stale
// known_hosts entry and reconnect; for a revoked key that is an instruction to
// delete the `@revoked` line and then trust the revoked key. OpenSSH hard-refuses,
// and so must we — no override, no remediation hint.
describe('hostKeyRejectionNotice', () => {
    it('says nothing for a key that matches known_hosts', () => {
        expect(hostKeyRejectionNotice('known', 'example.com')).toBeUndefined();
    });

    it('says nothing for an unknown host — that path is the consent prompt, not an error', () => {
        expect(hostKeyRejectionNotice('unknown', 'example.com')).toBeUndefined();
    });

    it('explains a mismatch as a possible MITM and points at the stale known_hosts entry', () => {
        const notice = hostKeyRejectionNotice('mismatch', 'example.com')!;
        expect(notice).toBeDefined();
        expect(notice.logMessage).toContain('example.com');
        expect(notice.message).toContain('example.com');
        expect(notice.message).toMatch(/known_hosts/);
    });

    it('explains a revoked key as revoked and refused', () => {
        const notice = hostKeyRejectionNotice('revoked', 'example.com')!;
        expect(notice).toBeDefined();
        expect(notice.logMessage).toMatch(/revoked/i);
        expect(notice.message).toContain('example.com');
        expect(notice.message).toMatch(/revoked/i);
        expect(notice.message).toMatch(/refused|rejected/i);
    });

    it('never tells the user to edit known_hosts to get past a revoked key', () => {
        // The dangerous fall-through: reusing the mismatch remediation ("remove the
        // stale entry from known_hosts and reconnect") would walk the user into
        // deleting the `@revoked` record and accepting the revoked key.
        const { message } = hostKeyRejectionNotice('revoked', 'example.com')!;
        expect(message).not.toMatch(/remove|delete|edit/i);
        expect(message).not.toMatch(/known_hosts/);
    });

    it('offers no accept/override path for a revoked key', () => {
        // Shape, not just wording: the notice carries a message only — there is no
        // affordance for a "Continue anyway" button to be wired to.
        const notice = hostKeyRejectionNotice('revoked', 'example.com')!;
        expect(Object.keys(notice).sort()).toEqual(['logMessage', 'message']);
        expect(notice.message).not.toMatch(/continue|proceed|anyway|accept|trust/i);
    });

    it('gives mismatch and revoked genuinely different wording', () => {
        expect(hostKeyRejectionNotice('revoked', 'example.com')!.message)
            .not.toBe(hostKeyRejectionNotice('mismatch', 'example.com')!.message);
    });
});
