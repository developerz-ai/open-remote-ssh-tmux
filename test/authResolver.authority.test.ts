import { describe, expect, it } from 'vitest';
import { parseAuthority } from '../src/authResolver';

// `resolve()` used to do `const [type, dest] = authority.split('+')`, which
// truncates the destination at the *second* `+`. A Host alias containing `+` is
// legal in ssh_config (`Host my+host`), and VS Code hands the authority through
// verbatim, so `ssh-remote+my+host` resolved `dest === 'my'` — a different host
// entirely (or, more often, an unknown one). The authority has exactly one
// separator, the first `+`; everything after it is the (encoded) destination.
describe('parseAuthority', () => {
    it('splits an ordinary authority into type and destination', () => {
        expect(parseAuthority('ssh-remote+bastion')).toEqual({ type: 'ssh-remote', dest: 'bastion' });
    });

    it('keeps a `+` inside the host alias instead of truncating at it', () => {
        expect(parseAuthority('ssh-remote+my+host')).toEqual({ type: 'ssh-remote', dest: 'my+host' });
    });

    it('keeps every later `+` of a multi-plus alias', () => {
        expect(parseAuthority('ssh-remote+a+b+c')).toEqual({ type: 'ssh-remote', dest: 'a+b+c' });
    });

    it('reports an empty destination when the authority carries only a type', () => {
        // The caller rejects a non-matching type first; a bare `ssh-remote` with
        // no destination must not throw here, it must fall through to the
        // destination parser with an empty string.
        expect(parseAuthority('ssh-remote')).toEqual({ type: 'ssh-remote', dest: '' });
    });

    it('reports the foreign type unchanged so the caller can reject it', () => {
        expect(parseAuthority('wsl+Ubuntu')).toEqual({ type: 'wsl', dest: 'Ubuntu' });
    });
});
