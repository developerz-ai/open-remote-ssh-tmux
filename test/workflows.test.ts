import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as os from 'node:os';
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

interface ChangelogModule {
    changelogEntry(changelog: string, version: string): string | undefined;
}

const changelogScript = nodeRequire(path.join(root, '.github', 'scripts', 'get-changelog.js')) as ChangelogModule;

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

/** The names of the top-level jobs (the two-space keys under `jobs:`). */
function jobNames(contents: string): string[] {
    const lines = contents.split('\n');
    const start = lines.indexOf('jobs:');
    return lines.slice(start + 1)
        .map(line => /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line)?.[1])
        .filter((name): name is string => name !== undefined);
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

    // GitHub's default is 360 minutes: a hung step (an ssh2 handshake, a docker pull)
    // would otherwise hold a runner for six hours before anyone sees red.
    it.each(workflowNames)('bounds every job in %s with timeout-minutes', (name) => {
        const contents = readWorkflow(name);
        const jobs = jobNames(contents);
        expect(jobs.length, `${name} has no jobs`).toBeGreaterThan(0);

        const unbounded = jobs.filter(job => !/^ {4}timeout-minutes:\s*\d+\s*$/m.test(jobBlock(contents, job)!));
        expect(unbounded, `${name} has jobs without timeout-minutes`).toEqual([]);
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

    it.each(ciWorkflows)('packages the extension on the .nvmrc Node and checks the vsix in %s', (name) => {
        const job = jobBlock(readWorkflow(name), 'package');
        expect(job, `${name} has no \`package\` job`).toBeDefined();

        expect(job).toContain('node-version-file: .nvmrc');
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

    // The docs are tested too (docs.test.ts, pr-batching.test.ts, the CHANGELOG checks),
    // and `check` is the required merge check: a Markdown-only change that skipped CI
    // could merge a broken doc unchecked, or wait forever on a check that never starts.
    it.each(ciWorkflows)('runs on every change, Markdown included, in %s', (name) => {
        expect(readWorkflow(name)).not.toMatch(/^\s+paths(?:-ignore)?:/m);
    });

    // A new push to a PR makes the running checks moot; finishing them only delays the
    // ones that matter. Pushes to main are never cancelled: each commit keeps its verdict.
    it('cancels superseded pull-request runs', () => {
        expect(readWorkflow('ci-pr.yml')).toMatch(/^concurrency:\n\s+group: [^\n]*github\.event\.pull_request\.number[^\n]*\n\s+cancel-in-progress: true$/m);
    });

    // Any concurrency group on main is unsafe, `cancel-in-progress: false` included: a
    // group holds one running and one PENDING run, and a newer push replaces the pending
    // one, so that commit never gets a verdict.
    const declaresConcurrency = (contents: string): boolean => /^\s*concurrency:/m.test(contents);

    it('recognises a concurrency group at any level, in any form', () => {
        expect(declaresConcurrency('on: push\nconcurrency:\n  group: main\n  cancel-in-progress: false\njobs: {}\n')).toBe(true);
        expect(declaresConcurrency('on: push\nconcurrency: main\njobs: {}\n')).toBe(true);
        expect(declaresConcurrency('on: push\njobs:\n  check:\n    concurrency: main\n    runs-on: ubuntu-latest\n')).toBe(true);
        expect(declaresConcurrency('on: push\njobs:\n  check:\n    runs-on: ubuntu-latest\n')).toBe(false);
    });

    it('never queues main pushes in a concurrency group, so none is replaced while pending', () => {
        expect(declaresConcurrency(readWorkflow('ci-main.yml'))).toBe(false);
    });

    // npm ci from the npm cache instead of the registry on every job. Safe here: these
    // workflows release nothing (the release workflows below never read a cache).
    it.each(ciWorkflows)('caches npm downloads in every setup-node step of %s', (name) => {
        const steps = readWorkflow(name).split(/^\s+- name: /m).filter(step => step.includes('actions/setup-node@'));
        expect(steps.length).toBeGreaterThan(0);
        steps.forEach(step => expect(step).toMatch(/^\s+cache: npm$/m));
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

// A cache written by a PR or main run must never flow into a released vsix (zizmor's
// cache-poisoning class): the release workflows install from the registry, cold.
describe('release workflows', () => {
    it.each(['publish.yml', 'preview.yml'])('never restores a dependency cache in %s', (name) => {
        const contents = readWorkflow(name);

        expect(contents).not.toMatch(/^\s+cache:/m);
        expect(contents).not.toContain('actions/cache');
        expect(contents).toContain('package-manager-cache: false');
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
    // Staleness (issues, PRs, branches) is .dz/maintainer/maintainer.yml's alone: a second
    // sweeper on its own windows (actions/stale at 90/30 days) contradicted its 60.
    it('leaves stale issues and pull requests to the maintainer config, not actions/stale', () => {
        expect(workflowNames).not.toContain('mod-stale-issue-pr.yml');
        workflowNames.forEach(name => expect(readWorkflow(name), name).not.toContain('actions/stale@'));
        expect(fs.readFileSync(path.join(root, '.dz', 'maintainer', 'maintainer.yml'), 'utf8')).toMatch(/^\s+stale_after_days: \d+/m);
    });

    // @daiyam/artifact-lang-js ships mod-stale-issue-pr.yml: without this, the next
    // `npm run update:artifacts` would quietly bring the deleted workflow back.
    it('stops update:artifacts from restoring the deleted stale workflow', () => {
        const artifactrc = fs.readFileSync(path.join(root, '.artifactrc.yml'), 'utf8');

        expect(artifactrc).toMatch(/^ {6}\.github\/workflows\/mod-stale-issue-pr\.yml:\n {8}if_missing: skip$/m);
    });

    it('keeps locking long-closed threads', () => {
        expect(readWorkflow('mod-lock-closed-threads.yml')).toContain('dessant/lock-threads@');
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
    const taze = JSON.parse(fs.readFileSync(path.join(root, '.tazerc.json'), 'utf8')) as {
        exclude: string[];
        packageMode: Record<string, string>;
    };

    // The runtime contracts, not the toolchain: @types/vscode is fetched to match
    // engines.vscode (update:dts), and @types/node types the Node 20 extension host.
    it('never bumps the runtime typings past the extension host', () => {
        expect(taze.exclude).toContain('@types/vscode');
        expect(taze.packageMode['@types/node']).toBe('minor');
    });

    // These were held back only while the toolchain ran on Node 20 (their current
    // majors need Node 22+); on the .nvmrc Node they update like everything else.
    it('no longer holds back tooling that only needed a newer Node', () => {
        for (const name of ['@commitlint/cli', '@commitlint/config-conventional', 'lint-staged']) {
            expect(taze.exclude).not.toContain(name);
        }
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

// publish.yml builds the release body from `get-changelog.js v<version>`.
describe('get-changelog.js', () => {
    const changelog = [
        '## 1.4.20', '', '- twenty', '',
        '## 1.4.2', '', '**Connecting**', '', '- two', '', '### Details', '', '- more', '',
        '## 1.4.1', '', '- one', '',
    ].join('\n');

    it('returns the exact version\'s section, not one it is a prefix of', () => {
        expect(changelogScript.changelogEntry(changelog, 'v1.4.2')).toBe('**Connecting**\n\n- two\n\n### Details\n\n- more');
    });

    it('reads the last section to the end of the file', () => {
        expect(changelogScript.changelogEntry(changelog, 'v1.4.1')).toBe('- one');
    });

    it('treats the version literally, not as a pattern', () => {
        expect(changelogScript.changelogEntry('## 1x4x2\n\n- wrong\n', 'v1.4.2')).toBeUndefined();
    });

    it('finds the section for package.json\'s version in the real CHANGELOG.md', () => {
        const real = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');

        expect(changelogScript.changelogEntry(real, `v${readPackageJson().version}`)).toMatch(/\S/);
    });
});

// bin/check is the local gate and release-it's `before:init`: a failed step must fail it.
// `set -e` does not stop on a failure inside an `a && b && c` list (only on its last
// command), so a stub npm on PATH proves each step's failure reaches the exit status.
describe.runIf(process.platform !== 'win32')('bin/check', () => {
    function runCheck(failing: string, args: string[] = []): { status: number | null; calls: string[] } {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bin-check-'));
        try {
            const calls = path.join(directory, 'calls');
            fs.writeFileSync(path.join(directory, 'npm'),
                '#!/bin/sh\nprintf "%s\\n" "$*" >> "$CALLS"\n[ "$*" = "$FAILING" ] && exit 3\nexit 0\n', { mode: 0o755 });
            const result = spawnSync('sh', [path.join(root, 'bin', 'check'), ...args], {
                encoding: 'utf8',
                env: { ...process.env, PATH: `${directory}${path.delimiter}${process.env.PATH}`, CALLS: calls, FAILING: failing },
                timeout: 15000,
            });
            expect(result.error).toBeUndefined();
            return { status: result.status, calls: fs.readFileSync(calls, 'utf8').trim().split('\n') };
        } finally {
            fs.rmSync(directory, { recursive: true, force: true });
        }
    }

    it.each(['run compile:src', 'run lint', 'test'])('fails, and stops, when `npm %s` fails', (step) => {
        const { status, calls } = runCheck(step, ['--full']);

        expect(status).toBe(3);
        expect(calls[calls.length - 1]).toBe(step);
        expect(calls).not.toContain('run test:tmux');
    });

    it('runs compile, lint and the unit tests, then the rig with --full', () => {
        expect(runCheck('none')).toEqual({ status: 0, calls: ['run compile:src', 'run lint', 'test'] });
        expect(runCheck('none', ['--full']).calls).toEqual(['run compile:src', 'run lint', 'test', 'run test:tmux']);
    });
});
