import { describe, expect, it } from 'vitest';
import { buildWebviewHtml, newNonce } from '../../src/clipboard/clipboardWebview';

// The webview reads the user's clipboard with scripts enabled. Without a Content Security
// Policy the page may load or run anything that ever reaches its DOM; with one it can run
// exactly the script this extension wrote and reach nothing on the network.

/** The CSP the page declares, as written in its meta tag. */
const csp = (html: string): string => {
    const match = /<meta http-equiv="Content-Security-Policy" content="([^"]*)">/.exec(html);
    if (!match) {
        throw new Error('no CSP meta tag');
    }
    return match[1];
};

describe('buildWebviewHtml: a CSP that allows only our own nonce-tagged script and style', () => {
    const html = buildWebviewHtml('abc123');

    it('denies everything by default', () => {
        expect(csp(html)).toContain('default-src \'none\'');
    });

    it('allows scripts only by nonce, and tags the page script with it', () => {
        expect(csp(html)).toContain('script-src \'nonce-abc123\'');
        expect(html).toContain('<script nonce="abc123">');
        expect(html.match(/<script/g)).toHaveLength(1);
    });

    it('allows styles only by nonce, so no inline style attributes are left behind', () => {
        expect(csp(html)).toContain('style-src \'nonce-abc123\'');
        expect(html).toContain('<style nonce="abc123">');
        expect(html).not.toMatch(/\sstyle="/);
    });

    it('never falls back to unsafe-inline or unsafe-eval', () => {
        expect(csp(html)).not.toContain('unsafe-');
    });

    it('declares the CSP before the script that it governs', () => {
        expect(html.indexOf('Content-Security-Policy')).toBeLessThan(html.indexOf('<script'));
    });
});

describe('newNonce: unguessable per page', () => {
    it('is fresh each call and safe inside a CSP source expression', () => {
        const a = newNonce();
        expect(a).not.toBe(newNonce());
        expect(a).toMatch(/^[A-Za-z0-9+/]{22,}={0,2}$/);
    });
});
