# PR batching: one PR per plan

Fleet-read rule. Applies to every repo's agent rules and to every agent that
opens pull requests, not just this extension.

## Finding

`owner_prs_per_day_p50` read **95** at 2026-11-23T07:28:51.009Z against a target
of **5** (lower is better, noise floor 19, 30-day window). The cause is PR
granularity in the agent rules, not source code. Two instructions made each
separable slice its own PR:

- `.claude/commands/feature.md:102`: "For slice-per-PR, one slice at a time:
  add, commit, push, PR, merge, `git fetch`, repeat", and line 106: "One PR in
  flight at a time." Each slice became a full PR cycle.
- `.claude/commands/planx.md:38-43` and `:140-141`: every separable area becomes
  its own `<NN>-<aspect>.md` slice, which the executor delivered as its own PR.

Real output matched the rule: PR #57 is a one-line docs link fix shipped as a
stacked "Part 1/1" PR, and PR #56 is a 17-line README update and a test deflake
in its own stacked PR. A single line of work should not consume a PR.

## Rule

- Stage the full set of disjoint slices of a plan/run, commit each logical
  change separately, push once, and open **one PR for the whole plan**. Merge
  once, after the gates are green.
- Slices are execution units, not PR units. Never open a PR per slice, and
  never open a PR for a one-line change.
- A second PR is allowed only for a genuine dependency (a change that must land
  before the rest can build) or a change that must land independently. Say
  which slice needs it and why.
- Merge gates are unchanged: CI green, review verdict passing, branch
  protections satisfied. Batching changes only how many PRs a run opens.

## Rationale

Owner PR rate is a throughput signal. Under slice-per-PR, each plan multiplies
the count regardless of how much actually shipped, so the median saturates.
One PR per plan keeps the number near target and leaves a coherent change for
review. `test/pr-batching.test.ts` pins the rule as a drift guard: it reads the
agent commands and this file, and fails if slice-per-PR returns.
