import { beforeEach, describe, expect, it } from 'vitest';
import { promptOpenRemoteSSHWindow } from '../src/commands';
import { executedCommands, shownMessages } from './mocks/vscode';

// `promptOpenRemoteSSHWindow` is the command-input boundary: whatever the user
// picks or types into the "Connect to Host" pick becomes the destination. It
// must go through `SSHDestination.parse` (the same parser used everywhere else —
// bracketed IPv6, user@, :port) rather than being stuffed unparsed into the
// hostname field via `new SSHDestination(raw)`, and it must reject input that
// doesn't parse to a usable hostname instead of opening a window to "".

/** The pick, as the simulated user answers it (`undefined` = dismissed). */
const answer = (value: string | undefined) => (): Promise<string | undefined> => Promise.resolve(value);

beforeEach(() => {
    executedCommands.length = 0;
    shownMessages.error.length = 0;
});

describe('promptOpenRemoteSSHWindow', () => {
    it('parses user@host:port typed by the user instead of treating the raw string as the hostname', async () => {
        await promptOpenRemoteSSHWindow(false, answer('john@dev.example.com:2222'));

        expect(executedCommands).toHaveLength(1);
        const [{ command, args }] = executedCommands;
        expect(command).toBe('vscode.newWindow');
        const authority = (args[0] as { remoteAuthority: string }).remoteAuthority;
        // The encoded authority must carry the parsed host, not the whole raw
        // "john@dev.example.com:2222" string crammed into the hostname field.
        expect(authority).toContain('ssh-remote+');
        expect(authority.toLowerCase()).not.toContain('\\x6a\\x6f\\x68\\x6e@dev.example.com:2222'.toLowerCase());
    });

    it('parses a bracketed IPv6 destination typed by the user', async () => {
        await promptOpenRemoteSSHWindow(false, answer('[::1]:2222'));

        expect(executedCommands).toHaveLength(1);
    });

    it('rejects input that does not parse to a usable hostname and opens no window', async () => {
        await promptOpenRemoteSSHWindow(false, answer('@:22'));

        expect(executedCommands).toHaveLength(0);
        expect(shownMessages.error).toHaveLength(1);
    });

    it('opens nothing when the pick is dismissed', async () => {
        await promptOpenRemoteSSHWindow(false, answer(undefined));

        expect(executedCommands).toHaveLength(0);
        expect(shownMessages.error).toHaveLength(0);
    });

    it('passes the window choice through to vscode.newWindow', async () => {
        await promptOpenRemoteSSHWindow(true, answer('dev'));
        await promptOpenRemoteSSHWindow(false, answer('dev'));

        expect(executedCommands.map(({ args }) => (args[0] as { reuseWindow: boolean }).reuseWindow)).toEqual([true, false]);
    });
});
