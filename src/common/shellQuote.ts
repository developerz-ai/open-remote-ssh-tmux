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
