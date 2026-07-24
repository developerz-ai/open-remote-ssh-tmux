import { describe, expect, it } from 'vitest';
import { expandTokens, resolveHopPort, buildKeyboardInteractiveFinish } from '../src/authResolver';

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

// `resolveHopPort` is the shared port-default for a ProxyJump hop's own connection
// port and for the next hop's forward-out destination port. Before this fix, the
// *first* form (`src/authResolver.ts:210`) fell back to the final destination's
// port (`sshPort`) instead of 22 when neither the hop's ssh_config `Port` nor the
// port embedded in the ProxyJump destination string was set — inconsistent with
// `:236`, which already defaulted to 22. Both call sites now share this helper.
describe('resolveHopPort', () => {
    it('prefers an explicit ssh_config Port over everything else', () => {
        expect(resolveHopPort('2200', 2201)).toBe(2200);
    });

    it('falls back to the port embedded in the ProxyJump destination when no config Port is set', () => {
        expect(resolveHopPort(undefined, 2201)).toBe(2201);
    });

    it('defaults to 22 — never the final destination\'s port — when nothing else is set', () => {
        expect(resolveHopPort(undefined, undefined)).toBe(22);
    });

    it('accepts an explicit fallback override', () => {
        expect(resolveHopPort(undefined, undefined, 2222)).toBe(2222);
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
