# AI-first repo

This repo is built to be worked by **AI coding agents** — agents write ~100% of
the code, humans review/steer/operate. The full playbook lives in
[`../../../gold-standards-in-ai/`](../../../gold-standards-in-ai/docs/00-philosophy.md);
this doc records what that means *here*, and what's already true vs. still a gap.

> The core loop: **great DX → fast agents → more shipped → better DX.** Every
> friction an agent hits (a hidden command, an undocumented convention, a slow
> gate) taxes *every turn*. Remove it once in the repo, not in each prompt.

## The setup an agent inherits

A fresh agent should be able to, with zero hand-holding:

1. Read [`CLAUDE.md`](../../CLAUDE.md) → stack, the SRP module map, exact commands.
2. Read [`docs/idea/`](README.md) → *why* this exists and the persistence goal.
3. Run `/plan` then `/feature` (`.claude/commands/`) → plan a slice, build it,
   verify, PR.
4. Find any symbol via CodeGraph or the predictable `src/` layout.
5. Make a change, run the gate, know it's green.

If any step needs tribal knowledge, that's a DX bug — fix it in the repo.

## House rules (inherited, non-negotiable)

- **SOLID / SRP.** One file, one job; files ≤ ~500 LOC. The tmux integration is
  its own module, never bolted onto the SSH classes. (See `CLAUDE.md`.)
- **Unit TDD — no test, no merge.** Write the failing unit test *first*, then the
  code that passes it. Pure logic (session naming, attach-or-create, reap
  decisions, config parsing) is designed test-first; the test is the spec. The
  agent's biggest edge is verifying its own work. Wiring up the runner is the
  single largest current gap (see below).
- **Type-safe, low undefined behaviour.** TS `strict`, no `any`; narrow `unknown`.
  Fail fast and loud — never swallow an error on the security-sensitive paths.
- **Surgical diffs.** Every changed line traces to the task. Don't reformat
  upstream files — it poisons the fork merge.
- **Write it down for the next session.** Agents are stateless; `CLAUDE.md` +
  `docs/idea/` are the memory. Compress (read every turn), date load-bearing
  claims, delete what rots.

## Current state vs. target

| Capability | Now | Target |
|------------|-----|--------|
| `CLAUDE.md` project brain | ✅ | keep ≤ 600 lines, current |
| `docs/idea/` vision | ✅ | this set |
| `/feature`, `/planx` commands | ✅ (`.claude/commands/`) | + `/verify` skill |
| **Test suite** | ❌ none | **unit TDD** for pure modules (test-first) + integration for the tmux session lifecycle (naming, attach-or-create, reaping); **fast** (<10s unit) |
| **`bin/` DX scripts** | ❌ (npm scripts only) | `bin/setup`, `bin/dev`, `bin/check` one-liners |
| **Hooks + permissions** | ❌ | broad allow + pre-commit lint/typecheck hook, so unlinted code physically can't land |
| **CodeGraph index** | ❌ no `.codegraph/` | index `src/` for structural lookups |
| **CI green gate** | partial | typecheck + lint + bundle + tests < 5 min |
| **Marketplace publish** | manual (`vsce`) | scripted release of the `.vsix` |

## Next steps to close the gaps

In rough priority (each a `/planx` candidate):

1. **Testing harness (TDD enabler)** — pick a fast unit runner, add unit tests for
   the pure modules (`sshConfig`, `sshDestination`, `serverConfig`, `ports`,
   `splitProxyCommand`), wire `bin/check`. Target: unit run < 10s so writing the
   test first is frictionless. Unblocks unit TDD / "no test, no merge".
2. **DX scripts + hooks + permissions** — `.claude/settings.json` with a
   pre-commit gate; `bin/setup|dev|check`.
3. **CodeGraph index** — `codegraph init` so agents do structural lookups.
4. **The tmux terminal integration** itself, built test-first — session naming,
   attach-or-create, restore mapping, and reaping (see [`tmux-approach.md`](tmux-approach.md)).

Reference the gold-standards docs when doing any of these — don't reinvent the
conventions.
