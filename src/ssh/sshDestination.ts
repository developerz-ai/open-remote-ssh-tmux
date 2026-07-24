export default class SSHDestination {
    constructor(
        public readonly hostname: string,
        public readonly user?: string,
        public readonly port?: number
    ) {
    }

    static parse(dest: string): SSHDestination {
        let user: string | undefined;
        const atPos = dest.lastIndexOf('@');
        if (atPos !== -1) {
            user = dest.substring(0, atPos);
        }

        const rest = dest.substring(atPos !== -1 ? atPos + 1 : 0);

        // Bracketed literal, e.g. `[::1]` or `[::1]:2222` — the only
        // unambiguous way to combine an IPv6 address (which itself contains
        // colons) with a trailing port.
        const bracketMatch = /^\[(.+)\](?::(\d+))?$/.exec(rest);
        if (bracketMatch) {
            const port = bracketMatch[2] !== undefined ? parseInt(bracketMatch[2], 10) : undefined;
            return new SSHDestination(bracketMatch[1], user, port);
        }

        // Unbracketed: only split on ":" when there is exactly one of them
        // and the suffix is all digits. A bare IPv6 literal (`::1`,
        // `fe80::1`) has more than one colon and must be kept whole instead
        // of being mangled by a "last colon wins" split; a non-numeric
        // suffix (`host:abc`) isn't a port either, so keep the whole string
        // as the hostname rather than manufacturing a NaN port.
        const colonPos = rest.indexOf(':');
        const isSingleColon = colonPos !== -1 && rest.lastIndexOf(':') === colonPos;
        if (isSingleColon) {
            const suffix = rest.substring(colonPos + 1);
            if (/^\d+$/.test(suffix)) {
                return new SSHDestination(rest.substring(0, colonPos), user, parseInt(suffix, 10));
            }
        }

        return new SSHDestination(rest, user, undefined);
    }

    toString(): string {
        // Bracket an IPv6 hostname (contains ':') so re-parsing this string
        // (e.g. via the encoded-authority round trip) can't misread it as
        // `host:port` or mangle it on a bare "last colon" split.
        let hostname = this.hostname;
        if (hostname.includes(':')) {
            hostname = `[${hostname}]`;
        }

        let result = hostname;
        if (this.user) {
            result = `${this.user}@` + result;
        }
        if (this.port) {
            result = result + `:${this.port}`;
        }
        return result;
    }

    // vscode.uri implementation lowercases the authority, so when reopen or restore
    // a remote session from the recently openend list the connection fails
    static parseEncoded(dest: string): SSHDestination {
        try {
            const data: unknown = JSON.parse(Buffer.from(dest, 'hex').toString());
            // Hex-decoding an arbitrary string can "succeed" and still yield
            // JSON that isn't the { hostName, user, port } shape we expect
            // (e.g. the hex string '31' decodes to the JSON number `1`).
            // Validate the shape instead of trusting it, otherwise we'd
            // silently construct a destination with an undefined hostname.
            if (
                typeof data === 'object' &&
                data !== null &&
                typeof (data as { hostName?: unknown }).hostName === 'string'
            ) {
                const decoded = data as { hostName: string; user?: string; port?: number };
                return new SSHDestination(decoded.hostName, decoded.user, decoded.port);
            }
        } catch {
            // ignore
        }

        return SSHDestination.parse(dest.replace(/\\x([0-9a-f]{2})/g, (_, charCode) => String.fromCharCode(parseInt(charCode, 16))));
    }

    toEncodedString(): string {
        return this.toString().replace(/[A-Z]/g, (ch) => `\\x${ch.charCodeAt(0).toString(16).toLowerCase()}`);
    }
}
