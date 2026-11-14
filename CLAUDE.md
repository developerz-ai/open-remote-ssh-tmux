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
- **SSH transport stays.** No transport rewrite, no mosh (considered for
  seamless roaming and deliberately dropped — it can't do machine hand-off; see
  `decision-mosh-vs-tmux.md`). The upstream SSH/server-install files are **not**
  untouched, though: `src/authResolver.ts`, `src/ssh/*`, `src/serverSetup.ts` and
  the install scripts carry fork hunks (marked `Fork:`) — a stricter host-key
  verifier (`@revoked`, `UserKnownHostsFile`/`GlobalKnownHostsFile`/`HostKeyAlias`),
  re-resolve teardown, the tmux capability probe, the diffed terminal environment
  (`common/envCollection.ts`), listeners bound to `127.0.0.1`, keepalive from
  `ServerAliveInterval`/`ServerAliveCountMax`, deadlines on the connect path, log
  redaction, and shell-quoting of templated settings. Keep each such hunk minimal
  and commented; the per-file inventory and merge procedure are in
  [`docs/upstream-sync.md`](docs/upstream-sync.md).
- **tmux owns process lifetime; VS Code owns the tabs.** Terminals run inside a
  long-lived tmux server on the remote, independent of the vscode-server and the
  SSH link. They are deliberately *not* `isTransient`: VS Code persists and
  revives the tabs (and their split layout), and every revive is answered by the
  profile provider with the *same* tmux session (`terminalProvider.ts`). Closing a
  tab kills its session; closing or reloading the window leaves it running (a
  remote close watch marks it so another machine can take it over at once).
- **Invisible to the user.** Same UX as open-remote-ssh — no tmux commands, no
  tmux UI. It's a pure under-the-hood upgrade.
- **No zombie sessions.** Deterministic session naming keyed to host+workspace +
  attach-or-create → re-opening re-attaches the *same* session, never a
  duplicate; dead sessions, and detached ones idle past
  `remote.SSH.tmux.orphanMaxAgeDays`, get reaped on connect. This is a hard requirement, not a
  polish item — see [`tmux-approach.md`](docs/idea/tmux-approach.md).
- **tmux is Unix-only** — degrade gracefully on Windows remotes (feature off /
  documented), never break the base SSH experience.

When a design choice can't meet "invisible + no zombies + terminals-only," say so
explicitly rather than shipping a leaky abstraction.

## Architecture — one responsibility per module (SRP)

The codebase is roughly 9k lines of TypeScript (`src/`, plus ~0.6k lines of
remote install scripts) and is organised by responsibility. Preserve that; each file below owns exactly one concern.

| File | Single responsibility |
|------|----------------------|
| `src/extension.ts` | Activation wiring plus the tmux layer's lifecycle glue: `TmuxLayerController` (wire the layer once, refresh it on every reconnect, rebuild or drop it on a setting/folder change; retry when a gate was unmet), `watchTmuxLayerInputs` (reacts to `remote.SSH.tmux.*` and workspace-folder changes without a reload), `wireTmuxTerminalLayer` (gated on the capability probe and `remote.SSH.tmux.enabled`), connect-time housekeeping, the hand-off / background-terminal / host-lifetime notifications, the session identity (`canonicalTmuxIdentity`), `lazyExec` + `tmuxExec` (current connection per call, deadline-bounded), the default-profile write, `onceOnly`, `TMUX_PROFILE_ID`. Anything bigger belongs in a collaborator, not here. |
| `src/authResolver.ts` | Resolve the remote authority: auth handshake → ensure server → produce the connection VS Code connects to. Upstream's core with fork hunks (see "SSH transport stays" above): it runs `probeTmux` from `src/tmux/tmuxBootstrap.ts` after connecting and applies the terminal environment via `common/envCollection.ts`. |
| `src/tmux/*` *(new)* | **The fork's addition.** `tmuxSession.ts` (pure session naming, canonical identity, attach-or-create/claim/list/kill builders, reap verdicts, `TMUX_BIN`; with `tmuxBootstrap.ts`'s probe commands, the only place tmux command lines are built), `tmuxBootstrap.ts` (capability probe, tmux ≥ 2.6 floor, logind lifetime probe), `remoteExec.ts` (`RemoteExec`: every remote tmux command under `sh -c` with an exit-code marker and a deadline; `createCloseWatch`: one close watch per SSH connection, which marks this window's sessions closed on the remote when the connection ends), `terminalProvider.ts` (VS Code `TerminalProfileProvider`, reconcile/restore/adopt, multi-client slot allocation, take-over), `slotState.ts` (pure slot decision: reclaim our own stale client, hand off an idle machine's, offer a live one — `remote.SSH.tmux.handOff`), `clientIdentity.ts` (the per-window owner tag: hashed machine id + window nonce), `settingsWatcher.ts` (pure decision for a settings change: rewire / refresh / offer-cleanup / none), `profileRegistration.ts` (sole owner of the single `tmux` terminal-profile id; dispose-then-register swap), `fallbackTerminalProvider.ts` (plain-shell provider on that id when tmux is unavailable or disabled), `sessionReaper.ts` (connect-time housekeeping: dead sessions and aged-out orphans; the workspace kill path). The heart of open-remote-ssh-tmux. |
| `src/clipboard/*` *(new)* | Clipboard→remote image bridge, independent of `src/tmux/*` (no imports either way). `clipboardImage.ts` (pure command/path builders, the only place the clipboard's own home-lookup/mkdir/cleanup command lines are built), `clipboardWebview.ts` (last-resort local clipboard reader via a webview), `pasteImage.ts` (orchestration: read local clipboard → write to remote → bracketed-paste the path). |
| `src/serverSetup.ts` | Install / locate the VS Code server on the remote (script templating, path resolution, release fetch). |
| `src/serverConfig.ts` | Compute the wanted server version/quality/commit + validation policy. |
| `src/fetchRelease.ts` | Fetch release metadata (network I/O, no policy). |
| `src/commands.ts` | Command handlers invoked from the palette / menus, including the kill-workspace-sessions command. Thin — delegate. |
| `src/hostTreeView.ts` | The "SSH Targets" tree view (presentation only). |
| `src/remoteLocationHistory.ts` | Persist & recall recently opened remote folders. |
| `src/ssh/sshConnection.ts` | The `ssh2` connection + tunnel primitives. |
| `src/ssh/sshConfig.ts` | Parse & query the user's SSH config file. |
| `src/ssh/sshDestination.ts` | Parse/format a `user@host:port` destination. |
| `src/ssh/identityFiles.ts` | Discover & load identity/key files. |
| `src/ssh/hostfile.ts` | known_hosts handling. |
| `src/common/*` | Cross-cutting leaf utilities: `logger.ts`, `ports.ts`, `files.ts`, `platform.ts`, `disposable.ts`, `deadline.ts` (`withDeadline` / `DeadlineError` — bounds any remote round-trip), `shellQuote.ts` (`escapeShellArg` and the PowerShell counterpart — the one shell-quoting implementation, re-exported by `tmuxSession.ts`), `envCollection.ts` (diff-before-write of the terminal environment so reconnects do not prompt to relaunch live terminals). Depend on nothing in the project. |
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
gaps to close (unit suite: vitest, `npm test`; real tmux over real SSH: the docker
rig, `npm run test:tmux`; the F5/EDH acceptance record is in `docs/plans/` — see
"Build & verify"). For AI-first conventions
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
npm install            # postinstall pulls vscode dts (and runs scripts/patch-ssh2.js)
npm run compile:src    # tsc -b (src only → out/), then compile:test: type-checks
                       # test/ + vitest.config.ts via tsconfig.test.json (noEmit)
npm run watch:src      # tsc-watch + dev bundle
npm run bundle         # webpack production → lib/extension.js
npm run build          # clean + compile + bundle (what vsce:prepublish runs)
npm run lint           # eslint
npm test               # vitest `unit` project — pure logic, no docker, seconds
npm run test:tmux      # vitest `integration` project against REAL tmux over real
                       # SSH: docker rig (test/rig/), tmux 2.6, 3.0a, 3.4, 3.5a, 3.8
npm run test:tmux:one  # the rig, reference version (3.4) only
npm run package        # produce the .vsix
```

`npm run test:tmux` needs docker with the compose plugin; without it the run is
skipped locally and **fails in CI**. `bin/check` runs compile + lint + unit tests
(`bin/check --full` adds the rig).

**CI gates** (`.github/workflows/`): every PR and push to `main` runs build,
the unit tests under coverage thresholds (`npm run test:coverage`) plus the unit
tests on Windows and macOS, `lint:package` (fixpack, must leave `package.json`
unchanged), `npm run lint` (zero warnings, typed rules), commitlint, a `package` job that builds the `.vsix` and checks
its contents against `.vscodeignore`, and the tmux rig as one job per tmux
version. `publish.yml` runs on a `v*` tag only, refuses a tag that is not
`v` + the `package.json` version, and re-runs build, test and lint before it
packages and creates the GitHub Release (Open VSX only when the
`PUBLISH_OPENVSX` variable is `yes`). `npm audit` and zizmor run daily in
`audit.yml` rather than on PRs.

**Unit TDD** is the workflow: write the failing unit test first, then the code to
pass it. The pure logic (session naming, attach-or-create, slot and reap
decisions, `sshConfig`, `sshDestination`, `serverConfig`, `ports`,
`splitProxyCommand`) is unit-tested first; anything whose truth depends on how
tmux really behaves gets a rig test too. "Verify" then means: failing-test-first
→ code → `tsc` clean, `eslint` clean, unit tests green, the rig green for tmux
changes, and — for anything touching the resolver or the tmux terminal layer —
`F5` (Extension Development Host) and a real connect proving terminals persist and
re-attach (disconnect → reconnect → same session; re-open workspace → no
duplicate/zombie session). The v1.0.0 F5 acceptance run
([`results-2026-07-24.md`](docs/plans/2026/07/24/101-v1-tmux-release/results-2026-07-24.md),
matrix in
[`09-verify.md`](docs/plans/2026/07/24/101-v1-tmux-release/09-verify.md)) is
superseded by the hardening sweep's run
([`101-bulletproof-hardening-sweep/09-verify.md`](docs/plans/2026/11/13/101-bulletproof-hardening-sweep/09-verify.md));
read the newest results file before trusting a row. Re-run the zombie rows (6-9)
for any change to the tmux terminal layer.

## Git / PR discipline

- **Conventional Commits**, enforced by commitlint + husky. Allowed types:
  `build chore ci docs enhance feat fix perf refactor remodel revert style test vcs`.
  Body lines ≤ 200 chars. (`chore` is allowed for the platform's automated
  follow-up commits — see `commitlint.config.js`; prefer a specific type by hand.)
  `test/commitlint-policy.test.ts` keeps this list equal to the config.
- Branch off `main`; never commit straight to it.
- **Fork hygiene:** we track upstream `jeanp413/open-remote-ssh`. Keep the tmux
  changes isolated and well-labelled (their own `src/tmux/*` module) so upstream
  fixes still merge cleanly. Don't gratuitously reformat upstream files — it
  poisons future merges. Merging upstream: [`docs/upstream-sync.md`](docs/upstream-sync.md).
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
