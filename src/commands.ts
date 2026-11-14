import * as vscode from 'vscode';
import * as fs from 'fs';
import { getRemoteAuthority } from './authResolver';
import { getSSHConfigPath } from './ssh/sshConfig';
import { exists as fileExists } from './common/files';
import SSHDestination from './ssh/sshDestination';

/**
 * "Connect to Host...": ask for a destination, then connect to it. `askDestination` is the
 * "Connect to Host" quick pick (`connectQuickPick.ts`, injected by `extension.ts`); it
 * replaced the bare input box this used to show, and still returns whatever the user typed
 * when that is not a listed host — so it is validated here, at the boundary.
 */
export async function promptOpenRemoteSSHWindow(reuseWindow: boolean, askDestination: () => Promise<string | undefined>) {
    const host = await askDestination();

    if (!host) {
        return;
    }

    // Parse at the input boundary — `SSHDestination.parse` is the one place that
    // understands `user@`, `:port`, and bracketed IPv6 (`[::1]:2222`). Passing the
    // raw typed string straight to the constructor would stuff the whole thing
    // into `hostname` unparsed.
    const sshDest = SSHDestination.parse(host);
    if (!sshDest.hostname) {
        // The pick offers a typed destination only once it parses, but Enter with nothing
        // selected still hands back the raw text — so a malformed destination can never
        // open a window with an empty authority.
        // Not awaited: notifications resolve only when dismissed, and never reject.
        void vscode.window.showErrorMessage(`Remote-SSH: "${host}" is not a valid [user@]hostname[:port] destination.`);
        return;
    }

    openRemoteSSHWindow(sshDest.toEncodedString(), reuseWindow);
}

export function openRemoteSSHWindow(host: string, reuseWindow: boolean) {
    // Fire-and-forget: the command opens a window; there is nothing to wait for here.
    void vscode.commands.executeCommand('vscode.newWindow', { remoteAuthority: getRemoteAuthority(host), reuseWindow });
}

export function openRemoteSSHLocationWindow(host: string, path: string, reuseWindow: boolean) {
    // Say both explicitly: `forceNewWindow: false` alone only declines to force a new
    // window and leaves the choice to VS Code; `forceReuseWindow` asks for this one.
    void vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.from({ scheme: 'vscode-remote', authority: getRemoteAuthority(host), path }), { forceNewWindow: !reuseWindow, forceReuseWindow: reuseWindow });
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
    void vscode.commands.executeCommand('vscode.open', vscode.Uri.file(sshConfigPath));
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

/** One (host, workspace) identity the workspace's sessions are named by. A workspace can
 * have two — its canonical identity and a legacy one older versions used — and the kill must
 * cover both, or a session not yet adopted would survive "kill all". */
export interface WorkspaceSessionIdentity {
    readonly hostKey: string;
    readonly workspaceKey: string;
}

/**
 * The reaper capability the kill command needs, declared here as a narrow local
 * interface (ISP) so this module depends on a behaviour, not on the tmux layer's
 * types: force-kill every persistent session of the workspace's identities, returning the
 * count. `SessionReaper` satisfies it structurally.
 */
export interface WorkspaceSessionKiller {
    /** Resolves how many sessions were killed and how many could not be, or `undefined`
     * when the sessions could not be listed at all. */
    killWorkspaceSessions(identities: readonly WorkspaceSessionIdentity[]): Promise<{ killed: number; failed: number } | undefined>;
}

/**
 * What the kill command operates on: the workspace-scoped killer and the identities to
 * target. The wiring (`extension.ts`) resolves this lazily from the live SSH connection +
 * open workspace, and yields `undefined` when there is no remote connection — so the
 * command is a safe no-op off a remote.
 */
export interface WorkspaceKillTarget {
    readonly reaper: WorkspaceSessionKiller;
    readonly identities: readonly WorkspaceSessionIdentity[];
}

/**
 * Manual zombie escape hatch behind "Remote-SSH: Kill Persistent Terminal Sessions
 * (this workspace)" (docs/idea/tmux-approach.md). Confirms with a modal — this
 * terminates any process still running in those sessions — then delegates the
 * force-kill to the reaper. Deliberately thin: it owns no tmux/session logic and
 * builds no command lines (the reaper does, via module 02). `resolveTarget` is
 * injected so the SSH-connection/workspace plumbing stays in `extension.ts` and this
 * handler is unit-testable; it may resolve asynchronously (the identity reads the SSH config).
 */
export async function killWorkspaceSessions(
    resolveTarget: () => WorkspaceKillTarget | undefined | Promise<WorkspaceKillTarget | undefined>,
): Promise<void> {
    const target = await resolveTarget();
    if (!target) {
        // Off a remote (or before resolve completes) there is nothing to kill.
        // Not awaited: notifications resolve only when dismissed, and never reject.
        void vscode.window.showInformationMessage('Remote-SSH: Not connected to a remote — no persistent terminal sessions to kill.');
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
    await closeWorkspaceSessions(target);
}

/**
 * Kill the workspace's sessions and tell the user what actually happened — the part of the
 * kill command after its confirm, shared with the "terminals are still running" offer that
 * follows turning persistent terminals off (whose own buttons are the confirmation).
 */
export async function closeWorkspaceSessions(target: WorkspaceKillTarget): Promise<void> {
    // `WorkspaceSessionKiller` is a structural interface (ISP) — the concrete
    // `SessionReaper` never rejects, but nothing here guarantees every current or
    // future implementation upholds that. Guard the call so a rejection surfaces
    // as one plain-language message instead of an unhandled promise rejection.
    // The message reports what actually happened on the remote: a kill counts only once the
    // reaper confirmed it, and an unreachable remote is an error — never a cheerful "Killed 0".
    let outcome: { killed: number; failed: number } | undefined;
    try {
        outcome = await target.reaper.killWorkspaceSessions(target.identities);
    } catch {
        outcome = undefined;
    }
    // Not awaited: notifications resolve only when dismissed, and never reject.
    if (!outcome) {
        void vscode.window.showErrorMessage('Remote-SSH: Failed to kill persistent terminal sessions for this workspace.');
    } else if (outcome.failed > 0) {
        void vscode.window.showWarningMessage(
            `Remote-SSH: Killed ${outcome.killed} persistent terminal session(s) for this workspace; ${outcome.failed} could not be killed.`,
        );
    } else {
        void vscode.window.showInformationMessage(`Remote-SSH: Killed ${outcome.killed} persistent terminal session(s) for this workspace.`);
    }
}
