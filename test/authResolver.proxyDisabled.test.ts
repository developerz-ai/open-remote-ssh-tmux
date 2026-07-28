import { describe, expect, it } from 'vitest';
import { isProxyDisabled } from '../src/authResolver';

// `none` is the documented OpenSSH way to *cancel* a proxy inherited from an
// earlier or wildcard block (ssh_config(5), ProxyCommand/ProxyJump). ssh-config's
// first-seen-wins `compute()` faithfully returns `'none'`, and `'none'` is truthy,
// so the resolver used to take the proxy branch anyway:
//
//     Host internal
//         ProxyCommand none
//     Host *
//         ProxyCommand nc -X 5 -x proxy %h %p
//
// spawned `none` → ENOENT → "Could not establish connection"; `ProxyJump none`
// likewise tried to resolve a host literally named `none`. OpenSSH compares the
// value case-insensitively (`strcasecmp(*arg, "none")`), so we do too.
describe('isProxyDisabled', () => {
    it('treats the literal `none` as "no proxy"', () => {
        expect(isProxyDisabled('none')).toBe(true);
    });

    it('is case-insensitive, matching OpenSSH\'s strcasecmp', () => {
        expect(isProxyDisabled('None')).toBe(true);
        expect(isProxyDisabled('NONE')).toBe(true);
    });

    it('ignores surrounding whitespace left by the config parser', () => {
        expect(isProxyDisabled('  none  ')).toBe(true);
    });

    it('treats an unset/empty value as "no proxy" so one check covers both branches', () => {
        expect(isProxyDisabled(undefined)).toBe(true);
        expect(isProxyDisabled('')).toBe(true);
        expect(isProxyDisabled('   ')).toBe(true);
    });

    it('does not disable a real proxy command', () => {
        expect(isProxyDisabled('nc -X 5 -x proxy %h %p')).toBe(false);
        expect(isProxyDisabled('ssh -W %h:%p bastion')).toBe(false);
    });

    it('does not disable a command that merely starts with or contains "none"', () => {
        expect(isProxyDisabled('none-proxy %h %p')).toBe(false);
        expect(isProxyDisabled('/usr/bin/none %h')).toBe(false);
    });

    it('does not disable a ProxyJump host list', () => {
        expect(isProxyDisabled('jump1,jump2')).toBe(false);
    });

    it('handles the array shape older ssh-config versions produce', () => {
        // `ProxyCommand` is read back as `string | string[]` depending on the
        // ssh-config version (see `splitProxyCommand`), so the cancel check has to
        // cope with both or the array shape would sail past it.
        expect(isProxyDisabled(['none'])).toBe(true);
        expect(isProxyDisabled(['nc', '%h', '%p'])).toBe(false);
        expect(isProxyDisabled([])).toBe(true);
    });
});
