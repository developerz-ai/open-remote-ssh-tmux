import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
    compileTemplate,
    escapeCustomInstallPath,
    generateBashInstallScript,
    parseServerInstallOutput,
    ServerInstallOptions,
} from '../src/serverSetup';

// `compileTemplate` reads `<extensionPath>/src/scripts/<templateName>` off
// disk, so tests write throwaway template files into a tmpdir shaped like
// that layout rather than mocking `fs` — same pattern as `serverConfig.test.ts`.
describe('compileTemplate', () => {
    let extensionPath: string;

    beforeEach(async () => {
        extensionPath = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'compile-template-test-'));
        await fs.promises.mkdir(path.join(extensionPath, 'src', 'scripts'), { recursive: true });
    });

    afterEach(async () => {
        await fs.promises.rm(extensionPath, { recursive: true, force: true });
    });

    async function writeTemplate(name: string, content: string): Promise<void> {
        await fs.promises.writeFile(path.join(extensionPath, 'src', 'scripts', name), content);
    }

    it('replaces a plain placeholder', async () => {
        await writeTemplate('t.sh', 'VALUE="%%KEY%%"');
        expect(compileTemplate('t.sh', { KEY: 'hello' }, extensionPath)).toBe('VALUE="hello"');
    });

    it('replaces every occurrence of a repeated placeholder', async () => {
        await writeTemplate('t.sh', '%%KEY%% and %%KEY%% again');
        expect(compileTemplate('t.sh', { KEY: 'x' }, extensionPath)).toBe('x and x again');
    });

    it('inserts a value containing "$&" verbatim instead of the regex-match special pattern', async () => {
        // String.prototype.replace(regex, someString) treats "$&" in the
        // *replacement string* as "insert the whole match" — a raw
        // `content.replace(re, value)` call would corrupt any value
        // containing "$&" by re-inserting "%%KEY%%" into the output. The
        // fix uses a replacer function `() => value` so the value is always
        // inserted literally.
        await writeTemplate('t.sh', 'VALUE="%%KEY%%"');
        expect(compileTemplate('t.sh', { KEY: 'contains $& literally' }, extensionPath))
            .toBe('VALUE="contains $& literally"');
    });

    it('inserts a value containing "$$" verbatim instead of a collapsed literal dollar', async () => {
        // "$$" in a replacement string means "insert a literal $" (i.e.
        // collapses to a single "$") under the buggy raw-string replace.
        await writeTemplate('t.sh', 'VALUE="%%KEY%%"');
        expect(compileTemplate('t.sh', { KEY: 'contains $$ literally' }, extensionPath))
            .toBe('VALUE="contains $$ literally"');
    });
});

describe('parseServerInstallOutput', () => {
    const scriptId = 'abc123';

    function wrap(lines: string): string {
        return `noise before\n${scriptId}: start\n${lines}\n${scriptId}: end\nnoise after`;
    }

    it('returns undefined when the start marker is missing', () => {
        expect(parseServerInstallOutput('no markers here', scriptId)).toBeUndefined();
    });

    it('returns undefined when the end marker is missing', () => {
        expect(parseServerInstallOutput(`${scriptId}: start\nexitCode==0==`, scriptId)).toBeUndefined();
    });

    it('parses a simple key==value== line', () => {
        const result = parseServerInstallOutput(wrap('exitCode==0=='), scriptId);
        expect(result).toEqual({ exitCode: '0' });
    });

    it('preserves "==" occurring inside the value', () => {
        const result = parseServerInstallOutput(wrap('listeningOn==http://x?a==b=='), scriptId);
        expect(result?.listeningOn).toBe('http://x?a==b');
    });

    it('skips blank lines instead of producing a bogus "" key', () => {
        const result = parseServerInstallOutput(wrap('exitCode==0==\n\nplatform==linux=='), scriptId);
        // toEqual is exact-shape: this also proves no stray `''` key exists.
        expect(result).toEqual({ exitCode: '0', platform: 'linux' });
    });

    it('parses multiple lines, including an empty value', () => {
        const result = parseServerInstallOutput(wrap('exitCode==0==\nconnectionToken====\narch==x64=='), scriptId);
        expect(result).toEqual({ exitCode: '0', connectionToken: '', arch: 'x64' });
    });
});

describe('escapeCustomInstallPath', () => {
    it('single-quotes a plain path', () => {
        expect(escapeCustomInstallPath('/opt/vscode-server')).toBe(`'/opt/vscode-server'`);
    });

    it('preserves spaces safely inside single quotes', () => {
        expect(escapeCustomInstallPath('/opt/my dir')).toBe(`'/opt/my dir'`);
    });

    it('neutralises a double-quote/backtick/command-substitution injection attempt', () => {
        const hostile = `/tmp"; rm -rf ~; echo "`;
        const expr = escapeCustomInstallPath(hostile);
        // Must be a single, fully single-quoted shell word: no unescaped
        // double quote can appear outside of the quoting the helper itself
        // controls.
        expect(expr).toBe(`'${hostile.replace(/'/g, `'\\''`)}'`);
    });

    it('expands a bare "~" to $HOME, unescaped', () => {
        expect(escapeCustomInstallPath('~')).toBe('$HOME');
    });

    it('expands a "~/…" prefix to $HOME while single-quoting the remainder', () => {
        expect(escapeCustomInstallPath('~/my dir')).toBe(`$HOME'/my dir'`);
    });

    it('does not expand "~user" (not a bare-home shorthand)', () => {
        expect(escapeCustomInstallPath('~root/foo')).toBe(`'~root/foo'`);
    });

    it('escapes an embedded single quote correctly (round-trips through the standard POSIX trick)', () => {
        expect(escapeCustomInstallPath(`/tmp/it's here`)).toBe(`'/tmp/it'\\''s here'`);
    });
});

describe('generateBashInstallScript', () => {
    // Exercise the real template shipped in src/scripts/server-setup.sh so
    // this test would catch a template/TS-side mismatch (e.g. leaving a
    // %%KEY%% wrapped in quotes that the escaping helper already supplies).
    const extensionPath = path.join(__dirname, '..');

    function baseOptions(overrides: Partial<ServerInstallOptions> = {}): ServerInstallOptions {
        return {
            id: 'script-id-123',
            quality: 'stable',
            commit: 'deadbeef',
            version: '1.90.0',
            release: '25026',
            extensionIds: [],
            envVariables: [],
            useSocketPath: false,
            serverApplicationName: 'code-server-oss',
            serverDataFolderName: '.vscode-server-oss',
            serverDownloadUrlTemplate: 'https://example.com/${commit}/${quality}-${version}',
            serverValidation: 'strict',
            ...overrides,
        };
    }

    it('leaves no unreplaced %%KEY%% placeholder in the output', () => {
        const script = generateBashInstallScript(baseOptions({ customInstallPath: '/opt/my dir' }), extensionPath);
        expect(script).not.toMatch(/%%[A-Z_]+%%/);
    });

    it('single-quote-escapes a customInstallPath containing spaces and quotes', () => {
        const script = generateBashInstallScript(
            baseOptions({ customInstallPath: `/opt/my dir/it's "weird"` }),
            extensionPath
        );
        expect(script).toContain(`SERVER_DATA_DIR=${escapeCustomInstallPath(`/opt/my dir/it's "weird"`)}`);
    });

    it('round-trips a customInstallPath containing shell metacharacters as inert data (no injection)', () => {
        const hostile = '/tmp/`id`; $(whoami) "$(rm -rf ~)"';
        const script = generateBashInstallScript(baseOptions({ customInstallPath: hostile }), extensionPath);
        const line = script.split('\n').find(l => l.startsWith('SERVER_DATA_DIR='));
        expect(line).toBe(`SERVER_DATA_DIR=${escapeCustomInstallPath(hostile)}`);
    });

    it('single-quote-escapes the download URL template', () => {
        const script = generateBashInstallScript(
            baseOptions({ serverDownloadUrlTemplate: 'https://example.com/${version}; rm -rf ~' }),
            extensionPath
        );
        expect(script).toContain(`echo 'https://example.com/\${version}; rm -rf ~' | sed`);
    });
});
