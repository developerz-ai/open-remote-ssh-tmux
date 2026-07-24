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

    it('parses a bare IPv6 address (no brackets) as the hostname, last ":" wins as port separator', () => {
        // Current behaviour: the implementation uses lastIndexOf(':'), so an
        // unbracketed IPv6 literal gets split on its final colon group rather
        // than treated as a whole hostname. Documenting actual behaviour, not
        // wished-for IPv6-bracket support (there is none in the source).
        const dest = SSHDestination.parse('::1');
        expect(dest.hostname).toBe(':');
        expect(dest.port).toBe(1);
    });

    it('parses user@ipv6 with a trailing :port the same way (last colon = port)', () => {
        const dest = SSHDestination.parse('alice@2001:db8::1:22');
        expect(dest.user).toBe('alice');
        expect(dest.hostname).toBe('2001:db8::1');
        expect(dest.port).toBe(22);
    });

    it('treats a non-numeric trailing segment after ":" as NaN port', () => {
        const dest = SSHDestination.parse('example.com:abc');
        expect(Number.isNaN(dest.port)).toBe(true);
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
});
