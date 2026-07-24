import * as vscode from 'vscode';

/**
 * A fallback terminal profile provider for the "tmux" profile id when tmux is
 * unavailable or disabled. This ensures the "Persistent Shell" profile option is
 * always available in the terminal picker, even when tmux is not working, providing
 * graceful degradation to a plain shell terminal.
 *
 * This provider returns a basic terminal profile with no special shell configuration —
 * VS Code will use its default shell and arguments. The profile itself is contributed
 * in package.json so the user sees "Persistent Shell" as an option in the picker,
 * but it just opens a normal terminal when tmux is not available.
 */
export class FallbackTerminalProvider implements vscode.TerminalProfileProvider {
    provideTerminalProfile(): vscode.ProviderResult<vscode.TerminalProfile | undefined> {
        // Return a basic terminal profile with no special configuration — VS Code
        // will use its default shell and arguments. This provides a graceful fallback
        // when the real tmux provider is not available.
        return new vscode.TerminalProfile({});
    }
}
