import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { satisfies } from 'semver';

const root = path.resolve(__dirname, '..');
const guardPath = path.join(root, '.github', 'scripts', 'check-packaging-node.js');
const packageLockJsonPath = path.join(root, 'package-lock.json');

/** The devDependency that provides the `vsce` bin `npm run package` invokes. */
const PACKAGING_ROOT = '@vscode/vsce';

interface GuardModule {
    effectiveEngineFloor(subtree: Map<string, { name: string; version: string | undefined; nodeRange: string | undefined }>): string | undefined;
}

// The guard is a plain CommonJS script (package.json declares no "type"), so
// it is loaded through createRequire to unit-test its floor computation.
const nodeRequire = createRequire(__filename);
const guard = nodeRequire(guardPath) as GuardModule;

/** Build a fake dependency tree carrying the given engines.node ranges. */
function treeWithRanges(ranges: string[]): Map<string, { name: string; version: string | undefined; nodeRange: string | undefined }> {
    const tree = new Map<string, { name: string; version: string | undefined; nodeRange: string | undefined }>();
    ranges.forEach((nodeRange, index) => {
        tree.set(`pkg-${index}`, { name: `pkg-${index}`, version: '1.0.0', nodeRange });
    });
    return tree;
}

interface JsonObject {
    [key: string]: unknown;
}

interface LockEntry {
    version?: string;
    engines?: { node?: string };
    dependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
}

/** The repo's package-lock.json, read live so a pin that drifted from the lockfile fails here. */
function readPackageLockJson(): JsonObject {
    return JSON.parse(fs.readFileSync(packageLockJsonPath, 'utf8')) as JsonObject;
}

function lockPackages(): Record<string, LockEntry> {
    return readPackageLockJson().packages as Record<string, LockEntry>;
}

/**
 * Resolve a dependency name from a package's install location the way npm does:
 * look in `<dir>/node_modules/<name>` first, then walk up towards the root.
 */
function resolvePackagePath(packages: Record<string, LockEntry>, fromDir: string, name: string): string | undefined {
    const segments = fromDir === '' ? [] : fromDir.split('/node_modules/');

    for (let depth = segments.length; depth >= 0; depth--) {
        const prefix = segments.slice(0, depth).join('/node_modules/');
        const candidate = prefix === '' ? `node_modules/${name}` : `${prefix}/node_modules/${name}`;
        if (Object.prototype.hasOwnProperty.call(packages, candidate)) {
            return candidate;
        }
    }

    return undefined;
}

/** The transitive closure of the packaging subtree (dependencies + optionalDependencies). */
function collectPackagingSubtree(packages: Record<string, LockEntry>, rootPath: string): Map<string, LockEntry> {
    return collectDependencyTree(packages, rootPath, false);
}

/**
 * The transitive closure of a dependency tree. `includeDevDependencies` is set
 * for the whole installed tree, because `npm ci` installs devDependencies too
 * and every one of those packages must run on a compatible runtime.
 */
function collectDependencyTree(
    packages: Record<string, LockEntry>,
    rootPath: string,
    includeDevDependencies: boolean,
): Map<string, LockEntry> {
    const visited = new Map<string, LockEntry>();
    const queue = [rootPath];

    while (queue.length > 0) {
        const current = queue.shift()!;
        if (visited.has(current)) {
            continue;
        }
        const entry = packages[current];
        if (!entry) {
            continue;
        }
        visited.set(current, entry);

        const dependencies = { ...(entry.dependencies ?? {}), ...(entry.optionalDependencies ?? {}) };
        if (includeDevDependencies) {
            Object.assign(dependencies, entry.devDependencies ?? {});
        }
        for (const dependencyName of Object.keys(dependencies)) {
            const resolved = resolvePackagePath(packages, current, dependencyName);
            if (resolved !== undefined && !visited.has(resolved)) {
                queue.push(resolved);
            }
        }
    }

    return visited;
}

/**
 * The tree the guard actually checks: the whole tree `npm ci` installs, plus
 * the @vscode/vsce packaging subtree that `npm run package` runs.
 *
 * Returned in the guard's own shape (`nodeRange`), so the guard's floor
 * computation is exercised with exactly the input it sees in production.
 */
function collectGuardedTree(
    packages: Record<string, LockEntry>,
    rootPath: string,
): Map<string, { name: string; version: string | undefined; nodeRange: string | undefined }> {
    const tree = new Map<string, { name: string; version: string | undefined; nodeRange: string | undefined }>();

    const add = (path: string, entry: LockEntry): void => {
        const name = path === ''
            ? ''
            : path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length);
        tree.set(path, {
            name,
            version: entry.version,
            nodeRange: entry.engines?.node,
        });
    };

    for (const [path, entry] of collectDependencyTree(packages, '', true)) {
        add(path, entry);
    }
    for (const [path, entry] of collectPackagingSubtree(packages, rootPath)) {
        add(path, entry);
    }
    return tree;
}

function runGuard(nodeVersion: string): { status: number | null; stdout: string; stderr: string } {
    const result = spawnSync(process.execPath, [guardPath, '--node-version', nodeVersion], {
        cwd: root,
        encoding: 'utf8',
        timeout: 30_000,
    });
    expect(result.error).toBeUndefined();
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** The toolchain Node: what `.nvmrc` pins and every workflow's setup-node resolves. */
const nvmrcVersion = fs.readFileSync(path.join(root, '.nvmrc'), 'utf8').trim().replace(/^v/, '');

const workflowsDir = path.join(root, '.github', 'workflows');
const workflowFiles = fs.readdirSync(workflowsDir).filter(name => /\.ya?ml$/.test(name));

// One toolchain Node for everything the repo runs — CI, the unit jobs on every OS, the
// rig, packaging and release — pinned once in `.nvmrc`. (The extension's *runtime* is
// VS Code's Electron Node, bounded by engines.vscode; that is a separate contract.) The
// locked tree carries its own `engines.node` floors, and `npm ci` only warns about an
// unmet one, so these tests hold the lockfile to the `.nvmrc` Node.
describe('toolchain engine contract', () => {
    const packages = lockPackages();
    const rootPath = resolvePackagePath(packages, '', PACKAGING_ROOT);

    describe('locked tree', () => {
        it('resolves @vscode/vsce, the packaging root, at its manifest pin', () => {
            const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as { devDependencies: Record<string, string> };

            expect(rootPath, `package-lock.json has no ${PACKAGING_ROOT} entry`).toBeDefined();
            expect(packages[rootPath!]!.version).toBe(pkg.devDependencies[PACKAGING_ROOT]);
        });

        it('admits the .nvmrc Node in every engines.node range it declares', () => {
            const guarded = collectGuardedTree(packages, rootPath!);
            const excluded = [...guarded.entries()]
                .filter(([, entry]) => entry.nodeRange !== undefined && !satisfies(nvmrcVersion, entry.nodeRange))
                .map(([lockPath, entry]) => `${lockPath}@${entry.version} requires node ${entry.nodeRange}`);

            expect(excluded, `packages that cannot run on the .nvmrc Node ${nvmrcVersion}`).toEqual([]);
            expect(guard.effectiveEngineFloor(guarded), 'the locked tree has no common engine floor').toBeDefined();
        });
    });

    describe('check-packaging-node.js guard', () => {
        // The floor must be the true intersection of the ranges — the lowest
        // release admitted by ALL of them. Collapsing the tree to a numeric
        // minimum (or to `semver.minVersion` of a disjunctive range, which
        // reports its lowest branch) admits versions no other range allows.
        it('computes the floor as the intersection of the ranges, not a numeric minimum', () => {
            // `18 || 20 || >=22` has minVersion 18.0.0, which `>=22.0.0` rejects;
            // the floor is the version both ranges admit.
            expect(guard.effectiveEngineFloor(treeWithRanges(['>= 20', '>=22.0.0', '18 || 20 || >=22'])))
                .toBe('22.0.0');

            // The floor can sit on a higher major than any single range's minimum.
            expect(guard.effectiveEngineFloor(treeWithRanges(['>=22.0.0', '18 || 20 || >=23'])))
                .toBe('23.0.0');

            // And on a later minor of a branch: 22.13.0 is admitted, 23.x is not.
            expect(guard.effectiveEngineFloor(treeWithRanges(['>=22.0.0', '^20.19.0 || ^22.13.0 || >=24'])))
                .toBe('22.13.0');
        });

        it('fails with a non-zero exit naming an offending package and its range on an incompatible Node', () => {
            const result = runGuard('18.0.0');

            expect(result.status).not.toBe(0);
            expect(result.stderr).toContain('FAIL: Node 18.0.0');
            expect(result.stderr).toMatch(/\S+@\d+\.\d+\.\d+\S* requires node \S/);
        });

        it('exits zero on the .nvmrc Node', () => {
            const result = runGuard(nvmrcVersion);

            expect(result.status, result.stderr).toBe(0);
            expect(result.stdout).toContain('OK:');
        });
    });

    describe('workflows', () => {
        it.each(workflowFiles)('takes the toolchain Node from .nvmrc in every setup-node step of %s', (file) => {
            const contents = fs.readFileSync(path.join(workflowsDir, file), 'utf8');
            const steps = contents.split(/^\s+- (?:name|uses): /m).filter(step => step.includes('actions/setup-node@'));

            expect(contents, `${file} pins a node-version instead of reading .nvmrc`).not.toMatch(/^\s+node-version:/m);
            steps.forEach(step => expect(step).toContain('node-version-file: .nvmrc'));
        });

        const packagingWorkflows = ['publish.yml', 'preview.yml', 'ci-pr.yml', 'ci-main.yml'];

        it.each(packagingWorkflows)('runs the guard after `npm ci` and before packaging in %s', (file) => {
            const contents = fs.readFileSync(path.join(workflowsDir, file), 'utf8');
            const guardIndex = contents.indexOf('node .github/scripts/check-packaging-node.js');

            expect(guardIndex, `${file} does not run the packaging engine guard`).toBeGreaterThan(-1);
            // The guard `require`s semver from node_modules: before `npm ci` it dies with
            // MODULE_NOT_FOUND, and after packaging it is too late to matter.
            expect(contents.lastIndexOf('npm ci', guardIndex), `${file} runs the guard before npm ci`).toBeGreaterThan(-1);
            expect(guardIndex).toBeLessThan(contents.indexOf('npm run package'));
        });
    });

    describe('runtime policy', () => {
        it('pins the toolchain to a Node 24 LTS release in .nvmrc', () => {
            expect(fs.readFileSync(path.join(root, '.nvmrc'), 'utf8').trim()).toMatch(/^v24\.\d+\.\d+$/);
        });

        it('keeps the extension\'s engines.vscode floor and declares no node engine', () => {
            const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as {
                engines: Record<string, string>;
            };

            expect(pkg.engines.vscode).toBe('^1.90.0');
            expect(pkg.engines.node, 'the extension must not declare a node engine').toBeUndefined();
        });

        // The extension runs in VS Code's extension host, not on the toolchain Node: the
        // engines.vscode floor (1.90, Electron 29) is a Node 20 host. Typing against a newer
        // @types/node would let code use APIs that host does not have.
        it('types the code against the extension host\'s Node 20, not the toolchain Node', () => {
            const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as {
                devDependencies: Record<string, string>;
            };

            expect(pkg.devDependencies['@types/node']).toMatch(/^20\./);
        });
    });
});
