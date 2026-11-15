import * as fs from 'fs';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { decideWindowTarget, reuseCurrentWindow, toOpenInWindow, type OpenInWindow, type WindowState } from '../src/windowTarget';
import { configOverrides, env, workspace } from './mocks/vscode';

// "Connect to Host" used to always open a second window — even from the empty window the
// user had just opened for the purpose, which then sat there blank. `auto` reuses exactly
// that window (nothing open, not remote) and opens a new one whenever the current window
// holds something the user would lose. `current` / `new` force either way.

const emptyLocal: WindowState = { remoteName: undefined, folderCount: 0, hasWorkspaceFile: false };

describe('decideWindowTarget', () => {
    const table: [string, WindowState, OpenInWindow, 'current' | 'new'][] = [
        ['empty local window, auto', emptyLocal, 'auto', 'current'],
        ['local folder open, auto', { ...emptyLocal, folderCount: 1 }, 'auto', 'new'],
        ['multi-root local workspace, auto', { ...emptyLocal, folderCount: 2, hasWorkspaceFile: true }, 'auto', 'new'],
        // An untitled/empty workspace has a workspace file but no folders: still something
        // the user set up, so it is not "empty".
        ['workspace file with no folders, auto', { ...emptyLocal, hasWorkspaceFile: true }, 'auto', 'new'],
        ['empty remote window, auto', { ...emptyLocal, remoteName: 'ssh-remote' }, 'auto', 'new'],
        ['remote folder open, auto', { remoteName: 'ssh-remote', folderCount: 1, hasWorkspaceFile: false }, 'auto', 'new'],
        ['local folder open, current', { ...emptyLocal, folderCount: 1 }, 'current', 'current'],
        ['remote folder open, current', { remoteName: 'ssh-remote', folderCount: 1, hasWorkspaceFile: false }, 'current', 'current'],
        ['empty local window, new', emptyLocal, 'new', 'new'],
    ];

    it.each(table)('%s → %s', (_name, state, setting, expected) => {
        expect(decideWindowTarget(state, setting)).toBe(expected);
    });
});

describe('toOpenInWindow', () => {
    it.each(['auto', 'current', 'new'] as const)('keeps %s', value => {
        expect(toOpenInWindow(value)).toBe(value);
    });

    it.each([undefined, null, '', 'reuse', 1, true])('falls back to auto for %s', value => {
        expect(toOpenInWindow(value)).toBe('auto');
    });
});

describe('reuseCurrentWindow (reads the live window)', () => {
    afterEach(() => {
        configOverrides.clear();
        workspace.workspaceFolders = undefined;
        workspace.workspaceFile = undefined;
        env.remoteName = undefined;
    });

    it('reuses an empty local window by default', () => {
        expect(reuseCurrentWindow()).toBe(true);
    });

    it('opens a new window when a local folder is open', () => {
        workspace.workspaceFolders = [{ uri: { scheme: 'file', authority: '', path: '/home/me/project' } }];
        expect(reuseCurrentWindow()).toBe(false);
    });

    it('treats an empty folder list like no folder', () => {
        workspace.workspaceFolders = [];
        expect(reuseCurrentWindow()).toBe(true);
    });

    it('opens a new window from a remote window', () => {
        env.remoteName = 'ssh-remote';
        expect(reuseCurrentWindow()).toBe(false);
    });

    it('honours remote.SSH.openInWindow', () => {
        configOverrides.set('remote.SSH.openInWindow', 'new');
        expect(reuseCurrentWindow()).toBe(false);
        workspace.workspaceFolders = [{ uri: { scheme: 'file', authority: '', path: '/home/me/project' } }];
        configOverrides.set('remote.SSH.openInWindow', 'current');
        expect(reuseCurrentWindow()).toBe(true);
    });
});

describe('remote.SSH.openInWindow manifest entry', () => {
    // Drift guard: the setting the Settings UI offers is exactly what `toOpenInWindow` understands.
    it('declares the auto/current/new enum with auto as default', () => {
        const manifest = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'package.json'), 'utf8')) as {
            contributes: { configuration: { properties: Record<string, { default?: unknown; enum?: unknown[] }> } };
        };
        const setting = manifest.contributes.configuration.properties['remote.SSH.openInWindow'];
        expect(setting.default).toBe('auto');
        expect(setting.enum).toEqual(['auto', 'current', 'new']);
        for (const value of setting.enum ?? []) {
            expect(toOpenInWindow(value)).toBe(value);
        }
    });
});
