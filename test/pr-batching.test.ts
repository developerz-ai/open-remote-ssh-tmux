import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

// Drift guard for the PR-granularity rule. The platform measured
// owner_prs_per_day_p50 at 95 against a target of 5 (lower is better, 30-day
// window): the agent commands told each plan slice to become its own PR, and
// real output followed (PR #57 is a one-line docs link fix shipped as its own
// stacked "Part 1/1" PR). These assertions read the actual files the fleet
// follows, so reintroducing slice-per-PR fails here rather than in the metric.

const repoRoot = path.resolve(__dirname, '..');

function read(relative: string): string {
    return fs.readFileSync(path.join(repoRoot, relative), 'utf8');
}

describe('one PR per plan, not one PR per slice', () => {
    const feature = read('.claude/commands/feature.md');
    const planx = read('.claude/commands/planx.md');
    const standardPath = path.join(repoRoot, 'docs', 'standards', 'pr-batching.md');

    it('feature.md no longer tells the coordinator to open a PR per slice', () => {
        expect(feature).not.toMatch(/slice-per-PR/i);
        expect(feature).not.toMatch(/one slice at a time/i);
        expect(feature).not.toMatch(/One PR in flight at a time/i);
    });

    it('feature.md batches the whole disjoint slice set into one PR', () => {
        expect(feature).toMatch(/one PR for the (?:whole|entire) plan/i);
        expect(feature).toMatch(/push once/i);
    });

    it('planx.md tells the executor the slices ship in one PR', () => {
        expect(planx).toMatch(/one PR for the (?:whole|entire) plan/i);
        expect(planx).not.toMatch(/one PR per slice/i);
    });

    it('the fleet-read standard records the finding and the rule', () => {
        expect(fs.existsSync(standardPath), 'docs/standards/pr-batching.md exists').toBe(true);
        const standard = fs.readFileSync(standardPath, 'utf8');
        expect(standard).toMatch(/95/);
        expect(standard).toMatch(/\b5\b/);
        expect(standard).toMatch(/owner_prs_per_day_p50/);
        expect(standard).toMatch(/one PR per plan/i);
        expect(standard).toMatch(/\.claude\/commands\/feature\.md/);
        expect(standard).toMatch(/\.claude\/commands\/planx\.md/);
    });
});
