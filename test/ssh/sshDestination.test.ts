import { describe, expect, it } from 'vitest';
import SSHDestination from '../../src/ssh/sshDestination';

// Characterisation tests for SSHDestination: parse a `user@host:port` style
// destination string, round-trip it back via toString(), and the hex-encoded
// variant used for vscode-remote authorities (see the comment on parseEncoded
// in src/ssh/sshDestination.ts — vscode.Uri lowercases the authority, so a
// case-preserving hostname must survive that round trip via encoding).
describe('SSHDestination.parse', () => {
    it('parses hostname only', () => {
        const dest = SSHDestination.parse('example.com');
        expect(dest.hostname).toBe('example.com');
        expect(dest.user).toBeUndefined();
        expect(dest.port).toBeUndefined();
    });

    it('parses user@host', () => {
        const dest = SSHDestination.parse('alice@example.com');
        expect(dest.user).toBe('alice');
        expect(dest.hostname).toBe('example.com');
        expect(dest.port).toBeUndefined();
    });

    it('parses host:port', () => {
        const dest = SSHDestination.parse('example.com:2222');
        expect(dest.hostname).toBe('example.com');
        expect(dest.port).toBe(2222);
    });

    it('parses user@host:port', () => {
        const dest = SSHDestination.parse('alice@example.com:2222');
        expect(dest.user).toBe('alice');
        expect(dest.hostname).toBe('example.com');
        expect(dest.port).toBe(2222);
    });

    it('parses a bare IPv6 address (no brackets) as the whole hostname, no port', () => {
        // Multiple colons => bare IPv6 literal, not a "host:port" split.
        const dest = SSHDestination.parse('::1');
        expect(dest.hostname).toBe('::1');
        expect(dest.port).toBeUndefined();
    });

    it('parses user@<bare IPv6> keeping the address whole, no port', () => {
        const dest = SSHDestination.parse('user@::1');
        expect(dest.user).toBe('user');
        expect(dest.hostname).toBe('::1');
        expect(dest.port).toBeUndefined();
    });

    it('parses a link-local bare IPv6 address whole', () => {
        const dest = SSHDestination.parse('fe80::1');
        expect(dest.hostname).toBe('fe80::1');
        expect(dest.port).toBeUndefined();
    });

    it('parses a bracketed IPv6 address with a port', () => {
        const dest = SSHDestination.parse('[::1]:2222');
        expect(dest.hostname).toBe('::1');
        expect(dest.port).toBe(2222);
    });

    it('parses a bracketed IPv6 address without a port', () => {
        const dest = SSHDestination.parse('[::1]');
        expect(dest.hostname).toBe('::1');
        expect(dest.port).toBeUndefined();
    });

    it('parses user@[bracketed IPv6]:port', () => {
        const dest = SSHDestination.parse('user@[::1]:2222');
        expect(dest.user).toBe('user');
        expect(dest.hostname).toBe('::1');
        expect(dest.port).toBe(2222);
    });

    it('a non-numeric trailing segment after ":" is not treated as a port', () => {
        // Previously produced a NaN port; now the whole string is kept as
        // the hostname since "abc" isn't a valid port suffix.
        const dest = SSHDestination.parse('host:abc');
        expect(dest.hostname).toBe('host:abc');
        expect(dest.port).toBeUndefined();
    });
});

describe('SSHDestination#toString', () => {
    it('renders hostname only', () => {
        expect(new SSHDestination('example.com').toString()).toBe('example.com');
    });

    it('renders user@host', () => {
        expect(new SSHDestination('example.com', 'alice').toString()).toBe('alice@example.com');
    });

    it('renders host:port', () => {
        expect(new SSHDestination('example.com', undefined, 2222).toString()).toBe('example.com:2222');
    });

    it('renders user@host:port', () => {
        expect(new SSHDestination('example.com', 'alice', 2222).toString()).toBe('alice@example.com:2222');
    });

    it('omits the port when it is 0 (falsy)', () => {
        expect(new SSHDestination('example.com', 'alice', 0).toString()).toBe('alice@example.com');
    });

    it('round-trips parse -> toString for a full destination', () => {
        const original = 'alice@example.com:2222';
        expect(SSHDestination.parse(original).toString()).toBe(original);
    });

    it('brackets an IPv6 hostname so parse -> toString round-trips', () => {
        const original = 'alice@[::1]:2222';
        const dest = SSHDestination.parse(original);
        expect(dest.toString()).toBe(original);
        // and re-parsing the rendered string yields the same components
        const reparsed = SSHDestination.parse(dest.toString());
        expect(reparsed.hostname).toBe('::1');
        expect(reparsed.port).toBe(2222);
    });
});

describe('SSHDestination.toEncodedString / parseEncoded', () => {
    it('escapes uppercase letters as \\xHH so they survive authority lowercasing', () => {
        const dest = new SSHDestination('MyHost.example.com', 'Alice');
        const encoded = dest.toEncodedString();
        // 'A' = 0x41, 'M' = 0x4d, 'H' = 0x48; lowercase letters and '.'/'@' pass through untouched.
        expect(encoded).toBe('\\x41lice@\\x4dy\\x48ost.example.com');
    });

    it('round-trips toEncodedString -> parseEncoded, preserving original case', () => {
        const original = new SSHDestination('MyHost.example.com', 'Alice', 2222);
        const roundTripped = SSHDestination.parseEncoded(original.toEncodedString());
        expect(roundTripped.hostname).toBe('MyHost.example.com');
        expect(roundTripped.user).toBe('Alice');
        expect(roundTripped.port).toBe(2222);
    });

    it('parseEncoded falls back to plain parse() for a non-hex, non-escaped string', () => {
        const dest = SSHDestination.parseEncoded('alice@example.com:2222');
        expect(dest.hostname).toBe('example.com');
        expect(dest.user).toBe('alice');
        expect(dest.port).toBe(2222);
    });

    it('parseEncoded decodes a JSON hex payload (the vscode.Uri restore path)', () => {
        const payload = JSON.stringify({ hostName: 'MyHost.example.com', user: 'Alice', port: 2222 });
        const hex = Buffer.from(payload).toString('hex');
        const dest = SSHDestination.parseEncoded(hex);
        expect(dest.hostname).toBe('MyHost.example.com');
        expect(dest.user).toBe('Alice');
        expect(dest.port).toBe(2222);
    });

    it('parseEncoded rejects a hex payload that decodes to non-object JSON, falling back to parse()', () => {
        // '31' is valid hex for the single byte 0x31 ('1'); Buffer-decoding
        // and JSON.parse'ing it yields the number 1, not a { hostName } shape.
        // Previously this produced a SSHDestination with an undefined
        // hostname; it must now fall back to treating '31' as a plain
        // destination string instead.
        const dest = SSHDestination.parseEncoded('31');
        expect(dest.hostname).toBe('31');
        expect(dest.user).toBeUndefined();
        expect(dest.port).toBeUndefined();
    });
});
