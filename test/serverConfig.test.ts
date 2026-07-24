import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { configOverrides, env } from './mocks/vscode';
import { getVSCodeServerConfig } from '../src/serverConfig';
import Log from '../src/common/logger';

// Characterisation tests for the version/quality/commit policy `getVSCodeServerConfig`
// derives from `product.json` (read from `vscode.env.appRoot`, mocked here) plus
// user-configurable overrides, and for the `serverValidation` enum default/pass-through.
//
// Note: `getVSCodeServerConfig` caches the parsed product.json in a module-level
// variable after the first read, so only the first test in this file actually
// exercises the appRoot -> product.json read; later tests reuse that cached
// value. All fixtures below use identical product.json content, so this is
// harmless — the assertions hold regardless of which call did the actual read.
describe('getVSCodeServerConfig', () => {
    let appRoot: string;
    const logger = new Log('test');

    beforeEach(async () => {
        appRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'server-config-test-'));
        await fs.promises.writeFile(path.join(appRoot, 'product.json'), JSON.stringify({
            commit: 'abc123',
            quality: 'stable',
            release: '',
            serverApplicationName: 'code-server-oss',
            serverDataFolderName: '.vscode-server-oss',
            serverDownloadUrlTemplate: 'https://example.com/${commit}/${quality}',
        }));
        env.appRoot = appRoot;
    });

    afterEach(async () => {
        configOverrides.clear();
        await fs.promises.rm(appRoot, { recursive: true, force: true });
    });

    it('derives version from vscode.version, stripping the -insider suffix', async () => {
        const config = await getVSCodeServerConfig(logger);
        expect(config.version).toBe('1.70.2');
    });

    it('reads commit/quality/release straight from product.json', async () => {
        const config = await getVSCodeServerConfig(logger);
        expect(config.commit).toBe('abc123');
        expect(config.quality).toBe('stable');
        expect(config.release).toBe('');
    });

    it('defaults serverApplicationName to product.json when no override is set', async () => {
        const config = await getVSCodeServerConfig(logger);
        expect(config.serverApplicationName).toBe('code-server-oss');
    });

    it('prefers the user-configured serverBinaryName over product.json', async () => {
        configOverrides.set('remote.SSH.serverBinaryName', 'my-custom-server');
        const config = await getVSCodeServerConfig(logger);
        expect(config.serverApplicationName).toBe('my-custom-server');
    });

    it('defaults serverValidation to "strict" when unset', async () => {
        const config = await getVSCodeServerConfig(logger);
        expect(config.serverValidation).toBe('strict');
    });

    it.each(['force', 'skip', 'strict'] as const)('passes through the valid serverValidation literal %j', async (literal) => {
        configOverrides.set('remote.SSH.serverValidation', literal);
        const config = await getVSCodeServerConfig(logger);
        expect(config.serverValidation).toBe(literal);
    });

    it('falls back to "strict" and logs a warning for an unrecognized serverValidation value', async () => {
        const infoSpy = vi.spyOn(logger, 'info');
        configOverrides.set('remote.SSH.serverValidation', 'Skip');

        const config = await getVSCodeServerConfig(logger);

        expect(config.serverValidation).toBe('strict');
        expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining('Skip'));
        infoSpy.mockRestore();
    });

    it('carries the serverDownloadUrlTemplate from product.json', async () => {
        const config = await getVSCodeServerConfig(logger);
        expect(config.serverDownloadUrlTemplate).toBe('https://example.com/${commit}/${quality}');
    });
});
