import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchRelease, splitRelease } from '../src/fetchRelease';
import Log from '../src/common/logger';

// splitRelease normalizes every VSCodium release-name scheme into a common
// {version, build} shape so the rest of fetchRelease never has to care which
// scheme produced a given release. Four schemes exist in the wild:
//   - pre-1.99, dot-separated 4-part: 1.96.4.25026
//   - 1.99+, fused 3-part:            1.112.02593
//   - version with no build at all:   1.112.0
//   - unrecognized/non-version name:  nightly (fallback, empty build)
describe('splitRelease', () => {
    it('parses the pre-1.99 dot-separated 4-part scheme', () => {
        expect(splitRelease('1.96.4.25026')).toEqual({ version: '1.96.4', build: '25026' });
    });

    it('parses the 1.99+ fused 3-part scheme', () => {
        expect(splitRelease('1.112.02593')).toEqual({ version: '1.112.0', build: '2593' });
    });

    it('parses a bare version with no build as an empty build', () => {
        expect(splitRelease('1.112.0')).toEqual({ version: '1.112.0', build: '' });
    });

    it('falls back to the raw name for an unrecognized release name', () => {
        expect(splitRelease('nightly')).toEqual({ version: 'nightly', build: '' });
    });
});

function githubReleases(names: string[]): Array<{ name: string }> {
    return names.map(name => ({ name }));
}

function mockFetchOnce(response: { ok: boolean; status?: number; statusText?: string; json?: () => Promise<unknown> }): ReturnType<typeof vi.fn> {
    const fetchMock = vi.fn().mockResolvedValue({
        ok: response.ok,
        status: response.status ?? (response.ok ? 200 : 500),
        statusText: response.statusText ?? '',
        json: response.json ?? (() => Promise.resolve([])),
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
}

describe('fetchRelease', () => {
    const logger = new Log('test');
    const template = 'https://github.com/VSCodium/vscodium/releases/download/${version}.${release}/vscodium-reh-${os}-${arch}-${version}.${release}.tar.gz';

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('falls back to the local version when the response is not ok', async () => {
        mockFetchOnce({ ok: false, status: 403, statusText: 'rate limit exceeded' });

        const result = await fetchRelease(template, '1.96.4', '25026', 'latest', logger);

        expect(result).toEqual({ version: '1.96.4', build: '25026' });
    });

    it('requests up to 100 releases per page', async () => {
        const fetchMock = mockFetchOnce({ ok: true, json: () => Promise.resolve(githubReleases([])) });

        await fetchRelease(template, '1.96.4', '25026', 'latest', logger);

        const requestedUrl = fetchMock.mock.calls[0][0] as string;
        expect(requestedUrl).toContain('per_page=100');
    });

    it('aborts the request after a timeout instead of hanging forever', async () => {
        const fetchMock = mockFetchOnce({ ok: true, json: () => Promise.resolve(githubReleases([])) });

        await fetchRelease(template, '1.96.4', '25026', 'latest', logger);

        const requestOptions = fetchMock.mock.calls[0][1] as RequestInit;
        expect(requestOptions.signal).toBeInstanceOf(AbortSignal);
    });

    it('finds an exact pinned pre-1.99 release (dot-separated) even though the pin has no separator match with the fused name', async () => {
        mockFetchOnce({
            ok: true,
            json: () => Promise.resolve(githubReleases(['1.96.4.25026', '1.96.4.25025', '1.97.0.1'])),
        });

        const result = await fetchRelease(template, '1.96.0', '0', '1.96.4.25026', logger);

        expect(result).toEqual({ version: '1.96.4', build: '25026' });
    });

    it('lets a release with an empty build survive the "latest" comparison', async () => {
        mockFetchOnce({
            ok: true,
            json: () => Promise.resolve(githubReleases(['1.112.0', '1.111.02593'])),
        });

        const result = await fetchRelease(template, '1.0.0', '0', 'latest', logger);

        expect(result).toEqual({ version: '1.112.0', build: '' });
    });

    it('picks the highest build for the same version when selecting "latest"', async () => {
        mockFetchOnce({
            ok: true,
            json: () => Promise.resolve(githubReleases(['1.112.02593', '1.112.02001', '1.111.09999'])),
        });

        const result = await fetchRelease(template, '1.0.0', '0', 'latest', logger);

        expect(result).toEqual({ version: '1.112.0', build: '2593' });
    });
});
