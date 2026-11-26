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

    it('leaves cmd-only metacharacters alone when no cmd.exe is involved', () => {
        expect(buildProxyCommandSpawn('proxy.exe %h', tokens('a^b%c!d'), true).args).toEqual(['a^b%c!d']);
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

// `%h`, `%n` and `%r` come from the remote authority (a link, a workspace file), and a
// ProxyCommand hands them to another program: `ssh bastion nc %h %p` gives them to the
// bastion's shell, `sh -c "nc %h %p"` to a local one, and a value starting with `-` is
// an option of the proxy binary. OpenSSH refuses such names outright (`valid_hostname`,
// `valid_ruser` in ssh.c — CVE-2023-51385); this path only checked `.bat`/`.cmd`.
describe('buildProxyCommandSpawn — unsafe authority tokens, every platform', () => {
    const hostile = ['-oProxyCommand=calc', 'x;id', 'x$(id)', 'x`id`', 'a b', 'a\tb', 'a|b', 'a&b', 'a>b', 'a<b', 'a(b)', 'a{b}', 'a\'b', 'a"b', 'a\\b', 'a\nb', 'a\u0001b'];
    for (const windows of [false, true]) {
        for (const host of hostile) {
            it(`rejects the host ${JSON.stringify(host)} (${windows ? 'windows' : 'posix'})`, () => {
                expect(() => buildProxyCommandSpawn('ssh bastion nc %h %p', tokens(host), windows)).toThrow(ProxyCommandRejectedError);
            });
        }
    }

    it('rejects an unsafe %n even when %h is clean', () => {
        expect(() => buildProxyCommandSpawn('nc %h %p', { h: 'box', n: 'x;id', p: '22', r: 'me' }, false)).toThrow(ProxyCommandRejectedError);
    });

    for (const user of ['-oProxyCommand=calc', 'me;id', 'me`id`', 'me|id', 'me&id', 'me(x)', 'me{x}', 'me\'x', 'me"x', 'me<x', 'me>x', 'me -x', 'me\\', 'me\nx']) {
        it(`rejects the user ${JSON.stringify(user)}`, () => {
            expect(() => buildProxyCommandSpawn('ssh -l %r bastion', { h: 'box', n: 'box', p: '22', r: user }, false)).toThrow(ProxyCommandRejectedError);
        });
    }

    it('rejects a port that is not a number', () => {
        expect(() => buildProxyCommandSpawn('nc %h %p', { h: 'box', n: 'box', p: '22;id', r: 'me' }, false)).toThrow(ProxyCommandRejectedError);
    });

    it('accepts what OpenSSH accepts: IPv6 literals, underscores, dots, a domain user', () => {
        for (const host of ['box', 'my_box.example.com', '::1', 'fe80::1%eth0', '10.0.0.1', 'box-1', 'a+b', 'a=b', 'a@b', 'a~b', 'a#b', 'a,b']) {
            expect(buildProxyCommandSpawn('nc %h %p', tokens(host), false).args).toEqual([host, '22']);
        }
        for (const user of ['me', 'John Smith', 'CORP\\me', 'me$', 'first.last', 'me@corp', 'a-b']) {
            expect(buildProxyCommandSpawn('ssh -l %r b', { h: 'box', n: 'box', p: '22', r: user }, false).args).toEqual(['-l', user, 'b']);
        }
    });

    it('does not name the refused value in the error (it reaches the log and a dialog)', () => {
        try {
            buildProxyCommandSpawn('nc %h %p', tokens('x;secret-ish'), false);
            expect.unreachable();
        } catch (e) {
            expect((e as Error).message).not.toContain('secret-ish');
            expect((e as Error).message).toContain('%h');
        }
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
