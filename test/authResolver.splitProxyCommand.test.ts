import { describe, expect, it } from 'vitest';
import { splitProxyCommand } from '../src/authResolver';

// Characterisation tests for `splitProxyCommand` (exported for testability only,
// no logic change). It mirrors OpenSSH's own ProxyCommand tokenization: OpenSSH
// splits on unquoted whitespace, groups a double-quoted span into one token, and
// treats backslash as an escape for the next character. See the docstring on
// `splitProxyCommand` in `src/authResolver.ts` for the upstream issues this fixes.
describe('splitProxyCommand', () => {
    it('splits a plain space-separated command into argv tokens', () => {
        expect(splitProxyCommand('ssh -W %h:%p bastion')).toEqual(['ssh', '-W', '%h:%p', 'bastion']);
    });

    it('collapses runs of whitespace between tokens', () => {
        expect(splitProxyCommand('ssh   -W  %h:%p')).toEqual(['ssh', '-W', '%h:%p']);
    });

    it('groups a double-quoted span (with embedded spaces) into a single token', () => {
        expect(splitProxyCommand('ssh -W %h:%p "C:\\Program Files\\nc.exe"')).toEqual([
            'ssh', '-W', '%h:%p', 'C:Program Filesnc.exe',
        ]);
    });

    it('treats a backslash as an escape for the next character, consuming the backslash itself', () => {
        expect(splitProxyCommand('ssh -o Foo=bar\\ baz')).toEqual(['ssh', '-o', 'Foo=bar baz']);
    });

    it('a doubled backslash escapes down to a single literal backslash', () => {
        // JS source '\\\\' is two literal backslashes in the actual ProxyCommand
        // text; each backslash escapes the one after it, so the pair collapses
        // to a single literal backslash in the output token.
        expect(splitProxyCommand('ssh "C:\\\\nc.exe"')).toEqual(['ssh', 'C:\\nc.exe']);
    });

    it('allows a quoted token adjacent to unquoted text with no separating space', () => {
        expect(splitProxyCommand('foo"bar baz"qux')).toEqual(['foobar bazqux']);
    });

    it('trims leading/trailing whitespace and ignores empty input', () => {
        expect(splitProxyCommand('  ssh bastion  ')).toEqual(['ssh', 'bastion']);
        expect(splitProxyCommand('')).toEqual([]);
        expect(splitProxyCommand('   ')).toEqual([]);
    });

    it('passes array input through unchanged (defensive compatibility path)', () => {
        const input = ['ssh', '-W', '%h:%p'];
        const result = splitProxyCommand(input);
        expect(result).toEqual(input);
        expect(result).not.toBe(input); // .slice() copy, not the same reference
    });

    it('splits on tabs the same as spaces', () => {
        expect(splitProxyCommand('ssh\t-W\t%h:%p\tbastion')).toEqual(['ssh', '-W', '%h:%p', 'bastion']);
    });

    it('collapses mixed runs of tabs and spaces between tokens', () => {
        expect(splitProxyCommand('ssh \t -W\t\t%h:%p')).toEqual(['ssh', '-W', '%h:%p']);
    });

    it('an unterminated quote absorbs the rest of the input as one token, including embedded whitespace', () => {
        // No closing '"': `quoted` never flips back off, so the remainder — tabs,
        // spaces and all — is folded into a single trailing token instead of being
        // split on whitespace. Matches OpenSSH's own tokenizer, which likewise
        // treats an unterminated quote as extending to end-of-string rather than
        // erroring.
        expect(splitProxyCommand('ssh "bastion one two')).toEqual(['ssh', 'bastion one two']);
    });

    it('an unterminated quote opened mid-token still yields a single joined token', () => {
        expect(splitProxyCommand('foo"bar baz')).toEqual(['foobar baz']);
    });

    it('a trailing lone backslash (nothing left to escape) is kept as a literal backslash', () => {
        // The escape branch only fires when there's a next character to consume
        // (`i + 1 < value.length`); a backslash as the very last byte falls through
        // to the default case and is appended to the current token as-is, rather
        // than being silently dropped or throwing.
        expect(splitProxyCommand('ssh bastion\\')).toEqual(['ssh', 'bastion\\']);
    });

    it('a trailing lone backslash as the entire input yields a single-backslash token', () => {
        expect(splitProxyCommand('\\')).toEqual(['\\']);
    });
});
