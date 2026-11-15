import { beforeEach, describe, expect, it } from 'vitest';
import { openRemoteSSHLocationWindow, openRemoteSSHWindow } from '../src/commands';
import { executedCommands } from './mocks/vscode';

// The "current window" / "new window" choice must reach VS Code as explicit flags: for a
// folder, `forceNewWindow: false` alone only declines to force a new window, so reusing this
// one also needs `forceReuseWindow`.

beforeEach(() => {
    executedCommands.length = 0;
});

describe('openRemoteSSHLocationWindow', () => {
    it('reuses the window with forceReuseWindow', () => {
        openRemoteSSHLocationWindow('dev', '/home/me/app', true);

        const [{ command, args }] = executedCommands;
        expect(command).toBe('vscode.openFolder');
        expect(args[1]).toEqual({ forceNewWindow: false, forceReuseWindow: true });
    });

    it('opens a new window with forceNewWindow', () => {
        openRemoteSSHLocationWindow('dev', '/home/me/app', false);

        expect(executedCommands[0].args[1]).toEqual({ forceNewWindow: true, forceReuseWindow: false });
    });
});

describe('openRemoteSSHWindow', () => {
    it('opens the host empty, in this window or a new one', () => {
        openRemoteSSHWindow('dev', true);
        openRemoteSSHWindow('dev', false);

        expect(executedCommands.map(({ command, args }) => [command, args[0]])).toEqual([
            ['vscode.newWindow', { remoteAuthority: 'ssh-remote+dev', reuseWindow: true }],
            ['vscode.newWindow', { remoteAuthority: 'ssh-remote+dev', reuseWindow: false }],
        ]);
    });
});
