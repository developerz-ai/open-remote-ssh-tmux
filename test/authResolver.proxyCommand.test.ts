import { describe, expect, it } from 'vitest';
import { buildProxyCommandSpawn, ProxyCommandRejectedError, redactedProxyCommandLine } from '../src/authResolver';

const tokens = (h: string) => ({ h, n: h, p: '22', r: 'me' });

// A Windows `.bat`/`.cmd` ProxyCommand is spawned through cmd.exe (`shell: true`,
// `windowsVerbatimArguments`), and `%h`/`%n`/`%r` come from the remote authority —
// i.e. from a link or a workspace file. `ssh-remote+x&calc` used to run `calc`.
describe('buildProxyCommandSpawn', () => {
    it('spawns a POSIX ProxyCommand directly, tokens expanded, no shell', () => {
        const spawn = buildProxyCommandSpawn('nc -X 5 -x proxy %h %p', tokens('box'), false);

        expect(spawn).toEqual({ command: 'nc', args: ['-X', '5', '-x', 'proxy', 'box', '22'], options: {} });
    });

    it('does not reject metacharacters when no shell is involved', () => {
        expect(buildProxyCommandSpawn('proxy.exe %h', tokens('a&b'), true).args).toEqual(['a&b']);
    });

    it('runs a .bat through cmd with the command quoted', () => {
        const spawn = buildProxyCommandSpawn('C:\\p\\proxy.bat %h %p', tokens('box'), true);

        expect(spawn.command).toBe('"C:\\p\\proxy.bat"');
        expect(spawn.args).toEqual(['box', '22']);
        expect(spawn.options).toEqual({ shell: true, windowsHide: true, windowsVerbatimArguments: true });
    });

    it('quotes an argument containing a space', () => {
        const spawn = buildProxyCommandSpawn('proxy.cmd %r', { h: 'box', n: 'box', p: '22', r: 'John Smith' }, true);

        expect(spawn.args).toEqual(['"John Smith"']);
    });

    for (const host of ['a&calc', 'a|calc', 'a^b', 'a%PATH%', 'a"b', 'a>out', 'a<in', 'a!b', 'a(b)', 'a\r\nb']) {
        it(`rejects an authority token ${JSON.stringify(host)} before it reaches cmd.exe`, () => {
            expect(() => buildProxyCommandSpawn('proxy.bat %h', tokens(host), true)).toThrow(ProxyCommandRejectedError);
        });
    }

    it('rejects a metacharacter in the user token too', () => {
        expect(() => buildProxyCommandSpawn('proxy.bat %r', { h: 'box', n: 'box', p: '22', r: 'me&calc' }, true))
            .toThrow(ProxyCommandRejectedError);
    });
});

// The full expanded ProxyCommand was logged, and its arguments can carry tokens or
// credentials (`--token=...`, `-o ProxyPassword=...`).
describe('redactedProxyCommandLine', () => {
    it('keeps the command and drops the arguments', () => {
        const line = redactedProxyCommandLine('cloudflared', ['access', 'ssh', '--hostname', 'box', '--service-token-secret', 's3cret']);

        expect(line).toContain('cloudflared');
        expect(line).not.toContain('s3cret');
        expect(line).not.toContain('box');
        expect(line).toContain('6');
    });
});
