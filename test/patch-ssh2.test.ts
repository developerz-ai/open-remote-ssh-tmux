import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// scripts/patch-ssh2.js rewrites the installed ssh2 tree in place, and it is
// coupled to ONE ssh2 release by three byte-exact anchors in
// lib/protocol/utils.js. These tests run the real script against a synthesized
// ssh2 tree (node_modules/ssh2 may not be installed, and the real tree must
// never be mutated by a test), copying the script into <tmp>/scripts/ because
// it derives its root from __dirname. They pin the safety properties:
//   - pristine 1.17.0 tree: all three patches land, exit 0, re-run is a no-op;
//   - any single altered anchor: exit 1, utils.js byte-identical (the write is
//     all-or-nothing), stderr names the version and "anchor N/3";
//   - a manifest pin that differs from the script's TARGET_SSH2_VERSION fails,
//     so a bump cannot skip refreshing the anchors.

const scriptSource = path.resolve(__dirname, '..', 'scripts', 'patch-ssh2.js');

const TARGET = '1.17.0';

const ANCHOR_1 = 'const utilBufferParser = makeBufferParser();';
const ANCHOR_2 = [
    '        utilBufferParser.init(sig, 0);',
    '        const r = utilBufferParser.readString();',
    '        const s = utilBufferParser.readString();',
    '        utilBufferParser.clear();',
    '        if (r === undefined || s === undefined)',
    '          return;',
    '',
    '        const asnWriter = new Ber.Writer();',
    '        asnWriter.startSequence();',
    '        asnWriter.writeBuffer(r, Ber.Integer);',
    '        asnWriter.writeBuffer(s, Ber.Integer);',
    '        asnWriter.endSequence();',
    '        return asnWriter.buffer;',
].join('\n');
const ANCHOR_3 = [
    '    proto._cipher.encrypt(packet);',
    '    return true;',
    '  },',
    '};',
].join('\n');

const UTILS_FIXTURE = [
    `'use strict';`,
    '',
    ANCHOR_1,
    '',
    'function sigSSHToASN1(sig, type) {',
    '  switch (type) {',
    `    case 'ecdsa-sha2-nistp256':`,
    '      {',
    ANCHOR_2,
    '      }',
    '  }',
    '  return sig;',
    '}',
    '',
    'module.exports = {',
    '  sigSSHToASN1,',
    '  bufferSlice() {',
    ANCHOR_3,
    '',
].join('\n');

const KEX_FIXTURE = [
    `const c = 'kex-strict-c-v00@openssh.com';`,
    `const s = 'kex-strict-s-v00@openssh.com';`,
    '',
].join('\n');

interface Fixture {
    root: string;
    utilsPath: string;
    run(): { status: number | null; stdout: string; stderr: string };
}

function makeFixture(
    options: { manifestPin?: string; installedVersion?: string; kex?: string; utils?: string } = {}
): Fixture {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'patch-ssh2-'));
    const scriptsDir = path.join(root, 'scripts');
    const ssh2Dir = path.join(root, 'node_modules', 'ssh2');
    const protocolDir = path.join(ssh2Dir, 'lib', 'protocol');
    fs.mkdirSync(scriptsDir, { recursive: true });
    fs.mkdirSync(protocolDir, { recursive: true });

    const script = path.join(scriptsDir, 'patch-ssh2.js');
    fs.copyFileSync(scriptSource, script);
    fs.writeFileSync(
        path.join(root, 'package.json'),
        JSON.stringify({ dependencies: { ssh2: options.manifestPin ?? TARGET } })
    );
    fs.writeFileSync(
        path.join(ssh2Dir, 'package.json'),
        JSON.stringify({ name: 'ssh2', version: options.installedVersion ?? TARGET })
    );
    fs.writeFileSync(path.join(protocolDir, 'kex.js'), options.kex ?? KEX_FIXTURE);
    const utilsPath = path.join(protocolDir, 'utils.js');
    fs.writeFileSync(utilsPath, options.utils ?? UTILS_FIXTURE);

    return {
        root,
        utilsPath,
        run() {
            // process.execPath, not /bin/sh: runs the same on Windows.
            const result = spawnSync(process.execPath, [script], { encoding: 'utf8' });
            return { status: result.status, stdout: result.stdout, stderr: result.stderr };
        },
    };
}

describe('scripts/patch-ssh2.js', () => {
    let fixture: Fixture | undefined;

    beforeEach(() => {
        fixture = undefined;
    });

    afterEach(() => {
        if (fixture) {
            fs.rmSync(fixture.root, { recursive: true, force: true });
        }
    });

    it('patches a pristine 1.17.0 tree (all three anchors) and exits 0', () => {
        fixture = makeFixture();
        const result = fixture.run();
        expect(result.status, result.stderr).toBe(0);

        const patched = fs.readFileSync(fixture.utilsPath, 'utf8');
        expect(patched).toContain('// open-remote-ssh-tmux: ECDSA sigSSHToASN1 mpint patch');
        expect(patched).toContain('function convertToMpint(buf) {');
        expect(patched).toContain('const rMpint = convertToMpint(r);');
        expect(patched).toContain('const sMpint = convertToMpint(s);');
        expect(patched).toContain('\n  convertToMpint,\n};');
        // The patch lands after the truncated-signature check, never before it.
        const guardAt = patched.indexOf('if (r === undefined || s === undefined)');
        expect(guardAt).toBeGreaterThan(-1);
        expect(patched.indexOf('return;', guardAt)).toBeLessThan(patched.indexOf('const rMpint'));
        // No temp file is left behind by the atomic write.
        expect(fs.existsSync(`${fixture.utilsPath}.patching`)).toBe(false);
    });

    it('is idempotent: a second run exits 0 and leaves the file byte-identical', () => {
        fixture = makeFixture();
        expect(fixture.run().status).toBe(0);
        const once = fs.readFileSync(fixture.utilsPath);

        const second = fixture.run();
        expect(second.status, second.stderr).toBe(0);
        expect(second.stdout).toContain('already patched');
        expect(fs.readFileSync(fixture.utilsPath).equals(once)).toBe(true);
    });

    // Each alteration breaks exactly one anchor. Anchor 3 is the key case for
    // atomicity: anchors 1 and 2 already matched in memory when it fails.
    it.each([
        [1, ANCHOR_1, 'const utilBufferParser = makeBufferParser(1);'],
        [2, 'const s = utilBufferParser.readString();', 'const s2 = utilBufferParser.readString();'],
        [3, '    proto._cipher.encrypt(packet);', '    proto._cipher.encrypt(pkt);'],
    ])('fails closed when anchor %i/3 is altered: exit 1, utils.js untouched, stderr names it', (n, from, to) => {
        const altered = UTILS_FIXTURE.replace(from, to);
        expect(altered, 'test bug: alteration did not change the fixture').not.toBe(UTILS_FIXTURE);
        fixture = makeFixture({ utils: altered });
        const before = fs.readFileSync(fixture.utilsPath);

        const result = fixture.run();
        expect(result.status).toBe(1);
        expect(result.stderr).toContain(`anchor ${n}/3`);
        expect(result.stderr).toContain(`ssh2 ${TARGET}`);
        expect(fs.readFileSync(fixture.utilsPath).equals(before)).toBe(true);
        expect(fs.existsSync(`${fixture.utilsPath}.patching`)).toBe(false);
    });

    it('fails when the manifest pin differs from the script target, even if installed matches the pin', () => {
        fixture = makeFixture({ manifestPin: '1.17.1', installedVersion: '1.17.1' });
        const before = fs.readFileSync(fixture.utilsPath);

        const result = fixture.run();
        expect(result.status).toBe(1);
        expect(result.stderr).toContain('1.17.1');
        expect(result.stderr).toContain(TARGET);
        expect(fs.readFileSync(fixture.utilsPath).equals(before)).toBe(true);
    });

    it('fails when the installed version differs from the manifest pin', () => {
        fixture = makeFixture({ installedVersion: '1.16.0' });
        const result = fixture.run();
        expect(result.status).toBe(1);
        expect(result.stderr).toContain('1.16.0');
    });

    it('fails when kex.js lacks strict-kex (Terrapin guard)', () => {
        fixture = makeFixture({ kex: `const c = 'kex-strict-c-v00@openssh.com';\n` });
        const before = fs.readFileSync(fixture.utilsPath);

        const result = fixture.run();
        expect(result.status).toBe(1);
        expect(result.stderr).toContain('strict-kex');
        expect(fs.readFileSync(fixture.utilsPath).equals(before)).toBe(true);
    });

    it('declares the same target version as the repo manifest pin and documents the bump refresh', () => {
        const source = fs.readFileSync(scriptSource, 'utf8');
        const declared = /const TARGET_SSH2_VERSION = '([^']+)';/.exec(source)?.[1];
        expect(declared, 'TARGET_SSH2_VERSION literal not found in scripts/patch-ssh2.js').toBeDefined();
        const manifest = JSON.parse(
            fs.readFileSync(path.resolve(__dirname, '..', 'package.json'), 'utf8')
        ) as { dependencies: Record<string, string> };
        expect(manifest.dependencies.ssh2).toBe(declared);
        expect(source).toContain('Refreshing for an ssh2 bump');
        expect(source).toContain('lib/protocol/utils.js');
        expect(source, 'the patcher must have no force/skip flag').not.toMatch(/--force|--skip|process\.argv/);
    });
});
