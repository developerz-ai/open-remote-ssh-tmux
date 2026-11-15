import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

// Release-gate contract: the workflows and release config are what decide
// whether an untested or mis-versioned build can ship. These tests read the
// real files (no fixture copies), so a gate quietly dropped from a workflow
// fails here instead of at the next release.

const root = path.resolve(__dirname, '..');
const workflowsDir = path.join(root, '.github', 'workflows');
const vsixGuardPath = path.join(root, '.github', 'scripts', 'check-vsix-contents.js');

interface VsixGuardModule {
    whitelistPatterns(vscodeignore: string): string[];
    compareEntries(entries: string[], patterns: string[]): { unexpected: string[]; missing: string[] };
}

// A plain CommonJS script (package.json declares no "type"), loaded the same
// way publish-node-engines.test.ts loads the packaging-Node guard.
const nodeRequire = createRequire(__filename);
const vsixGuard = nodeRequire(vsixGuardPath) as VsixGuardModule;

interface PackageJson {
    version: string;
    license?: string;
    scripts: Record<string, string>;
    dependencies: Record<string, string>;
    devDependencies: Record<string, string>;
}

interface LockEntry {
    bin?: Record<string, string> | string;
}

function readPackageJson(): PackageJson {
    return JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as PackageJson;
}

function readWorkflow(name: string): string {
    return fs.readFileSync(path.join(workflowsDir, name), 'utf8');
}

const workflowNames = fs.readdirSync(workflowsDir).filter(name => /\.ya?ml$/.test(name));

/** The bins `npm ci` puts on `node_modules/.bin` from the repo's own pinned (direct) dependencies. */
function lockedDirectBins(): Set<string> {
    const pkg = readPackageJson();
    const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8')) as {
        packages: Record<string, LockEntry>;
    };
    const bins = new Set<string>();
    for (const name of [...Object.keys(pkg.dependencies), ...Object.keys(pkg.devDependencies)]) {
        const bin = lock.packages[`node_modules/${name}`]?.bin;
        if (typeof bin === 'string') {
            bins.add(name.replace(/^@[^/]+\//, ''));
        }
        else if (bin) {
            Object.keys(bin).forEach(entry => bins.add(entry));
        }
    }
    return bins;
}

/**
 * The block of one top-level job (`  <name>:` under `jobs:`), up to the next
 * job. Workflows are 2-space YAML, so a job header is the only line at exactly
 * two spaces of indentation inside `jobs:`.
 */
function jobBlock(contents: string, job: string): string | undefined {
    const lines = contents.split('\n');
    const start = lines.findIndex(line => line === `  ${job}:`);
    if (start === -1) {
        return undefined;
    }
    const end = lines.findIndex((line, index) => index > start && /^ {2}[A-Za-z0-9_-]+:\s*$/.test(line));
    return lines.slice(start, end === -1 ? undefined : end).join('\n');
}

function indexOrFail(contents: string, needle: string, file: string): number {
    const index = contents.indexOf(needle);
    expect(index, `${file} does not run \`${needle}\``).toBeGreaterThan(-1);
    return index;
}

describe('workflow hygiene (every workflow)', () => {
    it.each(workflowNames)('pins every action in %s to a full commit SHA', (name) => {
        const unpinned = readWorkflow(name)
            .split('\n')
            .map(line => /^\s*(?:-\s*)?uses:\s*(\S+)/.exec(line)?.[1])
            .filter((ref): ref is string => ref !== undefined && !ref.startsWith('./'))
            .filter(ref => !/@[0-9a-f]{40}$/.test(ref));

        expect(unpinned, `${name} uses actions not pinned to a 40-hex SHA`).toEqual([]);
    });

    it.each(workflowNames)('never masks a failure with `|| true` in %s', (name) => {
        expect(readWorkflow(name)).not.toMatch(/\|\|\s*true/);
    });

    // `npx <bin>` only runs a locked version when that bin comes from one of
    // the repo's own pinned dependencies; anything else is fetched from the
    // registry at whatever version is current — unreviewed code in CI.
    it.each(workflowNames)('only runs `npx` bins that the lockfile pins in %s', (name) => {
        const bins = lockedDirectBins();
        const invocations = [...readWorkflow(name).matchAll(/\bnpx\s+((?:--?[\w-]+\s+)*)(\S+)/g)].map(match => match[2]);

        const unpinned = invocations.filter(bin => !bins.has(bin));
        expect(unpinned, `${name} runs npx bins that are not pinned dependencies`).toEqual([]);
    });

    it.each(workflowNames)('pins every pipx-run tool to an exact version in %s', (name) => {
        const unpinned = [...readWorkflow(name).matchAll(/\bpipx\s+(?:run|install)\b[^\n]*/g)]
            .map(match => match[0])
            .filter(line => !/==\S+/.test(line) && !/\$\{?[A-Z_]+VERSION/.test(line));

        expect(unpinned, `${name} runs pipx tools without an exact version`).toEqual([]);
    });

    it('ignores zizmor findings by rule inline, never by line number in .github/zizmor.yml', () => {
        const config = path.join(root, '.github', 'zizmor.yml');
        if (fs.existsSync(config)) {
            expect(fs.readFileSync(config, 'utf8')).not.toMatch(/\.ya?ml:\d+/);
        }
    });
});

describe('package.json scripts', () => {
    it('never masks a failure with `|| true`', () => {
        const masked = Object.entries(readPackageJson().scripts)
            .filter(([, command]) => /\|\|\s*true/.test(command))
            .map(([name]) => name);

        expect(masked).toEqual([]);
    });

    it('keeps `lint:all` as the full local gate', () => {
        const { scripts } = readPackageJson();

        expect(scripts['lint:all']).toContain('npm run lint:package');
        expect(scripts['lint:all']).toContain('npm audit');
        expect(scripts['lint:all']).toContain('npm run ci:lint');
        expect(scripts['lint:all']).toContain('npm run lint');
    });
});

describe('pull-request and main CI', () => {
    const ciWorkflows = ['ci-pr.yml', 'ci-main.yml'];

    it.each(ciWorkflows)('packages the extension on Node 22 and checks the vsix in %s', (name) => {
        const job = jobBlock(readWorkflow(name), 'package');
        expect(job, `${name} has no \`package\` job`).toBeDefined();

        expect(job).toMatch(/node-version:\s*'22'/);
        const guard = indexOrFail(job!, 'node .github/scripts/check-packaging-node.js', name);
        const pack = indexOrFail(job!, 'npm run package', name);
        const contents = indexOrFail(job!, 'node .github/scripts/check-vsix-contents.js', name);
        expect(guard).toBeLessThan(pack);
        expect(pack).toBeLessThan(contents);
    });

    it.each(ciWorkflows)('enforces the coverage ratchet on Linux in %s', (name) => {
        const job = jobBlock(readWorkflow(name), 'check');
        expect(job, `${name} has no \`check\` job`).toBeDefined();
        indexOrFail(job!, 'npm run test:coverage', name);
    });

    // Windows-only code (ProxyCommand splitting, the PowerShell install path, path
    // handling) otherwise never executes in CI.
    it.each(ciWorkflows)('runs the unit suite on Windows and macOS in %s', (name) => {
        const job = jobBlock(readWorkflow(name), 'unit-os');
        expect(job, `${name} has no \`unit-os\` job`).toBeDefined();

        expect(job).toContain('runs-on: ${{ matrix.os }}');
        expect(job).toMatch(/os:\s*\[windows-latest, macos-latest\]/);
        expect(job).toContain('persist-credentials: false');
        expect(job).toContain('core.autocrlf false');
        const install = indexOrFail(job!, 'npm ci', name);
        const test = indexOrFail(job!, 'npm test', name);
        expect(install).toBeLessThan(test);
    });

    // npm audit and zizmor judge the outside world (new advisories, new rules),
    // so they would red a PR that changed nothing. They run on a schedule instead.
    it.each(ciWorkflows)('keeps registry- and rule-dependent audits out of %s', (name) => {
        const contents = readWorkflow(name);

        expect(contents).not.toContain('lint:all');
        expect(contents).not.toContain('npm audit');
        expect(contents).not.toContain('zizmor');
        indexOrFail(contents, 'npm run lint:package', name);
        indexOrFail(contents, 'npm run lint', name);
    });

    it('runs npm audit and a pinned zizmor on a schedule that reports to an issue', () => {
        const contents = readWorkflow('audit.yml');
        const pinned = /ZIZMOR_VERSION:\s*'?(\d+\.\d+\.\d+)'?/.exec(contents)?.[1];

        expect(contents).toMatch(/^on:\n(?:.*\n)*?\s+schedule:/m);
        expect(contents).toContain('npm audit');
        expect(pinned, 'audit.yml does not pin a zizmor version').toBeDefined();
        expect(contents).toContain('issues: write');
        expect(contents).toContain('gh issue');
    });
});

describe('publish.yml', () => {
    const contents = readWorkflow('publish.yml');

    it('runs build, unit tests and lint before packaging', () => {
        const pack = indexOrFail(contents, 'npm run package', 'publish.yml');

        expect(indexOrFail(contents, 'npm run build', 'publish.yml')).toBeLessThan(pack);
        expect(indexOrFail(contents, 'npm test', 'publish.yml')).toBeLessThan(pack);
        expect(indexOrFail(contents, 'npm run lint', 'publish.yml')).toBeLessThan(pack);
    });

    it('releases the triggering tag and fails when it is not v + package.json version', () => {
        expect(contents, 'the newest tag is not necessarily the one that triggered the run').not.toContain('git tag --sort');
        expect(contents).toContain('GITHUB_REF_NAME');
        expect(contents).toContain('GITHUB_REF_TYPE');
        expect(contents).toMatch(/jq -r \.version package\.json/);

        const check = indexOrFail(contents, 'GITHUB_REF_NAME', 'publish.yml');
        expect(check).toBeLessThan(contents.indexOf('npm run package'));
    });
});

describe('preview.yml', () => {
    const contents = readWorkflow('preview.yml');

    it('runs build, unit tests and lint before packaging', () => {
        const pack = indexOrFail(contents, 'npm run package', 'preview.yml');

        expect(indexOrFail(contents, 'npm run build', 'preview.yml')).toBeLessThan(pack);
        expect(indexOrFail(contents, 'npm test', 'preview.yml')).toBeLessThan(pack);
        expect(indexOrFail(contents, 'npm run lint', 'preview.yml')).toBeLessThan(pack);
    });

    it('refuses to release over an existing tag', () => {
        expect(contents).toMatch(/git rev-parse[^\n]*refs\/tags\//);
    });

    it('links the download to the tag the assets are released under', () => {
        expect(contents).not.toContain('env.VERSION }}');
        expect(contents).toContain('releases/download/${{ env.RELEASE_TAG }}/');
    });
});

describe('moderation workflows', () => {
    it('lets the stale workflow act on pull requests, which it is configured to mark and close', () => {
        const contents = readWorkflow('mod-stale-issue-pr.yml');

        expect(contents).toContain('stale-pr-message');
        expect(contents).toMatch(/permissions:\n(?:\s+\S+: \S+\n)*\s+pull-requests: write/);
    });
});

describe('release-it', () => {
    const contents = fs.readFileSync(path.join(root, '.release-it.yml'), 'utf8');

    it('refuses to release from a dirty working tree', () => {
        expect(contents).toMatch(/requireCleanWorkingDir: true/);
    });

    // bin/check without --full: compile + lint + unit tests, no docker rig.
    it('runs bin/check (without the docker rig) before anything else', () => {
        expect(contents).toMatch(/before:init:\s*bin\/check\s*$/m);
        expect(contents).not.toContain('--full');
    });
});

describe('.tazerc.json', () => {
    it('excludes the real (scoped) commitlint CLI package from taze bumps', () => {
        const taze = JSON.parse(fs.readFileSync(path.join(root, '.tazerc.json'), 'utf8')) as { exclude: string[] };

        expect(readPackageJson().devDependencies).toHaveProperty(['@commitlint/cli']);
        expect(taze.exclude).toContain('@commitlint/cli');
        expect(taze.exclude).not.toContain('commitlint/cli');
    });
});

describe('check-vsix-contents.js', () => {
    const patterns = vsixGuard.whitelistPatterns('*\n*/**\n**/.DS_Store\n!package.json\n!README.md\n!lib/extension.js\n!src/scripts/**\n');
    const metadata = ['extension.vsixmanifest', '[Content_Types].xml'];

    it('takes the whitelist from the `!` lines of .vscodeignore', () => {
        expect(patterns).toEqual(['package.json', 'README.md', 'lib/extension.js', 'src/scripts/**']);
    });

    it('accepts the real .vscodeignore', () => {
        const real = vsixGuard.whitelistPatterns(fs.readFileSync(path.join(root, '.vscodeignore'), 'utf8'));

        expect(real).toContain('lib/extension.js');
        expect(real).toContain('src/scripts/**');
    });

    it('rejects a whitelist pattern it cannot evaluate exactly', () => {
        expect(() => vsixGuard.whitelistPatterns('!lib/*.js\n')).toThrow(/Unsupported/);
    });

    it('passes a vsix holding exactly the whitelist (vsce lowercases README)', () => {
        const entries = [...metadata, 'extension/package.json', 'extension/readme.md', 'extension/lib/extension.js', 'extension/src/scripts/server-setup.sh'];

        expect(vsixGuard.compareEntries(entries, patterns)).toEqual({ unexpected: [], missing: [] });
    });

    it('reports a file the whitelist does not admit', () => {
        const entries = [...metadata, 'extension/package.json', 'extension/readme.md', 'extension/lib/extension.js', 'extension/src/scripts/a.sh', 'extension/src/extension.ts'];

        expect(vsixGuard.compareEntries(entries, patterns)).toEqual({ unexpected: ['extension/src/extension.ts'], missing: [] });
    });

    it('reports a whitelisted file the vsix lacks', () => {
        const entries = [...metadata, 'extension/package.json', 'extension/readme.md', 'extension/src/scripts/a.sh'];

        expect(vsixGuard.compareEntries(entries, patterns)).toEqual({ unexpected: [], missing: ['lib/extension.js'] });
    });
});

// The README tells users to run `sha256sum -c <vsix>.sha256`. That only works when the file
// is in sha256sum's own `<hash>  <file>` format — a bare hash ("no properly formatted checksum
// lines found") shipped with v1.3.0 and v1.4.0.
describe('release checksum file', () => {
    it.each(['publish.yml', 'preview.yml'])('%s writes `<hash>  <file>` so sha256sum -c verifies it', (name) => {
        const contents = readWorkflow(name);
        expect(contents).toMatch(/sha256sum "?\$VSIX_NAME"? > "\$VSIX_NAME\.sha256"/);
        expect(contents).not.toMatch(/echo "\$CHECKSUM" > "\$VSIX_NAME\.sha256"/);
    });
});
