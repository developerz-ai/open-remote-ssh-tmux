import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '..');
const fixture = 'test/fixtures/lint/floating.ts';
// eslint's package `exports` do not expose its bin, so address the installed file.
const eslintBin = path.join(root, 'node_modules', 'eslint', 'bin', 'eslint.js');

interface LintResult {
    messages: Array<{ ruleId: string | null; severity: number }>;
}

// Runs the repo's real eslint config. The fixture is globally ignored (it is broken on
// purpose), so `--no-ignore` names it explicitly; the typed-rules block opts it in.
function lint(...args: string[]) {
    return spawnSync(process.execPath, [eslintBin, ...args], {
        cwd: root,
        encoding: 'utf8',
        timeout: 60_000,
    });
}

// The lint gate has to be able to fail: house rules are errors, warnings are not
// tolerated, and a dropped promise in shipped code is caught by type-aware linting.
describe('eslint gate', () => {
    it('the lint script refuses warnings', () => {
        const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
        expect(pkg.scripts['lint']).toMatch(/--max-warnings 0\b/);
    });

    it('exits non-zero on a floating promise, reported by no-floating-promises', () => {
        const result = lint('--no-ignore', '--max-warnings', '0', '--format', 'json', fixture);

        expect(result.error).toBeUndefined();
        expect(result.status).toBe(1);
        const [report] = JSON.parse(result.stdout) as LintResult[];
        const rules = report.messages.map(m => m.ruleId);
        expect(rules).toEqual(['@typescript-eslint/no-floating-promises']);
        expect(report.messages[0].severity, 'the rule must be an error, not a warning').toBe(2);
    });
});
