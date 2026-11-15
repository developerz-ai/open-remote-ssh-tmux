# AI-first repo

This repo is built to be worked by **AI coding agents** — agents write ~100% of
the code, humans review/steer/operate. The full playbook lives in
[`gold-standards-in-ai`](https://github.com/developerz-ai/gold-standards-in-ai/blob/main/docs/00-philosophy.md);
this doc records what that means *here*, and what's already true vs. still a gap.

> The core loop: **great DX → fast agents → more shipped → better DX.** Every
> friction an agent hits (a hidden command, an undocumented convention, a slow
> gate) taxes *every turn*. Remove it once in the repo, not in each prompt.

## The setup an agent inherits

A fresh agent should be able to, with zero hand-holding:

1. Read [`CLAUDE.md`](../../CLAUDE.md) → stack, the SRP module map, exact commands.
2. Read [`docs/idea/`](README.md) → *why* this exists and the persistence goal.
3. Run `/planx` then `/feature` (`.claude/commands/`) → plan a slice, build it,
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
  is wired up and this is how every tmux module in `src/tmux/*` got built.
- **Real tmux, not a mock, for tmux behaviour.** Unit tests fake `exec`, so they
  cannot tell whether tmux accepts a command line. Anything that depends on how
  tmux really behaves is also proven on the docker rig (`npm run test:tmux`).
- **Type-safe, low undefined behaviour.** TS `strict`, no `any`; narrow `unknown`.
  Fail fast and loud — never swallow an error on the security-sensitive paths.
- **Surgical diffs.** Every changed line traces to the task. Don't reformat
  upstream files — it poisons the fork merge.
- **Write it down for the next session.** Agents are stateless; `CLAUDE.md` +
  `docs/idea/` are the memory. Compress (read every turn), date load-bearing
  claims, delete what rots.

## Current state vs. target (2026-11-14)

| Capability | Now | Target |
|------------|-----|--------|
| `CLAUDE.md` project brain | ✅ module table guarded by `test/docs.test.ts` | keep ≤ 600 lines, current |
| `docs/idea/` vision | ✅ | this set |
| `/feature`, `/planx` commands | ✅ (`.claude/commands/`) | + `/verify` skill |
| **Unit tests** | ✅ vitest, `npm test` — the pure modules, seconds, no docker | keep pace with new pure logic |
| **Real-tmux tests** | ✅ `npm run test:tmux` — real `ssh2` against a docker sshd per tmux release (2.6, 3.0a, 3.4, 3.5a, 3.8), several login shells (`test/rig/`, `test/integration/`) | — |
| **`bin/` DX scripts** | ✅ `bin/setup` = `npm install`, `bin/dev` = `npm run watch:src`, `bin/check` = compile + lint + unit tests, `bin/check --full` adds the rig | — |
| **Pre-commit gate** | ✅ husky: lint-staged (fixpack, ESLint, zizmor), then `compile:src` + `npm test`; commitlint on the message | — |
| **Agent permissions** | ❌ no `.claude/settings.json` | broad allow for the read-only and test commands |
| **CodeGraph index** | ❌ no `.codegraph/` | index `src/` for structural lookups |
| **CI gate** | ✅ PR + `main`: build, unit tests, `lint:package`, `lint`, commitlint, `.vsix` package + contents check, the tmux rig per version; `npm audit` + zizmor daily (`audit.yml`) | — |
| **Release** | ✅ `npm run release` tags `v<version>`; `publish.yml` refuses a tag that differs from `package.json`, re-runs build/test/lint, packages, creates the GitHub Release; Open VSX behind the `PUBLISH_OPENVSX` variable (not enabled) | publish to Open VSX |
| **Empirical F5/EDH proof** | ✅ run for v1.0.0 with a real VSCodium under Xvfb against docker remotes ([`results-2026-07-24.md`](../plans/2026/07/24/101-v1-tmux-release/results-2026-07-24.md), 19/21); re-run for the hardening sweep ([`101-bulletproof-hardening-sweep/09-verify.md`](../plans/2026/11/13/101-bulletproof-hardening-sweep/09-verify.md)) | re-run the zombie rows (6-9) for any terminal-layer change |

### What each layer of proof can and cannot show

- **Unit tests** prove the decisions: naming, slot ownership, reap verdicts,
  settings reactions, command-line shapes. They cannot show that tmux accepts a
  command line — an early `set-option -t =<name>` target that real tmux rejects
  passed every unit test and left the status bar visible.
- **The rig** proves the remote side for real: every command line the extension
  sends, on every supported tmux version and login shell, including two
  "machines" racing for one workspace. It has found bugs no unit test could
  (folder names executing through tmux formats, unsetting a global user option crashing the
  tmux 2.6 server, `client_activity` moving on keystrokes but not output).
- **F5 / Extension Development Host** is still the only proof of VS Code's own
  side: revive and split restore, the profile dropdown, notifications, a real
  window close. An agent can run it where a VS Code desktop binary and a display
  (Xvfb is enough) exist — the v1.0.0 run did exactly that.

## Next steps to close the gaps

In rough priority (each a `/planx` candidate):

1. **Agent permissions** — `.claude/settings.json` allowing the read-only and
   test commands agents run on every turn.
2. **CodeGraph index** — `codegraph init` so agents do structural lookups.
3. **Scripted F5 matrix** — drive the acceptance matrix's VS Code-side rows from
   a script instead of by hand, so they can run in CI next to the rig.
4. **Deferred features** — session-manager tree view, Claude Code first-class
   attach, mosh-over-tmux — see [`roadmap.md`](roadmap.md) for why each waits.

Reference the gold-standards docs when doing any of these — don't reinvent the
conventions.
