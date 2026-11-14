# 02 — Exec deadlines, exit codes, keepalive

> Part of [`overview.md`](overview.md). Depends on: 01.

Problem `[V]`: `SSHConnection#exec` resolves only on stream `close`, no timer, no `error`
handler, no exit code (`src/ssh/sshConnection.ts:111-131`). No keepalive anywhere. `probeTmux` is
awaited inside `resolve()` (`src/authResolver.ts:701`) → a hung probe hangs the base SSH connect.
`provideTerminalProfile` awaits up to two `refreshRemote` (`src/tmux/terminalProvider.ts:555,576,593`)
→ "New Terminal" can spin forever. Kill reports success on any delivered command
(`src/tmux/sessionReaper.ts:166-169`, `src/commands.ts:157`).

## Files to change
- `src/common/deadline.ts` (new) — `withDeadline<T>(p, ms, label): Promise<T>`; rejects with a
  typed `DeadlineError`; clears its timer. Leaf, no project imports.
- `src/tmux/remoteExec.ts` (new) — the tmux layer's command-runner abstraction:
  `RemoteExec = (cmd) => Promise<{stdout, stderr, code}>`; wraps the injected raw exec with
  `withDeadline` + a trailing `; echo __rc=$?` marker parse (run through `sh -c`, same wrapping
  as `PROBE_COMMAND`, `src/tmux/tmuxBootstrap.ts:45`) so no upstream signature change is needed.
- `src/extension.ts:395-403` (`lazyExec`), `:653` (`resolveKillTarget`) — hand the provider/reaper
  a `RemoteExec`; deadlines from named constants (probe 5 s, list/has/kill 8 s).
- `src/tmux/tmuxBootstrap.ts:66-74` — probe under deadline; timeout → capability `unknown` →
  fallback shell this resolve, retry next resolve (`idempotentResolveHandler` already retries,
  `src/extension.ts:376`).
- `src/tmux/terminalProvider.ts:219` (`MISSING_SESSION_RE`), `:408-495` (`plan`), `:442` — classify
  `has-session` by exit code + stderr into `present | absent | unreachable | incompatible`;
  prune only on `absent`. Replace N sequential `has-session` with one batched command
  (builder in `tmuxSession.ts`, one line per name).
- `src/tmux/tmuxSession.ts:270-291` — `buildHasSessionsCommand(names)`; pure classifier
  `classifyTmuxFailure(stderr, code)`.
- `src/tmux/sessionReaper.ts:166-169`, `src/commands.ts:157` — count a kill only when `code === 0`
  or the session is `absent` afterwards.
- `src/authResolver.ts:609,669` — add `keepaliveInterval` / `keepaliveCountMax` next to
  `readyTimeout` (values from existing `remote.SSH.connectTimeout`-style config or constants;
  honour `ServerAliveInterval`/`ServerAliveCountMax` from ssh config if present,
  `src/ssh/sshConfig.ts`). Two-line upstream hunk.
- `src/ssh/sshConnection.ts:111-131` — add stream `error` → reject only (minimal upstream hunk).

## Steps
1. `deadline.ts` + tests.
2. `remoteExec.ts` + classifier + batched builder + tests.
3. Thread `RemoteExec` through provider, reaper, kill command; delete the old stderr-only guess.
4. `provideTerminalProfile`: on `unreachable`/deadline, return the plain-shell profile for this
   one terminal and log one Info line — never an unresolved promise, never tmux text in UI.
5. Keepalive + `error` handler hunks.

## Tests (write first — TDD)
- `test/common/deadline.test.ts` — resolves/rejects pass through; rejects at deadline with label;
  timer cleared (fake timers).
- `test/tmux/remoteExec.test.ts` — rc marker parsed; missing marker → `code: undefined` +
  `unreachable`; banner noise before marker tolerated.
- `test/tmux/tmuxSession.test.ts` — `classifyTmuxFailure`: `can't find session` → absent;
  `no server running` → absent; `error connecting … Permission denied` → unreachable;
  `protocol version mismatch` → incompatible; empty stderr + rc≠0 → unreachable.
- `test/tmux/terminalProvider.test.ts` — never-settling exec: `initialize` and
  `provideTerminalProfile` settle within deadline; mapping NOT pruned on unreachable/incompatible;
  one batched has-session call for N slots.
- `test/tmux/tmuxBootstrap.test.ts` — probe timeout → unavailable-retryable, no throw.
- `test/tmux/sessionReaper.test.ts`, `test/commands.killWorkspaceSessions.test.ts` — failed kill
  not counted; message reflects real count.
- `test/authResolver.*.test.ts` — connect config carries keepalive values.
- Rig: the two `it.fails` from slice 01 tagged (02) flip to passing.
Commands: `npm run compile:src`, `npm run lint`, `npm test`, `npm run test:tmux`.

## Verify
- Unit + rig green. F5: connect, `kill -STOP` the remote sshd session child → new terminal opens a
  plain shell within the deadline, base editing still works; `kill -CONT` → next terminal is tmux.
- Reconnect after laptop-sleep simulation (drop packets with `iptables` on the rig) detected via
  keepalive, not after minutes.

## Done when
- No `await` on a remote command without a deadline in `src/tmux/*`, `src/extension.ts`.
- Probe failure/timeout cannot delay `resolve()` beyond the probe deadline.
- Reconcile for N slots costs 2 remote round-trips (list + batched has), not N+1.
