import * as vscode from 'vscode';

/** `remote.SSH.openInWindow`: where the default "connect" / "open folder" actions land. */
export type OpenInWindow = 'auto' | 'current' | 'new';

/** Whether to replace the current window or open a new one. */
export type WindowTarget = 'current' | 'new';

/** What the decision needs to know about the window the action was started from. */
export interface WindowState {
    /** `vscode.env.remoteName` — undefined in a local window. */
    readonly remoteName: string | undefined;
    /** Open workspace folders (`workspaceFolders` is undefined OR empty with none open). */
    readonly folderCount: number;
    /** A `.code-workspace` (or untitled workspace) is open, even one with no folders. */
    readonly hasWorkspaceFile: boolean;
}

/** Coerce the raw setting value: anything unrecognised is the default, `auto`. */
export function toOpenInWindow(value: unknown): OpenInWindow {
    return value === 'current' || value === 'new' ? value : 'auto';
}

/**
 * `auto` reuses the current window only when it is an empty local window — nothing there
 * to lose, and the user most likely opened it to connect from. A window with a folder or
 * workspace, or one already connected to a remote, is kept and a new window opens.
 * `current` / `new` force either way.
 */
export function decideWindowTarget(state: WindowState, setting: OpenInWindow): WindowTarget {
    if (setting !== 'auto') {
        return setting;
    }
    const emptyLocal = !state.remoteName && state.folderCount === 0 && !state.hasWorkspaceFile;
    return emptyLocal ? 'current' : 'new';
}

/** The decision for the live window and the user's setting: true = reuse this window. */
export function reuseCurrentWindow(): boolean {
    const state: WindowState = {
        remoteName: vscode.env.remoteName,
        folderCount: vscode.workspace.workspaceFolders?.length ?? 0,
        hasWorkspaceFile: !!vscode.workspace.workspaceFile,
    };
    const setting = toOpenInWindow(vscode.workspace.getConfiguration('remote.SSH').get('openInWindow'));
    return decideWindowTarget(state, setting) === 'current';
}
