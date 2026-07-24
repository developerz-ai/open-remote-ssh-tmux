# 03 — Remote bootstrap & capability gate

> Part of [`overview.md`](overview.md). Depends on: 02.

Decide per-connection whether tmux terminals are available: Unix remote +
tmux binary present. Off ⇒ behave exactly like upstream (hard requirement:
never break the base SSH connect).

## Files to change
- `src/tmux/tmuxBootstrap.ts` (new) — capability probe + result type.
- `src/serverSetup.ts:112-151` — expose the already-detected remote platform
  (`uname -s` result) to callers; today it's internal to `installCodeServer`.
  Smallest change: include `platform` in the returned install result (check
  `parseServerInstallOutput`, `src/serverSetup.ts:269-293`) — do NOT
  restructure the function (fork hygiene).
- `src/authResolver.ts:234-310` — after connect + server install, run the probe
  and stash the result where the terminal layer can read it (see 04). Keep the
  diff to a few lines; no logic in the resolver.
- `test/tmux/tmuxBootstrap.test.ts` (new).

## Steps
1. `probeTmux(exec: (cmd: string) => Promise<{stdout, stderr, code}>)` —
   dependency-inverted: takes an exec function, not `SSHConnection` (D in
   SOLID; trivially testable). Runs `command -v tmux && tmux -V`.
   Returns `{available: boolean, version?: string, reason?: 'windows' |
   'not-installed' | 'too-old'}`.
2. Version floor: parse `tmux -V` (`tmux 3.2a` etc.); require ≥ 2.6 (options
   used in 02 exist since then). Unparseable → treat as available but log
   version unknown (don't punish exotic builds).
3. Gate order: remote platform from serverSetup ≠ linux/macos ⇒
   `{available: false, reason: 'windows'}` — no probe attempted (a probe would
   error noisily on cmd/powershell).
4. Not installed ⇒ log one info line to the output channel
   (`src/common/logger.ts` `Log`) with the apt/brew hint; **no popup** by
   default (invisible UX). A popup only behind the 05 setting
   `remote.SSH.tmux.enabled` explicitly `true` and tmux missing — then the
   user opted in and deserves the warning.
5. No remote script/file installation in v1 — probe is exec-only. If a shipped
   script becomes necessary later it goes in `src/scripts/` + `.vscodeignore`
   (pattern: `src/serverSetup.ts:231-232`); note this, don't build it.

## Tests (write first — TDD)
- `probeTmux` with faked exec: found+version → available, version parsed;
  `command -v` fails → `not-installed`; `tmux 2.1` → `too-old`;
  weird version string → available, version undefined.
- Platform gate: windows platform short-circuits, exec never called
  (spy assert).
- Command: `npm test`, `npm run compile:src`, `npm run lint`.

## Verify
- Unit green; tsc/lint clean; F5 EDH: connect to a Unix host **without** tmux
  installed → identical to upstream behaviour, one log line, no UI noise;
  connect to a Windows host → unchanged connect, no probe traffic in the log.

## Done when
- Capability result available post-resolve; Windows/no-tmux paths provably
  identical to upstream; `serverSetup` diff ≤ ~10 lines.
