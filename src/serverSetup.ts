import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import Log from './common/logger';
import { escapeShellArg } from './common/shellQuote';
import { getVSCodeServerConfig, ServerVersion, ServerValidation } from './serverConfig';
import SSHConnection from './ssh/sshConnection';
import { fetchRelease, IRelease } from './fetchRelease';

/**
 * Reads a script template from <extensionPath>/scripts/<templateName> and
 * replaces every %%KEY%% occurrence with the matching value from `variables`.
 */
export function compileTemplate(templateName: string, variables: Record<string, string>, extensionPath: string): string {
    const templatePath = path.join(extensionPath, 'src', 'scripts', templateName);
    let content = fs.readFileSync(templatePath, 'utf8');
    for (const [key, value] of Object.entries(variables)) {
        // A replacer *function* is required here, not the raw `value` string:
        // String.replace(regex, someString) treats "$&"/"$$"/"$1" etc. in the
        // replacement string as special patterns (insert-the-match,
        // literal-$, insert-capture-group). A templated value containing any
        // of those (e.g. a URL query string, a path) would silently corrupt
        // the compiled script. `() => value` always inserts it literally.
        content = content.replace(new RegExp(`%%${key}%%`, 'g'), () => value);
    }
    return content;
}

/**
 * Matches a hostname against a pattern that may contain wildcards.
 * Returns a specificity score: higher scores indicate more specific matches.
 * Returns -1 if no match.
 */
function matchHostnamePattern(hostname: string, pattern: string): number {
    // Exact match has highest priority
    if (hostname === pattern) {
        return 1000;
    }

    // Catch-all wildcard has lowest priority
    if (pattern === '*') {
        return 1;
    }

    // Convert wildcard pattern to regex
    // Escape special regex characters except *
    const regexPattern = pattern
        .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*');

    const regex = new RegExp(`^${regexPattern}$`);

    if (regex.test(hostname)) {
        // Calculate specificity based on the number of non-wildcard characters
        // More specific patterns (more characters) get higher scores
        const nonWildcardChars = pattern.replace(/\*/g, '').length;
        return 10 + nonWildcardChars;
    }

    return -1;
}

/**
 * Finds the best matching path for a hostname from a map of patterns to paths.
 * Supports wildcards with priority: exact match > specific wildcard > general wildcard.
 */
export function findServerInstallPath(hostname: string, pathMap: Record<string, string>): string | undefined {
    let bestMatch: { pattern: string; path: string; score: number } | undefined;

    for (const [pattern, path] of Object.entries(pathMap)) {
        const score = matchHostnamePattern(hostname, pattern);

        if (score > 0) {
            if (!bestMatch || score > bestMatch.score) {
                bestMatch = { pattern, path, score };
            }
        }
    }

    return bestMatch?.path;
}

export type ServerInstallOptions = {
    id: string;
    quality: string;
    commit: string;
    version: string;
    release?: string;
    extensionIds: string[];
    envVariables: string[];
    useSocketPath: boolean;
    serverApplicationName: string;
    serverDataFolderName: string;
    serverDownloadUrlTemplate: string;
    customInstallPath?: string;
    serverValidation: ServerValidation;
};

export type ServerInstallResult = {
    exitCode: number;
    listeningOn: number | string;
    connectionToken: string;
    logFile: string;
    osReleaseId: string;
    arch: string;
    platform: string;
    tmpDir: string;
    [key: string]: unknown;
};

export class ServerInstallError extends Error {
    constructor(message: string) {
        super(message);
    }
}

const DEFAULT_DOWNLOAD_URL_TEMPLATE = 'https://github.com/VSCodium/vscodium/releases/download/${version}.${release}/vscodium-reh-${os}-${arch}-${version}.${release}.tar.gz';

export async function installCodeServer(
    conn: SSHConnection,
    serverDownloadUrlTemplate: string | undefined,
    serverVersion: ServerVersion,
    extensionIds: string[],
    envVariables: string[],
    platform: string | undefined,
    useSocketPath: boolean,
    customInstallPath: string | undefined,
    logger: Log,
    extensionPath: string
): Promise<ServerInstallResult> {
    let shell = 'powershell';

    // detect platform and shell for windows
    if (!platform || platform === 'windows') {
        const result = await conn.exec('uname -s');

        if (result.stdout) {
            if (result.stdout.includes('windows32')) {
                platform = 'windows';
            } else if (result.stdout.includes('MINGW64')) {
                platform = 'windows';
                shell = 'bash';
            }
        } else if (result.stderr) {
            if (result.stderr.includes('FullyQualifiedErrorId : CommandNotFoundException')) {
                platform = 'windows';
            }

            if (result.stderr.includes('is not recognized as an internal or external command')) {
                platform = 'windows';
                shell = 'cmd';
            }
        }

        if (platform) {
            logger.trace(`Detected platform: ${platform}, ${shell}`);
        }
    }

    const scriptId = crypto.randomBytes(12).toString('hex');

    const vscodeServerConfig = await getVSCodeServerConfig();

    // Get the version and release
    const serverDownloadUrlTemplateFinal = serverDownloadUrlTemplate || vscodeServerConfig.serverDownloadUrlTemplate || DEFAULT_DOWNLOAD_URL_TEMPLATE;
    const bestRelease: IRelease = await fetchRelease(serverDownloadUrlTemplateFinal, vscodeServerConfig.version, vscodeServerConfig.release, serverVersion, logger);

    const installOptions: ServerInstallOptions = {
        id: scriptId,
        version: bestRelease.version,
        commit: vscodeServerConfig.commit,
        quality: vscodeServerConfig.quality,
        release: bestRelease.build,
        extensionIds,
        envVariables,
        useSocketPath,
        serverApplicationName: vscodeServerConfig.serverApplicationName,
        serverDataFolderName: vscodeServerConfig.serverDataFolderName,
        serverDownloadUrlTemplate: serverDownloadUrlTemplateFinal,
        customInstallPath,
        serverValidation: vscodeServerConfig.serverValidation,
    };

    let commandOutput: { stdout: string; stderr: string };
    if (platform === 'windows') {
        const installServerScript = generatePowerShellInstallScript(installOptions, extensionPath);

        logger.trace('Server install command:', installServerScript);

        const installDir = `$HOME\\${vscodeServerConfig.serverDataFolderName}\\install`;
        const installScript = `${installDir}\\${vscodeServerConfig.commit}.ps1`;
        const endRegex = new RegExp(`${scriptId}: end`);

        // investigate if it's possible to use `-EncodedCommand` flag
        // https://devblogs.microsoft.com/powershell/invoking-powershell-with-complex-expressions-using-scriptblocks/
        // eslint-disable-next-line no-useless-assignment
        let command = '';

        if (shell === 'powershell') {
            command = `md -Force ${installDir}; echo @'\n${installServerScript}\n'@ | Set-Content ${installScript}; powershell -ExecutionPolicy ByPass -File "${installScript}"`;
        } else if (shell === 'bash') {
            command = `mkdir -p ${installDir.replace(/\\/g, '/')} && echo '\n${installServerScript.replace(/'/g, '\'"\'"\'')}\n' > ${installScript.replace(/\\/g, '/')} && powershell -ExecutionPolicy ByPass -File "${installScript}"`;
        } else if (shell === 'cmd') {
            const script = installServerScript.trim()
                // remove comments
                .replace(/^#.*$/gm, '')
                // remove empty lines
                .replace(/\n{2,}/gm, '\n')
                // remove leading spaces
                .replace(/^\s*/gm, '')
                // escape double quotes (from powershell/cmd)
                .replace(/"/g, '"""')
                // escape single quotes (from cmd)
                .replace(/'/g, `''`)
                // escape redirect (from cmd)
                .replace(/>/g, `^>`)
                // escape new lines (from powershell/cmd)
                .replace(/\n/g, '\'`n\'');

            command = `powershell "md -Force ${installDir}" && powershell "echo '${script}'" > ${installScript.replace('$HOME', '%USERPROFILE%')} && powershell -ExecutionPolicy ByPass -File "${installScript.replace('$HOME', '%USERPROFILE%')}"`;

            logger.trace('Command length (8191 max):', command.length);

            if (command.length > 8191) {
                throw new ServerInstallError(`Command line too long`);
            }
        } else {
            throw new ServerInstallError(`Not supported shell: ${shell}`);
        }

        commandOutput = await conn.execPartial(command, (stdout: string) => endRegex.test(stdout));
    } else {
        const installServerScript = generateBashInstallScript(installOptions, extensionPath);

        logger.trace('Server install command:', installServerScript);
        // Use base64 encoding to avoid shell quoting issues across different login shells (bash, csh, tcsh, fish).
        // csh cannot handle multi-line strings inside single quotes with -c, so piping via base64 is the most portable approach.
        const base64Script = Buffer.from(installServerScript).toString('base64');
        commandOutput = await conn.exec(`echo ${base64Script} | base64 -d | bash -l`);
    }

    if (commandOutput.stderr) {
        logger.trace('Server install command stderr:', commandOutput.stderr);
    }
    logger.trace('Server install command stdout:', commandOutput.stdout);

    const resultMap = parseServerInstallOutput(commandOutput.stdout, scriptId);
    if (!resultMap) {
        throw new ServerInstallError(`Failed parsing install script output`);
    }

    const exitCode = parseInt(resultMap.exitCode, 10);
    if (exitCode !== 0) {
        throw new ServerInstallError(`Couldn't install vscode server on remote server, install script returned non-zero exit status`);
    }

    const listeningOn = resultMap.listeningOn.match(/^\d+$/)
        ? parseInt(resultMap.listeningOn, 10)
        : resultMap.listeningOn;

    const remoteEnvVars = Object.fromEntries(Object.entries(resultMap).filter(([key,]) => envVariables.includes(key)));

    return {
        exitCode,
        listeningOn,
        connectionToken: resultMap.connectionToken,
        logFile: resultMap.logFile,
        osReleaseId: resultMap.osReleaseId,
        arch: resultMap.arch,
        platform: resultMap.platform,
        tmpDir: resultMap.tmpDir,
        ...remoteEnvVars
    };
}

// Each result line is emitted by the scripts as `key==value==` (see
// print_install_results_and_exit in server-setup.sh/.ps1). A plain
// `line.split('==')` breaks on a value that itself contains "==" (e.g. a
// URL query string) — the destructured `[key, value]` silently drops
// everything past the 2nd segment. Anchoring on the trailing "==" and
// capturing greedily up to it preserves any "==" inside the value.
const RESULT_LINE_PATTERN = /^(\w+)==(.*)==$/;

export function parseServerInstallOutput(str: string, scriptId: string): { [k: string]: string } | undefined {
    const startResultStr = `${scriptId}: start`;
    const endResultStr = `${scriptId}: end`;

    const startResultIdx = str.indexOf(startResultStr);
    if (startResultIdx < 0) {
        return undefined;
    }

    const endResultIdx = str.indexOf(endResultStr, startResultIdx + startResultStr.length);
    if (endResultIdx < 0) {
        return undefined;
    }

    const installResult = str.substring(startResultIdx + startResultStr.length, endResultIdx);

    const resultMap: { [k: string]: string } = {};
    const resultArr = installResult.split(/\r?\n/);
    for (const line of resultArr) {
        if (!line) {
            // Blank lines (leading/trailing newline around the markers)
            // previously produced a bogus resultMap[''] entry.
            continue;
        }
        const match = line.match(RESULT_LINE_PATTERN);
        if (!match) {
            continue;
        }
        const [, key, value] = match;
        resultMap[key] = value;
    }

    return resultMap;
}

// `customInstallPath` comes from the user-configurable `remote.SSH.serverInstallPath`
// setting (per-host path map, see authResolver.ts's `findServerInstallPath`
// lookup) that server-setup.sh's
// `SERVER_DATA_DIR=%%SERVER_DATA_DIR%%` assignment splices in unquoted, so
// the *value itself* must supply safe shell quoting — a bare double-quoted
// substitution can't defend against embedded `"`/`` ` ``/`$( )` (CLAUDE.md
// injection guardrail). `~`/`~/…` still needs runtime `$HOME` expansion, so
// that prefix is emitted raw (unquoted, safe in an assignment RHS — bash
// doesn't word-split there) and only the remainder is single-quoted.
export function escapeCustomInstallPath(customInstallPath: string): string {
    const homeShorthand = customInstallPath.match(/^~(?=\/|$)/);
    if (!homeShorthand) {
        return escapeShellArg(customInstallPath);
    }

    const rest = customInstallPath.slice(1);
    return rest ? `$HOME${escapeShellArg(rest)}` : '$HOME';
}

export function generateBashInstallScript({ id, quality, version, commit, release, extensionIds, envVariables, useSocketPath, serverApplicationName, serverDataFolderName, serverDownloadUrlTemplate, customInstallPath, serverValidation }: ServerInstallOptions, extensionPath: string): string {
    const extensions = extensionIds.map(extId => '--install-extension ' + extId).join(' ');
    const serverDataDir = customInstallPath
        ? escapeCustomInstallPath(customInstallPath)
        : `$HOME/${serverDataFolderName}`;
    const listenFlag = useSocketPath
        ? `--socket-path="$TMP_DIR/vscode-server-sock-${crypto.randomUUID()}"`
        : '--port=0';
    const envVarLines = envVariables.map(envVar => `  echo "${envVar}==$${envVar}=="`).join('\n');

    return compileTemplate('server-setup.sh', {
        DISTRO_VERSION: version,
        DISTRO_COMMIT: commit,
        DISTRO_QUALITY: quality,
        DISTRO_VSCODIUM_RELEASE: release ?? '',
        SERVER_APP_NAME: serverApplicationName,
        SERVER_INITIAL_EXTENSIONS: extensions,
        SERVER_LISTEN_FLAG: listenFlag,
        SERVER_DATA_DIR: serverDataDir,
        SERVER_DATA_DIR_FLAG: customInstallPath ? '--server-data-dir="$SERVER_DATA_DIR"' : '',
        SERVER_VALIDATION_FLAG: serverValidation === 'skip' ? '--disable-client-validation' : '',
        // Single-quoted at template time (see server-setup.sh's now-unquoted
        // `SERVER_DOWNLOAD_URL="$(echo %%SERVER_DOWNLOAD_URL_TEMPLATE%% | ...)"`)
        // so the whole user-configurable URL template is inert shell data —
        // this also makes the old `${` → `\${` escaping unnecessary, since
        // single quotes already stop all expansion before it reaches `sed`.
        SERVER_DOWNLOAD_URL_TEMPLATE: escapeShellArg(serverDownloadUrlTemplate),
        SCRIPT_ID: id,
        ENV_VAR_LINES: envVarLines,
        MODIFY_PRODUCT_JSON: serverValidation === 'force' ? 'true' : 'false',
        SERVER_CONNECTION_TOKEN: crypto.randomUUID(),
    }, extensionPath);
}

function generatePowerShellInstallScript({ id, quality, version, commit, release, extensionIds, envVariables, useSocketPath, serverApplicationName, serverDataFolderName, serverDownloadUrlTemplate, customInstallPath, serverValidation }: ServerInstallOptions, extensionPath: string): string {
    const extensions = extensionIds.map(extId => '--install-extension ' + extId).join(' ');
    const downloadUrl = serverDownloadUrlTemplate
        .replace(/\$\{quality\}/g, quality)
        .replace(/\$\{version\}/g, version)
        .replace(/\$\{commit\}/g, commit)
        .replace(/\$\{os\}/g, 'win32')
        .replace(/\$\{arch\}/g, 'x64')
        .replace(/\$\{release\}/g, release ?? '');
    const serverDataDir = customInstallPath
        ? customInstallPath.replace(/^~(?=[\\/]|$)/, '$(Resolve-Path ~)')
        : `$(Resolve-Path ~)\\${serverDataFolderName}`;
    const listenFlag = useSocketPath
        ? `--socket-path="$TMP_DIR/vscode-server-sock-${crypto.randomUUID()}"`
        : '--port=0';
    const envVarLines = envVariables.map(envVar => `    "$${envVar}==$${envVar}=="`).join('\n');

    return compileTemplate('server-setup.ps1', {
        DISTRO_VERSION: version,
        DISTRO_COMMIT: commit,
        DISTRO_QUALITY: quality,
        DISTRO_VSCODIUM_RELEASE: release ?? '',
        SERVER_APP_NAME: serverApplicationName,
        SERVER_INITIAL_EXTENSIONS: extensions,
        SERVER_LISTEN_FLAG: listenFlag,
        SERVER_DATA_DIR: serverDataDir,
        SERVER_DATA_DIR_FLAG: customInstallPath ? '--server-data-dir=""$SERVER_DATA_DIR""' : '',
        SERVER_VALIDATION_FLAG: serverValidation === 'skip' ? '--disable-client-validation' : '',
        SERVER_DOWNLOAD_URL: downloadUrl,
        SCRIPT_ID: id,
        ENV_VAR_LINES: envVarLines,
        MODIFY_PRODUCT_JSON: serverValidation === 'force' ? '$true' : '$false',
        SERVER_CONNECTION_TOKEN: crypto.randomUUID(),
    }, extensionPath);
}
