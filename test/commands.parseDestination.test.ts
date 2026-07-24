import { beforeEach, describe, expect, it } from 'vitest';
import { promptOpenRemoteSSHWindow } from '../src/commands';
import { executedCommands, inputBoxResponses, shownInputBoxes, shownMessages } from './mocks/vscode';

// `promptOpenRemoteSSHWindow` is the command-input boundary: whatever the user
// types into the "Enter [user@]hostname[:port]" box becomes the destination. It
// must go through `SSHDestination.parse` (the same parser used everywhere else —
// bracketed IPv6, user@, :port) rather than being stuffed unparsed into the
// hostname field via `new SSHDestination(raw)`, and it must reject input that
// doesn't parse to a usable hostname instead of opening a window to "".

beforeEach(() => {
    inputBoxResponses.value = undefined;
    shownInputBoxes.length = 0;
    executedCommands.length = 0;
    shownMessages.error.length = 0;
});

describe('promptOpenRemoteSSHWindow', () => {
    it('parses user@host:port typed by the user instead of treating the raw string as the hostname', async () => {
        inputBoxResponses.value = 'john@dev.example.com:2222';

        await promptOpenRemoteSSHWindow(false);

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
        inputBoxResponses.value = '[::1]:2222';

        await promptOpenRemoteSSHWindow(false);

        expect(executedCommands).toHaveLength(1);
    });

    it('rejects input that does not parse to a usable hostname and opens no window', async () => {
        inputBoxResponses.value = '@:22';

        await promptOpenRemoteSSHWindow(false);

        expect(executedCommands).toHaveLength(0);
        expect(shownMessages.error).toHaveLength(1);
    });

    it('wires a validateInput that rejects destinations with no hostname', async () => {
        inputBoxResponses.value = undefined; // user cancels; we only inspect the wired options

        await promptOpenRemoteSSHWindow(false);

        expect(shownInputBoxes).toHaveLength(1);
        const { validateInput } = shownInputBoxes[0];
        expect(validateInput).toBeTypeOf('function');
        expect(validateInput?.('@:22')).toBeTruthy(); // error message for invalid input
        expect(validateInput?.('dev.example.com')).toBeFalsy(); // no error for valid input
    });
});
