import { describe, expect, it } from 'vitest';
import { keepaliveConfig } from '../src/authResolver';

// No keepalive was configured, so a half-dead link (laptop sleep, NAT drop) went
// unnoticed by ssh2 — every channel open on it waited forever. OpenSSH's own knobs
// are honoured when set.
describe('keepaliveConfig', () => {
    it('defaults to a 15 s interval and 3 missed replies', () => {
        expect(keepaliveConfig(undefined, undefined)).toEqual({ keepaliveInterval: 15_000, keepaliveCountMax: 3 });
    });

    it('honours ServerAliveInterval (seconds) and ServerAliveCountMax', () => {
        expect(keepaliveConfig('30', '5')).toEqual({ keepaliveInterval: 30_000, keepaliveCountMax: 5 });
    });

    it('keeps ServerAliveInterval 0 as "disabled", as in OpenSSH', () => {
        expect(keepaliveConfig('0', undefined).keepaliveInterval).toBe(0);
    });

    it('ignores a value that is not a whole number', () => {
        expect(keepaliveConfig('soon', '-1')).toEqual({ keepaliveInterval: 15_000, keepaliveCountMax: 3 });
    });
});
