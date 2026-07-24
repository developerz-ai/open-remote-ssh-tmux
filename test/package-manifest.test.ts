import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { KILL_WORKSPACE_SESSIONS_COMMAND_ID } from '../src/commands';

// Drift guard: package.json's `contributes` is hand-authored and easy to let go
// stale (settings renamed/typo'd, a command's id changed in one place but not the
// other). These tests read the manifest itself — no fixture copy — so a future
// edit to package.json or src/*.ts registrations trips a real assertion instead of
// silently drifting apart.

const repoRoot = path.resolve(__dirname, '..');
const packageJsonPath = path.resolve(repoRoot, 'package.json');
const srcDir = path.resolve(repoRoot, 'src');

interface JsonObject {
    [key: string]: unknown;
}

function readPackageJson(): JsonObject {
    const raw = fs.readFileSync(packageJsonPath, 'utf8');
    return JSON.parse(raw) as JsonObject;
}

/** Recursively collect every `.ts` file under `dir` (source only, no `.d.ts`). */
function collectTsFiles(dir: string): string[] {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const files: string[] = [];
    for (const entry of entries) {
        const entryPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            files.push(...collectTsFiles(entryPath));
        } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
            files.push(entryPath);
        }
    }
    return files;
}

/** Recursively collect every `.md` file under `dir`. */
function collectAllMarkdownFiles(dir: string): string[] {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const files: string[] = [];
    for (const entry of entries) {
        const entryPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            files.push(...collectAllMarkdownFiles(entryPath));
        } else if (entry.isFile() && entry.name.endsWith('.md')) {
            files.push(entryPath);
        }
    }
    return files;
}

/**
 * Every `export const NAME = '<string literal>'` in `src/`, so a `registerCommand(NAME)`
 * call (an identifier, not an inline literal — e.g. the kill command, which shares its
 * id with `commands.ts`'s exported constant per this task's requirement) can be
 * resolved back to the id it registers.
 */
function exportedStringConstants(): Map<string, string> {
    const constants = new Map<string, string>();
    const exportedConst = /export const (\w+)\s*=\s*(['"])([^'"]+)\2/g;
    for (const file of collectTsFiles(srcDir)) {
        const contents = fs.readFileSync(file, 'utf8');
        for (const match of contents.matchAll(exportedConst)) {
            constants.set(match[1], match[3]);
        }
    }
    return constants;
}

/**
 * Every command id passed as the first argument to a `registerCommand(` call across
 * `src/` — whether an inline string literal or an identifier referencing an exported
 * `const` (resolved via {@link exportedStringConstants}).
 */
function registeredCommandIds(): Set<string> {
    const ids = new Set<string>();
    const constants = exportedStringConstants();
    const registerCommandCall = /registerCommand\(\s*(?:(['"])([^'"]+)\1|([A-Za-z_$][\w$]*))/g;
    for (const file of collectTsFiles(srcDir)) {
        const contents = fs.readFileSync(file, 'utf8');
        for (const match of contents.matchAll(registerCommandCall)) {
            const [, , literal, identifier] = match;
            if (literal !== undefined) {
                ids.add(literal);
            } else if (identifier !== undefined && constants.has(identifier)) {
                ids.add(constants.get(identifier)!);
            }
        }
    }
    return ids;
}

describe('package.json manifest drift guard', () => {
    const pkg = readPackageJson();
    const contributes = pkg.contributes as JsonObject;
    const configuration = contributes.configuration as JsonObject;
    const properties = configuration.properties as Record<string, JsonObject>;
    const commands = contributes.commands as Array<{ command: string }>;

    describe('tmux settings', () => {
        it('declares remote.SSH.tmux.enabled with the documented default', () => {
            const enabled = properties['remote.SSH.tmux.enabled'];
            expect(enabled).toBeDefined();
            expect(enabled.type).toBe('string');
            expect(enabled.default).toBe('auto');
            expect(enabled.enum).toEqual(['auto', 'off', 'on']);
        });

        it('declares remote.SSH.tmux.historyLimit with the documented default', () => {
            const historyLimit = properties['remote.SSH.tmux.historyLimit'];
            expect(historyLimit).toBeDefined();
            expect(historyLimit.type).toBe('number');
            expect(historyLimit.default).toBe(50000);
        });

        it('declares remote.SSH.tmux.reapOnConnect with the documented default', () => {
            const reapOnConnect = properties['remote.SSH.tmux.reapOnConnect'];
            expect(reapOnConnect).toBeDefined();
            expect(reapOnConnect.type).toBe('boolean');
            expect(reapOnConnect.default).toBe(true);
        });

        it('every remote.SSH.tmux.* setting mentioned in docs/ exists in package.json', () => {
            // Collect all `remote.SSH.tmux.*` setting names from docs/
            const docsDir = path.resolve(repoRoot, 'docs');
            const allMarkdownFiles = collectAllMarkdownFiles(docsDir);

            const mentionedSettingsInDocs = new Set<string>();
            const tmuxSettingRegex = /remote\.SSH\.tmux\.\w+/g;

            for (const file of allMarkdownFiles) {
                const contents = fs.readFileSync(file, 'utf8');
                for (const match of contents.matchAll(tmuxSettingRegex)) {
                    mentionedSettingsInDocs.add(match[0]);
                }
            }

            // Verify each setting is present in package.json
            const missingSettings: string[] = [];
            for (const setting of mentionedSettingsInDocs) {
                if (!properties[setting]) {
                    missingSettings.push(setting);
                }
            }

            expect(
                missingSettings,
                `These remote.SSH.tmux.* settings are mentioned in docs/ but missing from package.json configuration: ${missingSettings.join(', ')}`
            ).toEqual([]);
        });
    });

    it('the kill command\'s manifest id matches the constant exported by commands.ts', () => {
        const killCommand = commands.find(c => c.command === KILL_WORKSPACE_SESSIONS_COMMAND_ID);
        expect(killCommand, `expected contributes.commands to contain "${KILL_WORKSPACE_SESSIONS_COMMAND_ID}"`).toBeDefined();
    });

    it('every contributes.commands id is backed by a real registerCommand(...) call in src/', () => {
        const registered = registeredCommandIds();
        const missing = commands
            .map(c => c.command)
            .filter(id => !registered.has(id));

        expect(missing, `command ids with no matching registerCommand(...) in src/: ${missing.join(', ')}`).toEqual([]);
    });

    describe('fork identity', () => {
        it('is named open-remote-ssh-tmux', () => {
            expect(pkg.name).toBe('open-remote-ssh-tmux');
        });

        it('is published under the fork org, not upstream\'s jeanp413', () => {
            expect(pkg.publisher).not.toBe('jeanp413');
            expect(pkg.publisher).toBe('developerz-ai');
        });

        it('repository url points at the fork org, not upstream jeanp413/open-remote-ssh', () => {
            const repository = pkg.repository as JsonObject;
            expect(repository.url).toContain('developerz-ai/open-remote-ssh-tmux');
            expect(repository.url).not.toContain('jeanp413/open-remote-ssh.git');
        });
    });
});

describe('README fork identity', () => {
    const readme = fs.readFileSync(path.resolve(repoRoot, 'README.md'), 'utf8');

    it('references the fork\'s own extension id', () => {
        expect(readme).toContain('developerz-ai.open-remote-ssh-tmux');
    });

    it('does not tell users to allowlist upstream\'s jeanp413.open-remote-ssh id', () => {
        expect(readme).not.toContain('jeanp413.open-remote-ssh"');
        expect(readme).not.toContain('jeanp413.open-remote-ssh\'');
    });
});

describe('CHANGELOG', () => {
    it('has a first heading that parses as valid semver via get-changelog logic', () => {
        const changelog = fs.readFileSync(path.resolve(repoRoot, 'CHANGELOG.md'), 'utf8');
        const firstHeading = changelog.match(/^## (\d+\.\d+\.\d+)/m);
        expect(firstHeading, 'CHANGELOG.md must start with a "## x.y.z" heading').not.toBeNull();

        const version = firstHeading![1];
        const versionRegex = new RegExp(`## ${version}([^#]|#(?!#))*(?=## |$)`, 's');
        const match = changelog.match(versionRegex);
        expect(match, `get-changelog regex found no section for ${version}`).not.toBeNull();

        const notes = match![0].replace(/^## \d+\.\d+\.\d+\n/, '').trim();
        expect(notes.length).toBeGreaterThan(0);
    });

    it('first heading is 1.0.0, the fork\'s rebrand release', () => {
        const changelog = fs.readFileSync(path.resolve(repoRoot, 'CHANGELOG.md'), 'utf8');
        const firstHeading = changelog.match(/^## (\d+\.\d+\.\d+)/m);
        expect(firstHeading![1]).toBe('1.0.0');
    });
});
