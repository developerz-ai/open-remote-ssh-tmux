import { describe, expect, it, vi } from 'vitest';
import { expandTokens, resolveHopPort, resolveHostName, resolveProxyJumpHop, resolveUser, buildKeyboardInteractiveFinish, connectionsToClose } from '../src/authResolver';
import type SSHConnection from '../src/ssh/sshConnection';

// `expandTokens` replaces OpenSSH-style `%x` config tokens (HostName, ProxyCommand
// args). The code it replaces used single-shot `String.replace(token, value)` calls
// chained per token, which only ever hit the *first* occurrence of a repeated token
// and had no way to emit a literal `%` (`%%`). See `src/authResolver.ts:182,241`.
describe('expandTokens', () => {
    it('replaces every occurrence of a repeated token', () => {
        expect(expandTokens('%h %h', { h: 'example.com' })).toBe('example.com example.com');
    });

    it('treats %% as a literal percent, not a token lookup', () => {
        expect(expandTokens('%%h', { h: 'example.com' })).toBe('%h');
    });

    it('expands multiple distinct tokens in one pass', () => {
        expect(expandTokens('%r@%h:%p', { r: 'alice', h: 'example.com', p: '2222' })).toBe('alice@example.com:2222');
    });

    it('leaves an unrecognised token sequence untouched', () => {
        expect(expandTokens('%z', { h: 'example.com' })).toBe('%z');
    });

    it('passes through a template with no tokens unchanged', () => {
        expect(expandTokens('bastion', { h: 'example.com' })).toBe('bastion');
    });

    it('handles a trailing lone % with nothing after it', () => {
        expect(expandTokens('foo%', { h: 'example.com' })).toBe('foo%');
    });
});

// `resolveHopPort` is the shared port rule for the destination, a ProxyJump hop's own
// connection and the next hop's forward-out port. A port written in the destination
// (`host:2201`, the equivalent of `ssh -p`) beats ssh_config `Port`, as in OpenSSH;
// upstream had it the other way round. With neither, a hop defaults to 22 — never the
// final destination's port.
describe('resolveHopPort', () => {
    it('prefers the port written in the destination over ssh_config Port', () => {
        expect(resolveHopPort('2200', 2201)).toBe(2201);
    });

    it('falls back to ssh_config Port when the destination names none', () => {
        expect(resolveHopPort('2200', undefined)).toBe(2200);
    });

    it('defaults to 22 — never the final destination\'s port — when nothing else is set', () => {
        expect(resolveHopPort(undefined, undefined)).toBe(22);
    });

    it('accepts an explicit fallback override', () => {
        expect(resolveHopPort(undefined, undefined, 2222)).toBe(2222);
    });
});

// `ssh admin@box` logs in as admin whatever `User` the config sets for box; the
// resolver let the config win, so `admin@box` silently became `deploy@box`. The local
// user name is the last resort and is only looked up then: `os.userInfo()` throws for a
// UID with no passwd entry, which must not stop a connect that names its user.
describe('resolveUser', () => {
    const local = () => 'local';

    it('prefers the user written in the destination over ssh_config User', () => {
        expect(resolveUser('admin', 'deploy', local)).toBe('admin');
    });

    it('falls back to ssh_config User, then to the local user', () => {
        expect(resolveUser(undefined, 'deploy', local)).toBe('deploy');
        expect(resolveUser(undefined, undefined, local)).toBe('local');
        expect(resolveUser('', '', local)).toBe('local');
    });

    it('does not look the local user up when a user is given', () => {
        const noPasswdEntry = vi.fn(() => {
            throw new Error('ENOENT: no such user');
        });

        expect(resolveUser('admin', undefined, noPasswdEntry)).toBe('admin');
        expect(resolveUser(undefined, 'deploy', noPasswdEntry)).toBe('deploy');
        expect(noPasswdEntry).not.toHaveBeenCalled();
    });
});

// A ProxyJump hop is its own `ssh` invocation: its user is the `user@` of its ProxyJump
// entry, else that hop's own config `User`, else the local user — never the login of the
// final destination, which `admin@box` behind `ProxyJump bastion` used to hand to bastion.
describe('resolveProxyJumpHop', () => {
    const local = () => 'local';

    it('takes user, host and port from the ProxyJump entry first', () => {
        expect(resolveProxyJumpHop({ hostname: 'bastion', user: 'jump', port: 2201 }, { HostName: '%h.corp', User: 'cfg', Port: '2200' }, local))
            .toEqual({ hostName: 'bastion.corp', user: 'jump', port: 2201 });
    });

    it('falls back to the hop\'s own config', () => {
        expect(resolveProxyJumpHop({ hostname: 'bastion' }, { User: 'cfg', Port: '2200' }, local))
            .toEqual({ hostName: 'bastion', user: 'cfg', port: 2200 });
    });

    it('falls back to the local user and port 22 — it has no way to see the destination\'s', () => {
        expect(resolveProxyJumpHop({ hostname: 'bastion' }, {}, local)).toEqual({ hostName: 'bastion', user: 'local', port: 22 });
        expect(resolveProxyJumpHop.length).toBe(3);
    });
});

// `HostName` takes `%h` (and `%%`). The destination expanded it; a ProxyJump hop used
// the raw value, so a hop under `Host *.corp` / `HostName %h.internal` was dialled as
// the literal `%h.internal`.
describe('resolveHostName', () => {
    it('expands %h to the name the host was asked for', () => {
        expect(resolveHostName('%h.internal', 'bastion')).toBe('bastion.internal');
    });

    it('uses the asked-for name when HostName is unset', () => {
        expect(resolveHostName(undefined, 'bastion')).toBe('bastion');
    });

    it('keeps %% as a literal %', () => {
        expect(resolveHostName('a%%b', 'x')).toBe('a%b');
    });
});

// `buildKeyboardInteractiveFinish` decides what to hand ssh2's keyboard-interactive
// `finish()` callback. Before this fix (`src/authResolver.ts:602-618`), cancelling a
// prompt mid-sequence (`showInputBox` returning `undefined`) broke out of the
// collection loop and called `finish()` with a *shorter* array than `prompts`,
// desyncing the protocol, and then unconditionally decremented the retry counter
// (already zeroed on cancel) into negative territory. The fix always sends a
// full-length array and reports whether retries should be considered exhausted so
// the retry counter is set exactly once, never decremented past that.
describe('buildKeyboardInteractiveFinish', () => {
    it('passes collected responses through unchanged when not cancelled', () => {
        expect(buildKeyboardInteractiveFinish(2, ['a', 'b'], false)).toEqual({
            finishWith: ['a', 'b'],
            retriesExhausted: false,
        });
    });

    it('pads a cancelled mid-sequence response array out to the full prompt count', () => {
        expect(buildKeyboardInteractiveFinish(3, ['a'], true)).toEqual({
            finishWith: ['a', '', ''],
            retriesExhausted: true,
        });
    });

    it('pads from empty when cancelled on the very first prompt', () => {
        expect(buildKeyboardInteractiveFinish(2, [], true)).toEqual({
            finishWith: ['', ''],
            retriesExhausted: true,
        });
    });

    it('never truncates below the prompt count even if responses is somehow longer', () => {
        expect(buildKeyboardInteractiveFinish(1, ['a', 'b'], true)).toEqual({
            finishWith: ['a'],
            retriesExhausted: true,
        });
    });
});

// `dispose()` closed only `proxyConnections[0]` when a ProxyJump chain was in
// play, relying on ending that first hop to cascade — via the forwarded-stream
// chain each later hop's `sock` was opened on — down through every subsequent
// hop and the destination connection sitting on top of it. That's an implicit
// side effect of the transport, not something `dispose()` should depend on: a
// hop past the first, or the destination connection itself, could be left
// unclosed. `connectionsToClose` is the pure list of everything `dispose()`
// must close explicitly. See `src/authResolver.ts` `dispose()`.
describe('connectionsToClose: dispose() must close the destination connection and every proxy hop', () => {
    it('closes just the destination connection when there is no ProxyJump chain', () => {
        const main = {} as SSHConnection;
        expect(connectionsToClose(main, [])).toEqual([main]);
    });

    it('closes the destination connection plus the single hop (not only the hop)', () => {
        const main = {} as SSHConnection;
        const hop0 = {} as SSHConnection;
        expect(connectionsToClose(main, [hop0])).toEqual([main, hop0]);
    });

    it('closes the destination connection plus every hop in a multi-hop chain', () => {
        const main = {} as SSHConnection;
        const hop0 = {} as SSHConnection;
        const hop1 = {} as SSHConnection;
        const hop2 = {} as SSHConnection;
        expect(connectionsToClose(main, [hop0, hop1, hop2])).toEqual([main, hop0, hop1, hop2]);
    });

    it('omits the destination connection when resolve failed before it was created', () => {
        const hop0 = {} as SSHConnection;
        expect(connectionsToClose(undefined, [hop0])).toEqual([hop0]);
    });

    it('returns an empty list when nothing was ever connected', () => {
        expect(connectionsToClose(undefined, [])).toEqual([]);
    });
});
