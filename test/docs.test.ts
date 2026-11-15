import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

// Drift guards for the docs a reader (or an agent) trusts instead of the code: the CLAUDE.md
// module map, the README's requirements and settings, and the troubleshooting anchor the
// extension links to. Each reads the real files — no fixture copy — so a module added,
// renamed or removed without its doc row, a floor bump, or a new setting fails here.

const repoRoot = path.resolve(__dirname, '..');
const srcDir = path.join(repoRoot, 'src');

function read(relative: string): string {
    return fs.readFileSync(path.join(repoRoot, relative), 'utf8');
}

/** Every `.ts` module under `src/` (no `.d.ts`), as repo-relative POSIX paths. */
function sourceModules(dir = srcDir): string[] {
    const modules: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const entryPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            modules.push(...sourceModules(entryPath));
        } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
            modules.push(path.relative(repoRoot, entryPath).split(path.sep).join('/'));
        }
    }
    return modules;
}

/** The body of the markdown section whose `## ` heading starts with `heading`. */
function section(markdown: string, heading: string): string {
    const start = markdown.indexOf(`\n## ${heading}`);
    expect(start, `section "## ${heading}"`).toBeGreaterThanOrEqual(0);
    const next = markdown.indexOf('\n## ', start + 1);
    return next === -1 ? markdown.slice(start) : markdown.slice(start, next);
}

/** Glob (`*` within one path segment) → anchored regex. */
function globRegex(glob: string): RegExp {
    const escaped = glob.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*');
    return new RegExp(`^${escaped}$`);
}

/** GitHub's heading anchor: lower-case, punctuation dropped, spaces to hyphens. */
function githubSlug(heading: string): string {
    return heading.trim().toLowerCase().replace(/[^\w\- ]/g, '').replace(/ /g, '-');
}

describe('CLAUDE.md architecture table', () => {
    const architecture = section(read('CLAUDE.md'), 'Architecture');
    const mentionedPaths = [...new Set(architecture.match(/src\/[\w./*-]+[\w*]/g) ?? [])];
    const allFiles = sourceModules().concat(
        fs.readdirSync(path.join(srcDir, 'scripts')).map(name => `src/scripts/${name}`),
    );

    it('names some src/ paths at all', () => {
        expect(mentionedPaths.length).toBeGreaterThan(10);
    });

    it('every src/ path it names exists', () => {
        const missing = mentionedPaths.filter(mentioned => {
            if (!mentioned.includes('*')) {
                return !fs.existsSync(path.join(repoRoot, mentioned));
            }
            const pattern = globRegex(mentioned);
            return !allFiles.some(file => pattern.test(file));
        });
        expect(missing, 'paths in the CLAUDE.md architecture section that do not exist').toEqual([]);
    });

    // A module is "in the table" when its full path is named, or its directory is named as
    // `src/<dir>/*` and the row spells out its file name.
    it('every src/**/*.ts module (outside src/scripts) is in it', () => {
        const unlisted = sourceModules()
            .filter(module => !module.startsWith('src/scripts/'))
            .filter(module => {
                if (architecture.includes(module)) {
                    return false;
                }
                const dir = path.posix.dirname(module);
                return !(architecture.includes(`${dir}/*`) && architecture.includes(path.posix.basename(module)));
            });
        expect(unlisted, 'src modules missing from the CLAUDE.md architecture section').toEqual([]);
    });
});

describe('README', () => {
    const readme = read('README.md');

    it('states the same tmux floor as src/tmux/tmuxBootstrap.ts', () => {
        const bootstrap = read('src/tmux/tmuxBootstrap.ts');
        const major = /FLOOR_MAJOR = (\d+);/.exec(bootstrap)?.[1];
        const minor = /FLOOR_MINOR = (\d+);/.exec(bootstrap)?.[1];
        expect(major).toBeDefined();
        expect(minor).toBeDefined();

        const stated = [...readme.matchAll(/tmux\W{0,4}≥\s*(\d+\.\d+)/g)].map(match => match[1]);
        expect(stated.length, 'README states a "tmux ≥ X.Y" floor').toBeGreaterThan(0);
        expect(new Set(stated)).toEqual(new Set([`${major}.${minor}`]));
    });

    // `engines.vscode` is a caret range (`^1.90.0`): its floor is the oldest editor that can
    // install the extension, which is what the README promises users.
    it('states the same editor floor as package.json engines.vscode', () => {
        const manifest = JSON.parse(read('package.json')) as { engines: { vscode: string } };
        const floor = /^\^(\d+)\.(\d+)\.0$/.exec(manifest.engines.vscode);
        expect(floor, `engines.vscode "${manifest.engines.vscode}" is a ^X.Y.0 range`).not.toBeNull();
        const stated = /VS Code or VSCodium \*\*(\d+\.\d+) or newer\*\*/.exec(readme)?.[1];
        expect(stated).toBe(`${floor![1]}.${floor![2]}`);
    });

    it('lists exactly the remote.SSH.tmux.* settings package.json contributes', () => {
        const manifest = JSON.parse(read('package.json')) as {
            contributes: { configuration: { properties: Record<string, unknown> } };
        };
        const declared = Object.keys(manifest.contributes.configuration.properties)
            .filter(key => key.startsWith('remote.SSH.tmux.'))
            .sort();
        const listed = [...new Set(readme.match(/remote\.SSH\.tmux\.\w+/g) ?? [])].sort();
        expect(listed).toEqual(declared);
    });
});

describe('docs/troubleshooting.md', () => {
    it('has the "Terminals closed after disconnect" section', () => {
        expect(read('docs/troubleshooting.md')).toMatch(/^## Terminals closed after disconnect$/m);
    });

    it('has every anchor src/ links to', () => {
        const anchors = new Set(
            [...read('docs/troubleshooting.md').matchAll(/^#{2,6} (.+)$/gm)].map(match => githubSlug(match[1])),
        );
        const linked = sourceModules()
            .flatMap(module => [...read(module).matchAll(/docs\/troubleshooting\.md#([\w-]+)/g)])
            .map(match => match[1]);
        expect(linked.length, 'src/ links into docs/troubleshooting.md').toBeGreaterThan(0);
        expect(linked.filter(anchor => !anchors.has(anchor))).toEqual([]);
    });
});
