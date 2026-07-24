import * as vscode from 'vscode';
import * as fs from 'fs';
import { getRemoteAuthority } from './authResolver';
import { getSSHConfigPath } from './ssh/sshConfig';
import { exists as fileExists } from './common/files';
import SSHDestination from './ssh/sshDestination';

export async function promptOpenRemoteSSHWindow(reuseWindow: boolean) {
    const host = await vscode.window.showInputBox({
        title: 'Enter [user@]hostname[:port]',
        validateInput: validateSSHDestinationInput
    });

    if (!host) {
        return;
    }

    // Parse at the input boundary — `SSHDestination.parse` is the one place that
    // understands `user@`, `:port`, and bracketed IPv6 (`[::1]:2222`). Passing the
    // raw typed string straight to the constructor would stuff the whole thing
    // into `hostname` unparsed.
    const sshDest = SSHDestination.parse(host);
    if (!sshDest.hostname) {
        // `validateInput` should already have blocked this via the UI, but the
        // input box only enforces it interactively — guard again so a malformed
        // destination can never open a window with an empty authority.
        vscode.window.showErrorMessage(`Remote-SSH: "${host}" is not a valid [user@]hostname[:port] destination.`);
        return;
    }

    openRemoteSSHWindow(sshDest.toEncodedString(), reuseWindow);
}

/** `validateInput` for the "Enter [user@]hostname[:port]" box — parses the current
 * value the same way the command itself will and rejects anything that doesn't
 * resolve to a usable hostname, so the user gets inline feedback instead of a
 * window opened against an empty authority. */
function validateSSHDestinationInput(value: string): string | undefined {
    if (!value || !SSHDestination.parse(value).hostname) {
        return 'Enter a valid [user@]hostname[:port] destination.';
    }
    return undefined;
}

export function openRemoteSSHWindow(host: string, reuseWindow: boolean) {
    vscode.commands.executeCommand('vscode.newWindow', { remoteAuthority: getRemoteAuthority(host), reuseWindow });
}

export function openRemoteSSHLocationWindow(host: string, path: string, reuseWindow: boolean) {
    vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.from({ scheme: 'vscode-remote', authority: getRemoteAuthority(host), path }), { forceNewWindow: !reuseWindow });
}

export async function addNewHost() {
    const sshConfigPath = getSSHConfigPath();
    if (!await fileExists(sshConfigPath)) {
        await fs.promises.appendFile(sshConfigPath, '');
    }

    await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(sshConfigPath), { preview: false });

    const textEditor = vscode.window.activeTextEditor;
    if (textEditor?.document.uri.fsPath !== sshConfigPath) {
        return;
    }

    const textDocument = textEditor.document;
    const lastLine = textDocument.lineAt(textDocument.lineCount - 1);

    if (!lastLine.isEmptyOrWhitespace) {
        await textEditor.edit((editBuilder: vscode.TextEditorEdit) => {
            editBuilder.insert(lastLine.range.end, '\n');
        });
    }

    const snippet = '\nHost ${1:dev}\n\tHostName ${2:dev.example.com}\n\tUser ${3:john}';

    await textEditor.insertSnippet(
        new vscode.SnippetString(snippet),
        new vscode.Position(textDocument.lineCount, 0)
    );
}

export async function openSSHConfigFile() {
    const sshConfigPath = getSSHConfigPath();
    if (!await fileExists(sshConfigPath)) {
        await fs.promises.appendFile(sshConfigPath, '');
    }
    vscode.commands.executeCommand('vscode.open', vscode.Uri.file(sshConfigPath));
}

/** Confirm button label for the kill command's modal. Exported so the handler test
 * can seed the simulated dialog choice without duplicating the literal. */
export const KILL_SESSIONS_CONFIRM_LABEL = 'Kill Sessions';

/**
 * The kill command's id — single source of truth shared by `extension.ts`'s
 * `registerCommand` call and `package.json`'s `contributes.commands` entry.
 * Exported so a drift-guard test can assert the manifest and the registration stay
 * in lockstep (see `test/package-manifest.test.ts`).
 */
export const KILL_WORKSPACE_SESSIONS_COMMAND_ID = 'openremotessh.tmux.killWorkspaceSessions';

/**
 * The reaper capability the kill command needs, declared here as a narrow local
 * interface (ISP) so this module depends on a behaviour, not on the tmux layer's
 * types: force-kill every persistent session of one (host, workspace), returning the
 * count. `SessionReaper` satisfies it structurally.
 */
export interface WorkspaceSessionKiller {
    killWorkspaceSessions(hostKey: string, workspaceKey: string): Promise<number>;
}

/**
 * What the kill command operates on: the workspace-scoped killer and the
 * (host, workspace) identity to target. The wiring (`extension.ts`) resolves this
 * lazily from the live SSH connection + open workspace, and yields `undefined` when
 * there is no remote connection — so the command is a safe no-op off a remote.
 */
export interface WorkspaceKillTarget {
    readonly reaper: WorkspaceSessionKiller;
    readonly hostKey: string;
    readonly workspaceKey: string;
}

/**
 * Manual zombie escape hatch behind "Remote-SSH: Kill Persistent Terminal Sessions
 * (this workspace)" (docs/idea/tmux-approach.md). Confirms with a modal — this
 * terminates any process still running in those sessions — then delegates the
 * force-kill to the reaper. Deliberately thin: it owns no tmux/session logic and
 * builds no command lines (the reaper does, via module 02). `resolveTarget` is
 * injected so the SSH-connection/workspace plumbing stays in `extension.ts` and this
 * handler is unit-testable.
 */
export async function killWorkspaceSessions(resolveTarget: () => WorkspaceKillTarget | undefined): Promise<void> {
    const target = resolveTarget();
    if (!target) {
        // Off a remote (or before resolve completes) there is nothing to kill.
        vscode.window.showInformationMessage('Remote-SSH: Not connected to a remote — no persistent terminal sessions to kill.');
        return;
    }

    const choice = await vscode.window.showWarningMessage(
        'Kill all persistent terminal sessions for this workspace? Any process still running in them will be terminated.',
        { modal: true },
        KILL_SESSIONS_CONFIRM_LABEL,
    );
    if (choice !== KILL_SESSIONS_CONFIRM_LABEL) {
        return; // cancelled — leave every session untouched
    }

    // `WorkspaceSessionKiller` is a structural interface (ISP) — the concrete
    // `SessionReaper` never rejects, but nothing here guarantees every current or
    // future implementation upholds that. Guard the call so a rejection surfaces
    // as one plain-language message instead of an unhandled promise rejection.
    try {
        const killed = await target.reaper.killWorkspaceSessions(target.hostKey, target.workspaceKey);
        vscode.window.showInformationMessage(`Remote-SSH: Killed ${killed} persistent terminal session(s) for this workspace.`);
    } catch {
        vscode.window.showErrorMessage('Remote-SSH: Failed to kill persistent terminal sessions for this workspace.');
    }
}
