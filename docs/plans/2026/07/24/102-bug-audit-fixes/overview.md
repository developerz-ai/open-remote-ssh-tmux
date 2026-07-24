# Full-codebase bug audit — fixes

## Goal
Fix every verified bug found by a 5-agent audit of the whole extension — the fork's
tmux layer **and** inherited upstream open-remote-ssh code — plus close the missing-test
gaps. Findings are pre-verified with `file:line` evidence; slices below are the fix map.

## Context
- VS Code extension, TypeScript strict + CommonJS, webpack → `lib/extension.js`,
  `ssh2` transport, tmux on the remote for persistent terminals, server installed by
  `serverSetup` templated scripts. vitest (`npm test`), TDD: failing test first.
- Scope: terminals + bugfixes only. SSH transport architecture unchanged. Don't regress
  editing/file/protocol paths. Fork hygiene: surgical diffs in upstream files, no reformatting.
- Invariants: **invisible UX** (no tmux leak, no tmux-flavored errors) and **no zombie
  sessions** (deterministic naming, attach-or-create never duplicates, reap dead ones).
- Security-sensitive: `authResolver`, `ssh/*`, `scripts/*`, `tmux/*` — no secret logging,
  no weakened host-key checks, escape everything interpolated into remote command lines.
- Reference patterns: DI via constructors (`src/extension.ts`), argv-builders in
  `src/tmux/tmuxSession.ts` (single place tmux command lines are built), drift-guard
  tests in `test/package-manifest.test.ts`.

## Headline findings (most severe)
| # | Where | Defect |
|---|-------|--------|
| 1 | `src/authResolver.ts:216,256` | No host-key verification at all — `hostfile.ts` is dead code; MITM accepted silently |
| 2 | `src/tmux/terminalProvider.ts:138` | Restore re-attaches sessions another client holds → mirrored keystrokes after machine hand-off |
| 3 | `src/extension.ts:86-119` | Reconnect re-fires wiring; surviving provider holds dead SSH connection → new terminals fail post-reconnect |
| 4 | `src/scripts/server-setup.sh:153,180` | Unquoted `pushd`/`rm -rf $SERVER_DIR/*` — paths with spaces extract into `$HOME` / delete wrong paths |
| 5 | `src/tmux/tmuxSession.ts:177-184` | tmux `-t` prefix-matching — `…-1` resolves to `…-10`; reaper can kill the wrong live session |
| 6 | `src/tmux/sessionReaper.ts:96` | Reap predicate `windows === 0` unreachable → reaper is a no-op |
| 7 | `src/extension.ts:106,141` | `tmux.historyLimit` + `tmux.reapOnConnect` declared but never read; `tmux.enabled: 'on'` unimplemented |
| 8 | `src/remoteLocationHistory.ts:47` | Zero-folder workspace → TypeError in `activate()` → no commands registered |

## Plan files (execute in order)
1. [`01-tmux-invariants.md`](01-tmux-invariants.md) — tmux layer: no-steal restore, init race, `-t =` exact match, reap predicate, tombstoned closes, shellPath.
2. [`02-wiring-and-settings.md`](02-wiring-and-settings.md) — reconnect-safe wiring, dead settings wired for real, profile contribution/activation gaps.
3. [`03-hostkey-verification.md`](03-hostkey-verification.md) — wire `hostVerifier` + fix the dead `hostfile.ts` (await bug, ENOENT, plaintext entries).
4. [`04-ssh-robustness.md`](04-ssh-robustness.md) — crash-proof sockets/ProxyCommand, IPv6 parsing, encrypted-key auth, sshConfig include/multi-host fixes.
5. [`05-server-install.md`](05-server-install.md) — install scripts (quoting, locks, error branches, .sh/.ps1 parity), fetchRelease, serverSetup templating, serverConfig validation.
6. [`06-ui-and-common.md`](06-ui-and-common.md) — activation crash, history state, logger/files/ports fixes, command input parsing, manifest hygiene.
7. [`07-missing-tests.md`](07-missing-tests.md) — coverage gaps not tied to a fix + drift guards + repair weak/placeholder tests.
8. [`08-verify.md`](08-verify.md) — full gates + F5/EDH acceptance matrix (reconnect, hand-off, no-zombie).

Slices 01/02 (tmux+wiring) and 03/04/05/06 are largely disjoint file-sets; safe to
parallelize across agents in this checkout if slices are assigned whole. 07 runs after
01–06 (it tests final behavior); 08 last.

## Done when
- All slice "Done when" criteria met; `npm test`, `npm run compile:src`, `npm run lint`,
  `npm run bundle` all clean.
- F5/EDH matrix in `08-verify.md` passes: reconnect → new terminals still work; PC→laptop
  hand-off → no mirrored input; close-terminal → stays closed; no zombie sessions;
  "Persistent Shell" never errors in local/tmux-less windows.
- No declared setting is unread; no unread setting is declared (drift guard green).
- Host-key verification prompts on first connect and blocks on mismatch.

## Risks / open questions
- **Host-key UX (03):** first-connect consent prompt is new user-visible behavior vs
  upstream's (insecure) silence — keep wording close to OpenSSH/Remote-SSH conventions;
  a `remote.SSH.` escape-hatch setting may be warranted. Never weaken to auto-accept.
- **`tmux -t =name`:** exact-match `=` prefix is supported ≥ tmux 2.6 (the existing
  floor in `tmuxBootstrap`); keep floor and cite it in the builder comment.
- **Tombstoned closes (01):** decide kill-on-close (only when the pane's sole process is
  an idle shell) vs tombstone-in-state; plan default = tombstone (safer, reversible).
- **Upstream-merge hazard (04/05/06):** upstream files — smallest possible diffs, no
  reformat; isolate helpers rather than restructuring.
- **`.ps1` parity (05):** Windows remotes must still connect fine with tmux features off;
  never let a ps1 change break base SSH.
- Line numbers cited are pre-fix; re-locate by symbol if drifted.
