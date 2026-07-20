---
description: End-to-end feature workflow for open-remote-ssh-tmux — understand, explore, build (SRP-first, one module per concern), verify in the Extension Development Host, PR against master. Reads intent from the prompt.
argument-hint: <what you want built, plain language> [+ reference URL(s) / upstream issue]
allowed-tools: Read, Write, Edit, Glob, Grep, Bash, Task, Skill, WebFetch, mcp__codegraph, mcp__playwright
---

# /feature

You are a **senior engineer maintaining open-remote-ssh-tmux** — a VS Code
extension that connects to remote dev hosts over SSH (a fork of
[jeanp413/open-remote-ssh](https://github.com/jeanp413/open-remote-ssh)) and adds
**tmux-backed persistent terminals** so long tasks survive disconnects and hand
off between machines. Take a feature from plain-language idea to a merged PR on
`master`. **Read `CLAUDE.md` and `docs/idea/` before designing** — the scope
(terminals only), the invisible-UX and no-zombie requirements, the SRP module
map, and why-tmux-not-mosh are non-negotiable context.

## Request
$ARGUMENTS

**The prompt is the context — read the intent.** How autonomous to be, how big
the scope, whether to confirm before merging: infer it from the words. "Just ship
it" → run start-to-finish, decide yourself, surface decisions in the PR body. A
tentative ask → clarify what's genuinely ambiguous and let the user review before
merge. The flow below is the map, not a checklist to recite — skip what doesn't
apply, and always stop for a true blocker (weakening host-key verification /
leaking secrets / shell injection in remote commands, regressing the base
open-remote-ssh experience, or a change that leaks tmux to the user or risks
zombie sessions).

## The flow

1. **Understand.** Restate the goal in a line. If the ask cites URLs (an upstream
   issue, a tmux doc, prior art), `WebFetch` and extract the *mechanism*, then map
   it onto our stack: a VS Code extension (TypeScript strict, CommonJS, webpack),
   `ssh2` for the connection, tmux on the remote for persistent terminals, the VS
   Code server installed by `src/serverSetup.ts`. Remember the scope is
   **terminals only** — editing/file/protocol paths already work and stay
   untouched.

2. **Explore.** Fan out `Task` Explore agents (thoroughness="very thorough";
   `codegraph_explore` for structure) to map every affected surface: the tmux
   layer (`src/tmux/*`, new), how terminals are currently spawned, the terminal
   profile / `TerminalProfileProvider` seam, session naming/attach-or-create/reap
   logic, `src/hostTreeView.ts` (if adding a session manager UI), `src/commands.ts`,
   `package.json` `contributes` (commands/config/menus/views/terminal), and the
   connection plumbing in `src/ssh/*` (read-only — we run tmux commands *over* it,
   we don't change it). Note patterns to mirror (`file:line`). Log what the survey
   couldn't cover. Respect the dependency direction — `common/*` never imports
   upward.

3. **Build — SRP first, TDD always.** One responsibility per module. **Write the
   failing unit test first** for any pure logic (session naming, attach-or-create,
   reap decisions, parsing), then the code to pass it — the test is the spec, no
   test no merge. Put tmux logic in its own `src/tmux/*` module — **never bolt it
   onto the SSH classes or the resolver.**
   Honour the hard requirements: **invisible** (no tmux commands/UI leak to the
   user; same feel as open-remote-ssh), **no zombies** (deterministic session
   names keyed to host+workspace + attach-or-create; reap empty sessions; stable
   client↔session mapping on restore), **tmux owns terminal lifetime** (neutralise
   VS Code's own persistent-terminal layer for these), and **graceful Windows
   degradation**. Inject `Log` and collaborators via constructors, as
   `extension.ts` already does. Keep upstream files un-reformatted so future
   merges from `jeanp413/open-remote-ssh` stay clean.

4. **Verify.** The green gate is:
   - **Unit tests green** — written test-first (TDD). If the runner isn't wired up
     yet, that's the prerequisite task (see `docs/idea/ai-first.md`); don't skip
     testing pure logic.
   - `npm run compile:src` (tsc `-b`) clean — strict, no `any`, no unused.
   - `npm run lint` clean (`npm run lint:fix` to autofix).
   - `npm run bundle` produces `lib/extension.js` without webpack errors.
   - For anything touching terminals: launch the **Extension Development Host**
     (`F5`), connect to a real remote, and verify the persistence UX end-to-end —
     open a terminal, start a process, **disconnect → reconnect → same session
     re-attaches**; **re-open the workspace → no duplicate/zombie session**; the
     user never sees tmux.
   Test-first → unit green + typecheck + clean lint + a real persistence-verified
   connect is the bar.

5. **PR against `master`.** Branch off `master` (never commit to it directly).
   Commit with **Conventional Commits** (commitlint + husky enforce it; types:
   `build ci docs enhance feat fix perf refactor remodel revert style test vcs`;
   body ≤ 200 chars/line; scope = the module/area). Push, `gh pr create` with a
   Summary + a Test plan (typecheck/lint/bundle results + the persistence connect
   result). If the change corresponds to an upstream issue, reference it. Merge
   only when asked or when the ask was "just ship it" and CI is green — squash,
   never `--force`/`--no-verify`/skip hooks without permission.

## Hard rules (from CLAUDE.md / docs/idea — non-negotiable)

**Terminals only** — don't touch the editing/file/protocol path or regress the
base open-remote-ssh experience. **SSH transport stays** — no mosh, no transport
rewrite (see `decision-mosh-vs-tmux.md`). **Invisible** — same UX as
open-remote-ssh; the user never types or sees tmux. **No zombie sessions** —
deterministic naming + attach-or-create + reaping; re-opening re-attaches the
same session. **SRP** — tmux logic in its own `src/tmux/*` module. Security-
sensitive zone: `src/authResolver.ts`, `src/ssh/*`, `src/scripts/*`, `src/tmux/*`
— never log secrets, never weaken host-key verification, quote/escape everything
in tmux command lines sent to the remote. **Fork hygiene** — keep the diff
isolated and un-reformatted. tmux is Unix-only — degrade gracefully on Windows.
**Unit TDD** — failing test first, then code; no test, no merge. TypeScript
strict, 4-space indent, npm + Node 20. Commit/push only when asked.

## Output

```
Concern:    <module(s) touched>  →  SRP: <new src/tmux/* | UI | contributes>
Invariants: invisible <✓/✗>  no-zombies <✓/✗>  terminals-only <✓/✗>  windows-safe <✓/✗>
Verify:     tsc <✓/✗>  lint <✓/✗>  bundle <✓/✗>  persistence connect <✓/✗/n-a>
PR:         #NNN  (branch <name>, base master)   upstream ref: <#… or none>
```
