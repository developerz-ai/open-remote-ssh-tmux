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
  agent's biggest edge is verifying its own work. The runner (vitest, `npm test`)
  is wired up and this is how every tmux module in `src/tmux/*` got built — see
  below for what's still outstanding.
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
| **Test suite** | ✅ vitest, `npm test` — 140+ tests over the pure modules | keep pace with new pure logic; add integration coverage once the session-manager tree view (see [`roadmap.md`](roadmap.md)) lands |
| **tmux integration, test-first** | ✅ session naming, attach-or-create, reap decisions, bootstrap probe, multi-client provider — all unit-tested before/alongside implementation (`test/tmux/*`) | — |
| **`bin/` DX scripts** | ❌ (npm scripts only) | `bin/setup`, `bin/dev`, `bin/check` one-liners |
| **Hooks + permissions** | ❌ | broad allow + pre-commit lint/typecheck hook, so unlinted code physically can't land |
| **CodeGraph index** | ❌ no `.codegraph/` | index `src/` for structural lookups |
| **CI green gate** | partial | typecheck + lint + bundle + tests < 5 min |
| **Marketplace publish** | manual (`vsce`) | scripted release of the `.vsix` |
| **Empirical F5/EDH persistence proof** | ❌ not yet run in this environment (no VS Code desktop binary/display) | run the [`09-verify.md`](../plans/2026/07/24/101-v1-tmux-release/09-verify.md) matrix on a real Unix remote |

## Next steps to close the gaps

In rough priority (each a `/planx` candidate):

1. **DX scripts + hooks + permissions** — `.claude/settings.json` with a
   pre-commit gate; `bin/setup|dev|check`.
2. **CodeGraph index** — `codegraph init` so agents do structural lookups.
3. **The empirical verification gate** — run
   [`09-verify.md`](../plans/2026/07/24/101-v1-tmux-release/09-verify.md) on a
   real Unix remote via the Extension Development Host: this is the one gap the
   unit test suite structurally cannot close (it needs a live VS Code window and
   a real SSH connection), and it's the actual acceptance bar for the
   persistence-model north star.
4. **Deferred features** — session-manager tree view, Claude Code first-class
   attach, mosh-over-tmux — see [`roadmap.md`](roadmap.md) for why each waits.

Reference the gold-standards docs when doing any of these — don't reinvent the
conventions.
