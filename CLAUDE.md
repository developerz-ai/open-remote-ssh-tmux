# CLAUDE.md — open-remote-ssh-tmux

## What this is

A VS Code / VSCodium extension that connects to a remote dev machine over SSH —
**identical to [jeanp413/open-remote-ssh](https://github.com/jeanp413/open-remote-ssh)
in look and feel** — but with one under-the-hood upgrade: the **remote terminals
are backed by [tmux](https://github.com/tmux/tmux)** so they persist and can be
re-attached from any machine.

It is a **fork of open-remote-ssh**. Upstream resolves the `ssh-remote`
authority over SSH, installs the VS Code server, and runs the remote session over
that SSH channel. We keep all of that. We add tmux-backed terminals so a long
task (e.g. a **Claude Code** run) survives client disconnects, window closes, and
**machine hand-off** (close the PC, open the laptop, re-attach to the same live
terminals).

**Read [`docs/idea/`](docs/idea/README.md) first** — it's the *why*: the
PC/laptop/VPS hand-off, keeping a long Claude Code task alive, the honest
[`persistence-model.md`](docs/idea/persistence-model.md), the tmux design in
[`tmux-approach.md`](docs/idea/tmux-approach.md), why-tmux-not-mosh in
[`decision-mosh-vs-tmux.md`](docs/idea/decision-mosh-vs-tmux.md), and the
[`ai-first.md`](docs/idea/ai-first.md) stance.

### The shape of the change

- **Scope is terminals only.** Editing, file changes, saving, extensions, and
  port forwarding already reconnect fine (the vscode-server persists) — **do not
  touch that path and do not regress it.** The one problem we fix is terminal
  lifetime.
- **SSH transport stays.** No transport rewrite. `ssh2` auth
  (`src/authResolver.ts`, `src/ssh/*`) is unchanged. (Mosh was considered for
  seamless roaming and deliberately dropped — it can't do machine hand-off; see
  `decision-mosh-vs-tmux.md`.)
- **tmux owns terminal lifetime.** Terminals run inside a long-lived tmux server
  on the remote, independent of the vscode-server and the SSH link. Neutralise
  VS Code's own persistent-terminal layer for these so there's a single owner.
- **Invisible to the user.** Same UX as open-remote-ssh — no tmux commands, no
  tmux UI. It's a pure under-the-hood upgrade.
- **No zombie sessions.** Deterministic session naming keyed to host+workspace +
  attach-or-create → re-opening re-attaches the *same* session, never a
  duplicate; empty/dead sessions get reaped. This is a hard requirement, not a
  polish item — see [`tmux-approach.md`](docs/idea/tmux-approach.md).
- **tmux is Unix-only** — degrade gracefully on Windows remotes (feature off /
  documented), never break the base SSH experience.

When a design choice can't meet "invisible + no zombies + terminals-only," say so
explicitly rather than shipping a leaky abstraction.

## Architecture — one responsibility per module (SRP)

The codebase is small (~2.3k LOC, `src/`) and already organised by
responsibility. Preserve that; each file below owns exactly one concern.

| File | Single responsibility |
|------|----------------------|
| `src/extension.ts` | Activation wiring only — construct collaborators, register with VS Code, push disposables. No logic. |
| `src/authResolver.ts` | Resolve the remote authority: auth handshake → ensure server → produce the connection VS Code connects to. Upstream's core; **we leave it alone** (terminals-only scope). |
| `src/tmux/*` *(new)* | **The fork's addition.** `tmuxSession.ts` (pure session-naming/attach-or-create/reap-decision logic, the only place tmux command lines are built), `tmuxBootstrap.ts` (capability probe), `terminalProvider.ts` (VS Code `TerminalProfileProvider` wiring, multi-client slot allocation), `sessionReaper.ts` (connect-time cleanup of dead/empty sessions). The heart of open-remote-ssh-tmux. |
| `src/serverSetup.ts` | Install / locate the VS Code server on the remote (script templating, path resolution, release fetch). |
| `src/serverConfig.ts` | Compute the wanted server version/quality/commit + validation policy. |
| `src/fetchRelease.ts` | Fetch release metadata (network I/O, no policy). |
| `src/commands.ts` | Command handlers invoked from the palette / menus. Thin — delegate. |
| `src/hostTreeView.ts` | The "SSH Targets" tree view (presentation only). |
| `src/remoteLocationHistory.ts` | Persist & recall recently opened remote folders. |
| `src/ssh/sshConnection.ts` | The `ssh2` connection + tunnel primitives. |
| `src/ssh/sshConfig.ts` | Parse & query the user's SSH config file. |
| `src/ssh/sshDestination.ts` | Parse/format a `user@host:port` destination. |
| `src/ssh/identityFiles.ts` | Discover & load identity/key files. |
| `src/ssh/hostfile.ts` | known_hosts handling. |
| `src/common/*` | Cross-cutting leaf utilities: `logger`, `ports`, `files`, `platform`, `disposable`. Depend on nothing in the project. |
| `src/scripts/*.sh \| *.ps1` | Remote-side install scripts (templated by `serverSetup`). |

Dependency direction: `extension` → feature modules → `ssh/*` / `serverSetup`
→ `common/*`. `common/*` never imports upward. Keep it that way.

## SOLID / SRP rules for changes here

Follow these — they override the temptation to "just add it where it's easy":

- **S — Single Responsibility.** One reason to change per module/function. If a
  file starts doing auth *and* UI *and* persistence, split it. The tmux
  integration gets its own module(s) (e.g. `src/tmux/tmuxSession.ts` for
  naming/attach-or-create/reaping, `src/tmux/terminalProvider.ts` for the VS Code
  terminal-profile wiring) — **do not bolt tmux logic onto the SSH classes** or
  the resolver.
- **O — Open/Closed.** Extend by adding a collaborator, not by editing a stable
  module's internals. The terminal layer plugs into the existing connection; it
  doesn't require rewriting `authResolver`.
- **L — Liskov.** Any abstraction the terminal layer introduces (e.g. a
  "terminal backend") must have implementations that honour the same contract
  callers assume — the tmux backend and a plain-shell fallback (Windows remotes)
  behave predictably, no "throws on this method" surprises.
- **I — Interface Segregation.** Small, purpose-specific interfaces. The tree
  view shouldn't depend on tmux internals; the tmux session manager shouldn't
  depend on view types.
- **D — Dependency Inversion.** High-level flow depends on abstractions (a
  command runner over the connection, a clock for reaping), not concrete `ssh2`
  or `child_process` calls scattered inline. Inject `Log` and collaborators via
  constructors — the code already does this (see `extension.ts`); keep it.

Practical: no god functions, no reaching across layers, delete before you
abstract, and introduce an abstraction only when there's a second real consumer
(e.g. tmux backend + Windows-shell fallback).

## AI-first

This is an **AI-first repo** — agents write ~100% of the code, humans review and
steer. Conventions inherit from [`../gold-standards-in-ai/`](../gold-standards-in-ai/docs/00-philosophy.md)
(great DX = fast agents; write everything down; low undefined behaviour; surgical
diffs). **Unit TDD is the workflow: write the failing unit test first, then the
code to pass it — no test, no merge.** See
[`docs/idea/ai-first.md`](docs/idea/ai-first.md) for what's already set up vs. the
gaps to close (test suite is wired up — vitest, `npm test`; the empirical F5/EDH
persistence proof is now done — 19/21 acceptance rows PASS, see
`docs/plans/2026/07/24/101-v1-tmux-release/results-2026-07-24.md`). For AI-first conventions
(DX scripts, hooks/permissions, testing) mirror the patterns in
[`../gold-standards-in-ai/`](../gold-standards-in-ai/docs/writing-for-agents/README.md)
and [`../ai-task-master/`](../ai-task-master/CLAUDE.md).

## Conventions (match the repo, don't invent)

- **Language:** TypeScript, `strict` mode, target ES2020, CommonJS. No `any`
  (`noImplicitAny`), no unused locals/params, explicit `override`. Honour the
  existing `tsconfig.json`.
- **Indentation:** 4-space (see `.editorconfig`). YAML 2-space, JSON tabs,
  shell/PowerShell 2-space. LF, final newline, trimmed trailing whitespace.
- **Lint:** ESLint (`@stylistic`, `typescript-eslint`, `jsdoc`). Run
  `npm run lint` / `npm run lint:fix`.
- **Comments:** match the surrounding density. The good examples
  (`splitProxyCommand` in `authResolver.ts`, the template helpers in
  `serverSetup.ts`) explain *why* + link the upstream issue. Do that when the
  reasoning is non-obvious; don't narrate the obvious.
- **Node:** v20 (`.nvmrc` `v20.20.2`). npm, not pnpm/yarn/bun.

## Build & verify

```bash
npm install            # postinstall pulls vscode dts
npm run compile:src    # tsc -b  → out/   (fast typecheck)
npm run watch:src      # tsc-watch + dev bundle
npm run bundle         # webpack production → lib/extension.js
npm run build          # clean + compile + bundle (what vsce:prepublish runs)
npm run lint           # eslint
npm run package        # produce the .vsix
```

**Unit TDD** is the workflow: write the failing unit test first, then the code to
pass it. The test suite is wired up — **vitest, `npm test`** (see
[`docs/idea/ai-first.md`](docs/idea/ai-first.md)) — and the pure logic (session
naming, attach-or-create, reap decisions, `sshConfig`, `sshDestination`,
`serverConfig`, `ports`, `splitProxyCommand`) is unit-tested first. "Verify" then
means: failing-test-first → code → `tsc` clean, `eslint` clean, unit tests green,
and — for anything touching the resolver or the tmux terminal layer — `F5`
(Extension Development Host) and a real connect proving terminals persist and
re-attach (disconnect → reconnect → same session; re-open workspace → no
duplicate/zombie session). That empirical F5/EDH proof was run against a real
tmux rig for v1.0.0 — 19/21 rows PASS, results in
[`results-2026-07-24.md`](docs/plans/2026/07/24/101-v1-tmux-release/results-2026-07-24.md),
matrix definition in
[`09-verify.md`](docs/plans/2026/07/24/101-v1-tmux-release/09-verify.md). Two rows
remain open and are documented as known limitations: **row 13** (Windows remote —
needs a real Windows SSH target; the platform gate is confirmed to engage) and
**row 18** (Claude Code TUI redraw after reattach — the underlying mechanism is
covered by rows 2/20/21). Re-run the zombie rows (6-9) for any change to the tmux
terminal layer.

## Git / PR discipline

- **Conventional Commits**, enforced by commitlint + husky. Allowed types:
  `build ci docs enhance feat fix perf refactor remodel revert style test vcs`.
  Body lines ≤ 200 chars.
- Branch off `main`; never commit straight to it.
- **Fork hygiene:** we track upstream `jeanp413/open-remote-ssh`. Keep the tmux
  changes isolated and well-labelled (their own `src/tmux/*` module) so upstream
  fixes still merge cleanly. Don't gratuitously reformat upstream files — it
  poisons future merges.
- Commit / push only when asked. Co-author trailer as configured.

## Guardrails

- This extension executes remote commands/scripts and handles credentials/keys.
  Treat `src/ssh/*`, `src/authResolver.ts`, `src/scripts/*`, and any new
  `src/tmux/*` as security-sensitive: no logging of secrets, no weakening
  host-key verification, no shell injection when building `tmux` command lines
  sent to the remote (quote/escape session names and paths).
- **Terminals only** — don't change the editing/file/protocol path; don't
  regress the base open-remote-ssh experience.
- **Invisible + no zombies** are hard requirements. If a design leaks tmux to the
  user or risks orphaned sessions, surface it — don't ship it quietly.
- tmux is Unix-only — degrade gracefully on Windows remotes, never break the base
  SSH connect.

## Note

Do not use git worktrees — work directly in this checkout. If a task is big enough to need subagents, run them as a team in this same checkout: split the work into disjoint pieces so no two agents touch the same files.
