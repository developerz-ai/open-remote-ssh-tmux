import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import SSHConfig, { Directive, Line, Section } from 'ssh-config';
import * as vscode from 'vscode';
import { exists as fileExists, normalizeToSlash, untildify } from '../common/files';
import { isWindows } from '../common/platform';
import { glob } from 'glob';

// Only a few directives might return an array
// https://github.com/cyjake/ssh-config/blob/master/src/ssh-config.ts#L10
export type HostConfiguration = {
    CanonicalDomains?: string | string[];
    GlobalKnownHostsFile?: string | string[];
    Host?: string | string[];
    IPQoS?: string | string[];
    Match?: string | string[];
    ProxyCommand?: string | string[];
    SendEnv?: string | string[];
    UserKnownHostsFile?: string | string[];
} & Record<string, string>;

const systemSSHConfig = isWindows ? path.resolve(process.env.ALLUSERSPROFILE || 'C:\\ProgramData', 'ssh\\ssh_config') : '/etc/ssh/ssh_config';
const defaultSSHConfigPath = path.resolve(os.homedir(), '.ssh/config');

export function getSSHConfigPath() {
    const sshConfigPath = vscode.workspace.getConfiguration('remote.SSH').get<string>('configFile');
    return sshConfigPath ? untildify(sshConfigPath) : defaultSSHConfigPath;
}

function isDirective(line: Line): line is Directive {
    return line.type === SSHConfig.DIRECTIVE;
}

function isHostSection(line: Line): line is Section {
    return isDirective(line) && line.param === 'Host' && !!line.value && !!(line as Section).config;
}

function isIncludeDirective(line: Line): line is Section {
    return isDirective(line) && line.param === 'Include' && !!line.value;
}

const SSH_CONFIG_PROPERTIES: Record<string, string> = {
    'host': 'Host',
    'hostname': 'HostName',
    'user': 'User',
    'port': 'Port',
    'identityagent': 'IdentityAgent',
    'identitiesonly': 'IdentitiesOnly',
    'identityfile': 'IdentityFile',
    'forwardagent': 'ForwardAgent',
    'preferredauthentications': 'PreferredAuthentications',
    'proxyjump': 'ProxyJump',
    'proxycommand': 'ProxyCommand',
    'include': 'Include',
};

function normalizeProp(prop: Directive) {
    prop.param = SSH_CONFIG_PROPERTIES[prop.param.toLowerCase()] || prop.param;
}

function normalizeSSHConfig(config: SSHConfig) {
    for (const line of config) {
        if (isDirective(line)) {
            normalizeProp(line);
        }
        if (isHostSection(line)) {
            normalizeSSHConfig(line.config);
        }
    }
    return config;
}

// OpenSSH caps nested Include expansion at 16 levels (sshd's `includedepth`)
// and errors out beyond that; we mirror the cap but degrade gracefully
// (stop expanding further) rather than throwing, since a malformed/cyclic
// config shouldn't take down the whole extension.
const MAX_INCLUDE_DEPTH = 16;

// Walks `config` looking for Include directives to expand in place, and
// recurses into Host/Match sections so a host-scoped Include (inside a
// `Host foo { Include ... }` block) is honoured too, not just top-level ones.
async function resolveIncludes(config: SSHConfig, userConfig: boolean, visited: Set<string>): Promise<void> {
    const includedConfigs: [number, SSHConfig[]][] = [];
    for (let i = 0; i < config.length; i++) {
        const line = config[i];
        if (isIncludeDirective(line)) {
            const values = (line.value as string).split(',').map(s => s.trim());
            const configs: SSHConfig[] = [];
            for (const value of values) {
                const includePaths = await glob(normalizeToSlash(untildify(value)), {
                    absolute: true,
                    cwd: normalizeToSlash(path.dirname(userConfig ? defaultSSHConfigPath : systemSSHConfig))
                });
                for (const p of includePaths) {
                    configs.push(await parseSSHConfigFromFile(p, userConfig, visited));
                }
            }
            includedConfigs.push([i, configs]);
        } else if (isHostSection(line)) {
            await resolveIncludes(line.config, userConfig, visited);
        }
    }
    for (const [idx, includeConfigs] of includedConfigs.reverse()) {
        config.splice(idx, 1, ...includeConfigs.flat());
    }
}

async function parseSSHConfigFromFile(filePath: string, userConfig: boolean, visited: Set<string> = new Set()): Promise<SSHConfig> {
    // Guard against Include cycles (self-include, mutual A<->B include) and
    // runaway include chains, both of which would otherwise hang the
    // resolver by recursing forever. `visited` tracks the ancestor chain for
    // this branch only, so a diamond-shaped Include (two branches pulling in
    // the same, non-cyclic file) is still expanded normally.
    const resolvedPath = path.resolve(filePath);
    if (visited.has(resolvedPath) || visited.size >= MAX_INCLUDE_DEPTH) {
        return SSHConfig.parse('');
    }

    let content = '';
    if (await fileExists(filePath)) {
        content = (await fs.promises.readFile(filePath, 'utf8')).trim();
    }
    const config = normalizeSSHConfig(SSHConfig.parse(content));

    const nestedVisited = new Set(visited);
    nestedVisited.add(resolvedPath);
    await resolveIncludes(config, userConfig, nestedVisited);

    return config;
}

export default class SSHConfiguration {

    static async loadFromFS(): Promise<SSHConfiguration> {
        const config = await parseSSHConfigFromFile(getSSHConfigPath(), true);
        config.push(...await parseSSHConfigFromFile(systemSSHConfig, false));

        return new SSHConfiguration(config);
    }

    constructor(private sshConfig: SSHConfig) {
    }

    getAllConfiguredHosts(): string[] {
        const hosts = new Set<string>();
        for (const line of this.sshConfig) {
            if (isHostSection(line)) {
                // `Host` accepts a space-separated list of patterns (e.g. `Host dev staging`);
                // every name in the list is a distinct host, not just the first one.
                const values = Array.isArray(line.value) ? line.value.map(v => v.val) : [line.value];
                for (const value of values) {
                    const isPattern = /^!/.test(value) || /[?*]/.test(value);
                    if (!isPattern) {
                        hosts.add(value);
                    }
                }
            }
        }

        return [...hosts.keys()];
    }

    getHostConfiguration(host: string): HostConfiguration {
        return this.sshConfig.compute(host) as HostConfiguration;
    }
}
