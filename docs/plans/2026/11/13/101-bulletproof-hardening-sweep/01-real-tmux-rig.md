# 01 — Real-tmux rig and integration tests

> Part of [`overview.md`](overview.md). Depends on: none.

Why first: every unit test fakes `exec` and tmux `[V]`; that is how the `=name:` target bug
shipped (`docs/plans/2026/07/24/102-bug-audit-fixes/status.yml`). The v1 acceptance rig (Xvfb +
xdotool + two docker sshd, `docs/plans/2026/07/24/101-v1-tmux-release/results-2026-07-24.md:3-22`)
was never committed `[V]`.

## Files to change
- `test/rig/Dockerfile` (new) — debian-slim + openssh-server + tmux built at a pinned tag via
  `ARG TMUX_VERSION`; extra login shells installed (bash, zsh, fish, dash, tcsh).
- `test/rig/compose.yml` (new) — one service per matrix version: floor `2.6`, `3.0a`, `3.4`, `3.5a`
  (latest stable at execution time). Loopback-published ports only; throwaway key generated at run.
- `test/rig/run.sh` (new, 2-space) — build, up, run vitest integration project, down. Skips with a
  clear message + non-zero only in CI when docker is absent.
- `vitest.config.ts` — second project `integration` (`test/integration/**/*.itest.ts`), excluded
  from `npm test`.
- `package.json:18-43` — scripts `test:tmux` (`test/rig/run.sh`), `test:tmux:one` (single version).
- `test/integration/rigExec.ts` (new) — `exec` over real `ssh2` to the rig using
  `SSHConnection` (`src/ssh/sshConnection.ts`), same signature the provider gets from `lazyExec`
  (`src/extension.ts:395`). Second helper spawns a real attached client:
  `ssh -tt … tmux <buildAttachOrCreateArgv(...)>` under a pty, to model a VS Code terminal.
- `test/integration/*.itest.ts` (new) — see Tests.
- `tsconfig.test.json` — include `test/integration`, `test/rig` helpers.
- `.github/workflows/ci-pr.yml`, `ci-main.yml` — job `tmux-rig` running `npm run test:tmux`
  (matrix over versions; pinned action SHAs, `permissions: {}` like existing jobs).
- `bin/check` — add `npm run test:tmux` behind a `--full` flag.

## Steps
1. Build the rig; prove `ssh` + `tmux -V` per version.
2. Port the one-off real-tmux checks from plan 102 slice 08 into itests (baseline, must pass on
   current code for 3.4; failures on other versions become findings for slice 04).
3. Add the two-client helper; write the hand-off itests as **expected-fail** (`it.fails`) — they
   are the spec slice 03 turns green.
4. Record per-version results table in `status.yml` notes (which flags fail where).

## Tests (write first — TDD)
Baseline (must pass on 3.4 today):
- `probe.itest.ts` — `probeTmux` (`src/tmux/tmuxBootstrap.ts:66`) against each version and each
  login shell; absolute path returned.
- `attachOrCreate.itest.ts` — argv creates session; second run attaches same session (count stays
  1); `status off`, `mouse on`, pane `#{history_limit}` equals the setting; cwd with space, `'`,
  `"`, `$`, unicode, newline.
- `listParse.itest.ts` — `parseListSessions` over real `list-sessions` output incl. foreign
  sessions (`dev`, `main`) never classed as ours (`isOurSession`).
- `reaper.itest.ts` — `SessionReaper#reap` never kills a live or foreign session.
Spec for later slices (author now as `it.fails`, each tagged with its slice):
- two clients, A adopted by B, A reconnects → B's client still attached (03).
- client A killed with SIGKILL (no detach) → B gets the session without manual detach (03).
- user server with `set -g history-limit 100000` → value unchanged after our attach (04).
- cwd containing `#(touch /tmp/pwned)`, `#S`, trailing `;` → no file created, cwd exact (04).
- `historyLimit` 1.5 / -1 / 1e10 → session still created (04).
- stale tmux socket / protocol mismatch stderr → classified, not pruned (02).
- exec against a `SIGSTOP`ed sshd child → rejects within deadline (02).
- Ctrl-B, Esc timing: bytes reach the inner program unmodified, Esc latency < 50 ms (04).
Commands: `npm run compile:src`, `npm run lint`, `npm run test:tmux`.

## Verify
- `npm run test:tmux` green for baseline tests on 3.4; per-version failures listed, not hidden.
- `npm test` unchanged in duration (integration project excluded).
- CI job runs on a PR and blocks on baseline failures.

## Done when
- Rig reproducible from a clean checkout with docker only; no manual steps.
- Every later slice has a named failing itest waiting for it.
