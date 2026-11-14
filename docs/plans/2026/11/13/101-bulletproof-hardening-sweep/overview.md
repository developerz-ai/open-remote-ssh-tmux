# Bulletproof hardening sweep (terminals, connection, tests, release)

## Goal
Close every verified robustness/security/test gap found by a full audit of v1.2.0 (code read +
real VSCodium logs 2026-11-04…13 + live remote state), and make regressions mechanically
impossible: a committed real-tmux rig, hard CI gates, truthful docs.

## Context
- VS Code/VSCodium extension, `extensionKind: ["ui"]`, TypeScript strict + CommonJS, webpack →
  `lib/extension.js`, `ssh2@1.17.0` (patched by `scripts/patch-ssh2.js`), vitest (`npm test`, ~698
  cases, all with faked `exec`/tmux), Node 20, npm.
- Terminal = VS Code pty running `tmux <argv>` directly (`shellPath` tmux, `shellArgs` from
  `buildAttachOrCreateArgv`, `src/tmux/tmuxSession.ts:167`). Session name
  `code-<sha1_12(host+' '+path)>-<slot>`. Slot verdicts: `decideSlotAction`
  (`src/tmux/slotState.ts:86`). Remote one-shot commands: `SSHConnection#exec`
  (`src/ssh/sshConnection.ts:111`) via `lazyExec` (`src/extension.ts:395`).
- Scope: terminals first. Slices 02 and 06 touch upstream-derived files (`src/ssh/*`,
  `src/authResolver.ts`) — smallest possible diff, no reformatting, each hunk commented with why.
  Editing/file/port-forward protocol path: behaviour unchanged.
- Invariants: invisible UX (no tmux keys/UI/error text reaching the user), no zombie sessions,
  no steal of another machine's live client, Windows remotes degrade to plain shell, tmux command
  lines injection-safe.
- Reference patterns:
  - pure decision + `describe*` log line: `src/tmux/slotState.ts:86-142`
  - command builders, exact `=name` targets: `src/tmux/tmuxSession.ts:270-291`
  - injected `exec`/`Log`/clock: `src/tmux/sessionReaper.ts:97`, `src/extension.ts:205-226`
  - settings read + pure wiring decision: `src/extension.ts:438-470`
  - manifest drift guard: `test/package-manifest.test.ts`

## Evidence legend
`[V]` verified in code or logs. `[S]` suspected — reproduce on the rig (slice 01) before fixing;
if it does not reproduce, record that in `status.yml` notes and drop the step.

## Field evidence (logs, `~/.local/state/VSCodium/*/window*/exthost/output_logging_*/1-Remote - SSH.log`)
| Observation | Count | Slice |
|---|---|---|
| mapped slots, 0 sessions on remote → pruned (remote reboot; prune correct) | 11 of 17 wirings | 05 (server lifetime), 08 (docs) |
| `Error while creating SOCKS connection … Proxy connection timed out` ~22 s after connect, bursts across windows | 6 | 06 |
| `revive went quiet for 2000ms … opening them directly` (timing heuristic decided restore) | 1 | 05 |
| `closed by shell process exit — session kept` (shell exited; wording wrong) | 5 | 05 |
| full install script dumped at Trace per connect | 37 | 06 |
| ssh-agent `ECONNRESET` logged at Error, auth then succeeds | 1 | 06 |
| sequential `has-session`, ~400 ms each | every reconcile | 02 |
| remote: tmux 3.4 server in `user-1001.slice/session-26.scope`, `Linger=no`; detached `code-7d6c49c69396-0` never aged out | live | 05 |

## Plan files (execute in order)
1. [`01-real-tmux-rig.md`](01-real-tmux-rig.md) — committed docker rig + integration tests against real tmux (version matrix); everything after verifies on it.
2. [`02-exec-deadlines.md`](02-exec-deadlines.md) — timeouts, exit codes, keepalive, error classification for every remote exec.
3. [`03-handoff-ownership.md`](03-handoff-ownership.md) — fix cross-machine eviction and the 3 h hand-off block (owner tag, explicit detach, take-over policy).
4. [`04-tmux-command-hardening.md`](04-tmux-command-hardening.md) — argv chain: `historyLimit` clamp, real restore of user globals, prefix/escape-time/env leaks, format chars in cwd, probe parsing.
5. [`05-session-lifecycle.md`](05-session-lifecycle.md) — orphan aging, settings changes at runtime, identity canonicalisation, reconcile races, slot leak, tmux server lifetime.
6. [`06-connection-security.md`](06-connection-security.md) — localhost-only listeners, SOCKS timeout, close hang, known_hosts, ProxyCommand on Windows, log hygiene.
7. [`07-ci-release-gates.md`](07-ci-release-gates.md) — lint that can fail, package in PR CI, publish gates, engines floor, SECURITY.md.
8. [`08-docs-truth.md`](08-docs-truth.md) — CLAUDE.md / `docs/idea` / README corrected to match code; upstream-sync procedure.
9. [`09-verify.md`](09-verify.md) — full acceptance run, results file, release notes.

## Done when
- `npm run compile:src`, `npm run lint` (zero warnings), `npm test`, `npm run test:tmux` (rig,
  all matrix versions), `npm run bundle`, `npm run package` all green locally and in PR CI.
- Two-client rig tests prove: no eviction of a live foreign client; hand-off after an abrupt
  client death needs no manual `tmux detach-client`.
- No remote exec can wait longer than its deadline; a hung tmux probe cannot delay the base connect.
- User's tmux server options are unchanged after our terminals open, except the documented list.
- No listener binds a non-loopback address.
- Acceptance matrix re-run on v-next with a new `results-<date>.md`; rows 6-9, 20, 21 PASS without
  manual steps; rows 13 and 18 either PASS or stay documented.
- CLAUDE.md, `docs/idea/*`, README make no claim the code contradicts.

## Risks / open questions
- **Hand-off policy (slice 03) — owner decision.** Recommended: auto take-over when the foreign
  client is provably stale (explicit-detach marker or idle beyond threshold), otherwise one
  non-modal "open on another machine — Take over" notification; setting
  `remote.SSH.tmux.handOff: auto | ask | never`, default `auto`. Alternative: always mirror
  (tmux-native multi-client; resize contention). Do not ship silent `-D` on foreign clients.
- **tmux server lifetime under systemd (slice 05).** Wrapping the server start in
  `systemd-run --user --scope` changes `shellPath`; recommended v-next = detect + one-time warning
  only. Confirm with owner before any wrapper.
- **Upstream-file diffs (02, 06).** Keep hunks minimal; list each in the PR body for future merges.
  No upstream remote exists — slice 08 adds the procedure.
- **`[S]` items** may not reproduce; never "fix" one without a failing rig/unit test first.
- **tmux floor 2.6** may be unsupportable once the matrix runs; raising it is acceptable if
  `tmuxBootstrap` degrades to plain shell below the new floor and docs say so.
- Remote box reboots kill all sessions (tmux has no resurrection) — out of scope; document only.
