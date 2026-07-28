import { describe, expect, it } from 'vitest';
import { splitProxyCommand } from '../src/authResolver';

// Characterisation tests for `splitProxyCommand` (exported for testability only).
// It approximates the tokenization the shell OpenSSH hands the ProxyCommand to
// would perform: split on unquoted whitespace, group a double-quoted span into one
// token, and — on a POSIX client only — honour backslash escapes the way `/bin/sh`
// does. See the docstring on `splitProxyCommand` in `src/authResolver.ts` for the
// upstream issues this fixes and for why the client platform is a parameter.
//
// Every backslash-sensitive case below passes the platform explicitly, so the suite
// asserts both behaviours regardless of which OS it runs on.
describe('splitProxyCommand', () => {
    it('splits a plain space-separated command into argv tokens', () => {
        expect(splitProxyCommand('ssh -W %h:%p bastion')).toEqual(['ssh', '-W', '%h:%p', 'bastion']);
    });

    it('collapses runs of whitespace between tokens', () => {
        expect(splitProxyCommand('ssh   -W  %h:%p')).toEqual(['ssh', '-W', '%h:%p']);
    });

    it('groups a double-quoted span (with embedded spaces) into a single token, keeping its backslashes', () => {
        // `/bin/sh` does NOT strip backslashes inside double quotes (only `\"`,
        // `\\`, `` \` ``, `\$` and `\<newline>` are special there), so a quoted
        // Windows path survives intact on either platform. The old tokenizer
        // stripped them unconditionally and produced `C:Program Filesnc.exe`,
        // which spawns as ENOENT.
        for (const windows of [false, true]) {
            expect(splitProxyCommand('ssh -W %h:%p "C:\\Program Files\\nc.exe"', windows)).toEqual([
                'ssh', '-W', '%h:%p', 'C:\\Program Files\\nc.exe',
            ]);
        }
    });

    it('honours a POSIX backslash escape outside quotes, consuming the backslash itself', () => {
        expect(splitProxyCommand('ssh -o Foo=bar\\ baz', false)).toEqual(['ssh', '-o', 'Foo=bar baz']);
    });

    it('keeps an unquoted Windows path intact on a Windows client', () => {
        // The reason the platform is a parameter at all: `\` is the path separator
        // on Windows and never an escape, so `C:\Users\me\proxy.exe` must survive
        // verbatim. Treating it as an escape yielded `C:Usersmeproxy.exe` → spawn
        // ENOENT, i.e. every unquoted Windows ProxyCommand was broken — even though
        // the `isWindows && /\.(bat|cmd)$/` branch right below the call site shows
        // Windows ProxyCommands are an intended, supported path.
        expect(splitProxyCommand('C:\\Users\\me\\proxy.exe -H %h', true)).toEqual([
            'C:\\Users\\me\\proxy.exe', '-H', '%h',
        ]);
    });

    it('a doubled backslash inside quotes escapes down to a single literal backslash on POSIX', () => {
        // JS source '\\\\' is two literal backslashes in the actual ProxyCommand
        // text. `\\` is one of the few escapes `/bin/sh` still honours inside double
        // quotes, so the pair collapses to a single literal backslash.
        expect(splitProxyCommand('ssh "C:\\\\nc.exe"', false)).toEqual(['ssh', 'C:\\nc.exe']);
    });

    it('leaves a doubled backslash alone on Windows, so a UNC path survives', () => {
        expect(splitProxyCommand('"\\\\server\\share\\nc.exe" %h', true)).toEqual(['\\\\server\\share\\nc.exe', '%h']);
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
        // than being silently dropped or throwing. Same on both platforms.
        expect(splitProxyCommand('ssh bastion\\', false)).toEqual(['ssh', 'bastion\\']);
        expect(splitProxyCommand('ssh bastion\\', true)).toEqual(['ssh', 'bastion\\']);
    });

    it('a trailing lone backslash as the entire input yields a single-backslash token', () => {
        expect(splitProxyCommand('\\', false)).toEqual(['\\']);
        expect(splitProxyCommand('\\', true)).toEqual(['\\']);
    });

    it('an unquoted backslash-space is a token separator on Windows (the documented trade-off)', () => {
        // A Windows client gets no `\` escapes at all, so `\ ` does not join the two
        // halves of a path with a space — that path has to be quoted (which works on
        // both platforms, see above). Losing shell-style escaping on Windows is the
        // cheaper half of the trade: `\` appears in essentially every Windows path
        // and only rarely as an escape, and quoting is the documented Windows way to
        // carry a space anyway.
        expect(splitProxyCommand('C:\\with\\ space\\nc.exe %h', true)).toEqual([
            'C:\\with\\', 'space\\nc.exe', '%h',
        ]);
    });
});
