import { describe, expect, it } from 'vitest';
import * as vscode from 'vscode';

// Smoke test for the vitest harness itself: proves the runner executes and that
// the `vscode` bare import resolves to `test/mocks/vscode.ts` via the config
// alias. Real module characterisation tests live in their own files (slice 01).
describe('test harness', () => {
    it('resolves the `vscode` specifier to the mock stub', () => {
        expect(typeof vscode.version).toBe('string');
        expect(typeof vscode.env.appRoot).toBe('string');
    });

    it('getConfiguration().get falls back to the caller-provided default', () => {
        const value = vscode.workspace
            .getConfiguration('remote.SSH')
            .get<string>('serverBinaryName', 'fallback');
        expect(value).toBe('fallback');
    });

    it('createOutputChannel returns a channel that records appended lines', () => {
        const channel = vscode.window.createOutputChannel('open-remote-ssh');
        channel.appendLine('hello');
        expect(channel.lines).toEqual(['hello']);
    });
});
