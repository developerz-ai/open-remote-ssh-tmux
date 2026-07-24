# v1.0.0 — tmux terminals, tests, rebrand, docs

## Goal
Ship v1.0.0 of **open-remote-ssh-tmux**: the tmux-backed persistent-terminal
feature (the fork's entire reason to exist), a unit-test harness (TDD is
mandatory), fork identity/branding, and docs updated to reflect what shipped.
Today the repo has **zero fork code** — it is upstream open-remote-ssh v0.2.0
plus vision docs.

## Context
- VS Code extension, TypeScript strict, CommonJS, webpack → `lib/extension.js`
  (`webpack.config.js`), Node 20, npm. `extensionKind: ["ui"]`
  (`package.json:436`), proposed APIs `resolvers`, `contribViewsRemote`.
- `ssh2` connection lives in `src/ssh/sshConnection.ts`; remote command seam =
  `SSHConnection#exec` (`src/ssh/sshConnection.ts:96`) and `#execPartial`
  (`:121`). Remote platform (Windows vs Unix) is detected in
  `serverSetup.installCodeServer` via `uname -s` (`src/serverSetup.ts:112-151`).
- The extension does **not** spawn terminals today — the vscode-server does.
  Only terminal touch: env-var injection `src/authResolver.ts:274-280`.
- Design decisions already made in `docs/idea/tmux-approach.md`: deterministic
  session names `code-<workspaceHash>-<n>` (`:54-59`); attach-or-create via
  `tmux new-session -A -s <name>` as the anti-zombie core; `remain-on-exit off`,
  **never** `destroy-unattached on` (`:64-67`); restore mapping in workspace
  state (`:60-63`); tmux is the single persistence owner — neutralise VS Code's
  own terminal persistence for these (`:43-48`).
- Scope: **terminals only**. SSH transport, `authResolver.ts` resolve flow,
  editing/file/protocol paths unchanged. tmux Unix-only — Windows remotes
  degrade to today's behaviour, never break connect.
- Invariants: **invisible UX** (user never sees/types tmux) and **no zombie
  sessions** (one live session per host+workspace+terminal-slot).
- **Multi-client rules** (owner-confirmed scenario, 2026-07-24): two clients
  (PC + laptop) may hit the same host+workspace. (1) A client never attaches a
  session currently attached by another client — it allocates fresh slots and
  creates its own. (2) A client re-attaches the sessions in *its own* restore
  mapping. (3) On connect, live but **detached** sessions of this workspace
  not in the client's mapping are **adopted** (opened as terminals) — so a PC
  reconnecting after the laptop worked sees its old terminals *plus* the
  laptop's. Hand-off (close PC → open laptop) is the adoption path.
  Detail in `04-terminal-profile.md`.
- Reference patterns: `src/hostTreeView.ts:27` (tree provider shape),
  `src/remoteLocationHistory.ts` (workspaceState persistence),
  `src/serverSetup.ts:231-232` (base64-piped remote script — quoting-safe),
  `src/extension.ts:8-30` (constructor-injected wiring).
- Fork hygiene: all new logic in `src/tmux/*` + `test/`; don't reformat
  upstream files.

## Plan files (execute in order)
1. [`01-test-harness.md`](01-test-harness.md) — vitest unit runner; backfill
   tests for existing pure modules; `npm test` wired into CI + pre-commit.
2. [`02-session-model.md`](02-session-model.md) — `src/tmux/tmuxSession.ts`:
   naming, escaping, attach-or-create command build, reap decisions (pure, TDD).
3. [`03-remote-bootstrap.md`](03-remote-bootstrap.md) — detect tmux on the
   remote over SSH; Unix-only gating; graceful degrade.
4. [`04-terminal-profile.md`](04-terminal-profile.md) — terminal-profile
   provider, default-profile wiring, restore mapping, reaping on connect,
   persistence-owner conflict handling.
5. [`05-package-contributes.md`](05-package-contributes.md) — settings
   (`remote.SSH.tmux.*`), terminal contribution, commands, activation.
6. [`06-rebrand-identity.md`](06-rebrand-identity.md) — rename to
   `open-remote-ssh-tmux`, README rewrite, CHANGELOG 1.0.0, LICENSE note.
7. [`07-docs-update.md`](07-docs-update.md) — docs/idea refreshed to "shipped"
   state, CLAUDE.md corrections, persistence model honesty check.
8. [`08-release-infra.md`](08-release-infra.md) — CI test gate, DX scripts,
   publish workflow under the new id, version 1.0.0, config cleanup.
9. [`09-verify.md`](09-verify.md) — end-to-end F5 acceptance matrix.

## Done when
- `npm test` exists, runs <10s, green; CI gates on build+lint+test.
- F5 EDH connect to a Unix remote: terminals persist across window close,
  disconnect, and vscode-server restart; re-open workspace → same sessions
  re-attached, zero duplicates; `tmux list-sessions` on the remote shows
  exactly one session per open terminal slot; user never saw the word tmux.
- Windows remote: connects and behaves exactly like upstream (feature off).
- `package.json` identity is `open-remote-ssh-tmux` under the fork publisher,
  `version: 1.0.0`; README describes the fork; CHANGELOG has a 1.0.0 section
  (release notes are parsed from it by `.github/scripts/get-changelog.js`).
- docs/idea and CLAUDE.md describe the implemented reality, not just intent.
- `v1.0.0` tag → `publish.yml` produces a `.vsix` GitHub release (+ Open VSX).

## Risks / open questions
- **Publisher id**: upstream id `jeanp413.open-remote-ssh` is taken; suggested
  `developerz-ai.open-remote-ssh-tmux` — executor confirms the actual publisher
  account before 06. Config keys / command ids (`remote.SSH.*`,
  `openremotessh.*`, `sshHosts`) deliberately stay unchanged for UX parity.
- **Profile injection point** (tmux-approach.md:78-89): extension
  `TerminalProfileProvider` vs injecting `terminal.integrated.defaultProfile`
  remote settings. 04 specifies the provider route but mandates an EDH spike
  first proving the profile spawns on the *remote*; fallback route documented
  there.
- **Double-persistence**: VS Code's own persistent-terminal revive can
  duplicate tmux re-attach. 04 owns the dedupe strategy; do not ship both
  owners active.
- **Security**: session names/paths interpolated into remote command lines —
  all tmux command construction goes through the escaping functions of 02
  (unit-tested), never string concat at call sites.
- **Upstream merges**: keep diffs to upstream files minimal (extension.ts
  wiring, package.json contributes, serverSetup platform surface only).
- Resize/reflow polish (status bar off, mouse, scrollback doubling) is scoped
  into 04's default tmux options — degrade honestly, don't chase perfection.
