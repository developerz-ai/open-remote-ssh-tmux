---
description: Write a concise, self-contained execution plan to docs/plans/<YYYY>/<MM>/<DD>/<1NN>-<slug>/ for another AI to implement — scoped to the open-remote-ssh-tmux extension
argument-hint: [what you want done]
allowed-tools: Write, Read, Glob, Grep, Task, Bash
---

# /planx

Produce a concise plan another AI can execute with zero extra context. Plan only
— no implementation, no code execution, no edits outside the plan dir. This repo
is **open-remote-ssh-tmux**, a VS Code extension forked from open-remote-ssh that
adds tmux-backed persistent terminals; read `CLAUDE.md` and `docs/idea/` before
planning.

## Goal
$ARGUMENTS

## Steps

1. **Resolve path.** Run `date +%Y`, `date +%m`, `date +%d`. Dir =
   `docs/plans/<YYYY>/<MM>/<DD>/`. `Glob docs/plans/<YYYY>/<MM>/<DD>/1*` → next
   number = highest existing `1NN-*` + 1, else `101`. Slug = kebab-case title,
   max 5 words. Final plan dir: `docs/plans/<YYYY>/<MM>/<DD>/<1NN>-<slug>/`.

2. **Explore.** `Task` (subagent_type=Explore, thoroughness="very thorough"):
   existing patterns + files to touch (`file:line`), which module owns the
   concern (SRP table in `CLAUDE.md`), the new tmux layer (`src/tmux/*`), how
   terminals are spawned today and the terminal-profile /
   `TerminalProfileProvider` seam, session naming/attach-or-create/reap logic,
   `src/hostTreeView.ts` (session-manager UI), `package.json` `contributes`
   (commands/config/menus/views/terminal), and the connection plumbing in
   `src/ssh/*` (we run tmux *over* it — read-only). Confirm the change stays in
   **scope: terminals only** and preserves the two hard invariants (**invisible
   UX**, **no zombie sessions**). Prefer `codegraph_*` for structural lookups.
   Skip only for trivial asks.

3. **Write the plan as multiple files** in the plan dir — never one big
   `plan.md`. Always produce an `overview.md` index plus one `<NN>-<aspect>.md`
   per separable area (e.g. `01-session-model.md`, `02-terminal-profile.md`,
   `03-reaping-lifecycle.md`, `04-session-manager-ui.md`, `05-package-contributes.md`,
   `06-verify.md`). Split by area so each file is independently executable and
   stays short. Terse fragments, `file:line` refs, tables.

   **`overview.md`** — the map. Sections:

```markdown
# <Title>

## Goal
1-2 sentences: what + why.

## Context
- Stack facts the executor needs (VS Code extension, TypeScript strict + CommonJS,
  webpack bundle → lib/extension.js, ssh2 for the connection, tmux on the remote
  for persistent terminals, VS Code server installed by serverSetup — only what's
  relevant).
- Scope reminder: terminals only; SSH transport unchanged; don't regress editing/
  file/protocol paths.
- Invariants this must uphold: invisible UX (no tmux leak), no zombie sessions.
- Reference patterns: `src/<area>/<thing>.ts:12` — follow this for Z.

## Plan files (execute in order)
1. [`01-<aspect>.md`](01-<aspect>.md) — one line: what it covers.
2. [`02-<aspect>.md`](02-<aspect>.md) — ...

## Done when
- Verifiable acceptance criteria spanning the whole feature.

## Risks / open questions
- Anything the executor must decide or watch (session naming, restore mapping,
  Windows degradation, security of tmux command lines, upstream-merge hazards).
```

   **Each `<NN>-<aspect>.md`** — one slice of work. Sections:

```markdown
# <NN> — <Aspect>

> Part of [`overview.md`](overview.md). Depends on: <NN-prior or "none">.

## Files to change
- `path:line` — what changes, why.

## Steps
1. Ordered, concrete actions. Reference `Class#method` / `file:line`, don't restate.

## Tests (write first — TDD)
- The failing unit tests to author *before* the code, and what they assert (the
  spec for this slice's pure logic). Command: `npm run compile:src`, `npm run lint`.

## Verify
- Unit tests green (test-first); `npm run compile:src` (tsc), `npm run lint`,
  `npm run bundle`; for terminal changes, an F5 Extension Development Host connect
  proving persistence (disconnect→reconnect→same session; re-open workspace→no
  zombie) with tmux invisible to the user.

## Done when
- Verifiable acceptance criteria for this slice.
```

4. **Write a `status.yml`** in the plan dir (alongside `overview.md`) — the live
   tracker. New plans start `not_started` / `0%`. Get `created_by` + `owner` from
   `git config user.name`. Leave `worked_by` empty — the executor sets it to their
   own `git config user.name` when they pick the plan up. Shape:

```yaml
plan: <1NN>-<slug>
title: <human title from overview.md>
status: not_started        # not_started | in_progress | blocked | complete | superseded
created_by: <git config user.name>
worked_by: ""              # who is executing it; empty = unclaimed
owner: <git config user.name>
percent: 0                 # 0–100, overall completion
current_focus: ""          # where it's at / next slice to pick up
slices:                    # one row per <NN>-<aspect>.md slice
  - file: 01-<aspect>.md
    status: not_started      # not_started | in_progress | complete
    percent: 0
evidence: []               # commits/PRs proving progress, e.g. ["#42", "abc1234"]
notes: ""
last_updated: <YYYY-MM-DD>
```

   Keep `status.yml` machine-readable (valid YAML, the enums above). It's the one
   file in the plan dir that IS a tracker — the `.md` slices stay reference maps
   (no checkboxes there).

## Rules

- Compact English. Fragments over sentences. `file:line` and `Class#method`
  symbol refs over prose. Tables for structured data.
- Reference-only: point at code, don't paste it or re-explain it ("follow
  `hostTreeView.ts` but for tmux sessions ...").
- No checkboxes (`[ ]`). Plain bullets. The plan is a reference map, not a tracker.
- Multiple files always: `overview.md` + `<NN>-<aspect>.md` slices. Never a single
  `plan.md`.
- Self-contained: executor reads only `overview.md`, the slice it's on, and the
  files those cite.
- Respect `CLAUDE.md` + `docs/idea/`: **scope = terminals only** (don't touch the
  editing/file/protocol path); **SSH stays** (no mosh — see
  `decision-mosh-vs-tmux.md`); **invisible UX** (no tmux leak) and **no zombie
  sessions** are hard requirements; **SRP** (tmux logic in its own `src/tmux/*`
  module, never bolted onto the SSH classes); security-sensitive code
  (`authResolver`, `ssh/*`, `scripts/*`, `tmux/*`) — no secret logging, no
  weakened host-key checks, quote/escape tmux command lines; **fork hygiene**
  (keep the diff isolated + un-reformatted so upstream merges cleanly); tmux is
  Unix-only — degrade gracefully on Windows.
- **Unit TDD** — every slice with pure logic lists its failing tests first (the
  `## Tests (write first — TDD)` section is the spec); no test, no merge.
- Stack rules: TypeScript strict, no `any`, no unused locals/params, explicit
  `override`. 4-space indent (`.editorconfig`). npm + Node 20. Conventional
  Commits (commitlint types: `build ci docs enhance feat fix perf refactor remodel
  revert style test vcs`). Branch off `master`.
- Dependency direction: `extension` → feature modules (`tmux/*`, `hostTreeView`,
  `commands`) → `ssh/*` | `serverSetup` → `common/*`; `common/*` never imports
  upward.

## Output
```
✓ docs/plans/<YYYY>/<MM>/<DD>/<1NN>-<slug>/overview.md
  + 01-<aspect>.md, 02-<aspect>.md, … (one per area)
  + status.yml (tracker — status/owner/percent/current_focus)
Next: run an executor on overview.md.
```
