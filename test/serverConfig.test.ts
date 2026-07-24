import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { configOverrides, env } from './mocks/vscode';
import { getVSCodeServerConfig } from '../src/serverConfig';

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
        const config = await getVSCodeServerConfig();
        expect(config.version).toBe('1.70.2');
    });

    it('reads commit/quality/release straight from product.json', async () => {
        const config = await getVSCodeServerConfig();
        expect(config.commit).toBe('abc123');
        expect(config.quality).toBe('stable');
        expect(config.release).toBe('');
    });

    it('defaults serverApplicationName to product.json when no override is set', async () => {
        const config = await getVSCodeServerConfig();
        expect(config.serverApplicationName).toBe('code-server-oss');
    });

    it('prefers the user-configured serverBinaryName over product.json', async () => {
        configOverrides.set('remote.SSH.serverBinaryName', 'my-custom-server');
        const config = await getVSCodeServerConfig();
        expect(config.serverApplicationName).toBe('my-custom-server');
    });

    it('defaults serverValidation to "strict" when unset', async () => {
        const config = await getVSCodeServerConfig();
        expect(config.serverValidation).toBe('strict');
    });

    it('passes through a configured serverValidation value', async () => {
        configOverrides.set('remote.SSH.serverValidation', 'skip');
        const config = await getVSCodeServerConfig();
        expect(config.serverValidation).toBe('skip');
    });

    it('carries the serverDownloadUrlTemplate from product.json', async () => {
        const config = await getVSCodeServerConfig();
        expect(config.serverDownloadUrlTemplate).toBe('https://example.com/${commit}/${quality}');
    });
});
