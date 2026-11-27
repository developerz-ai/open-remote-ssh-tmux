# Deferred findings (bug sweep 2026-11-26)

Real, narrow, and not fixed in v1.5.0. Each was raised by the developerz.ai review on #87, #86 or
#88 (or by the sweep's own reviewers) after its PR's last fix round. Start the next sweep here.

## Terminal layer (`src/tmux/terminalProvider.ts`, reconcile queue)

All predate the sweep's PRs; each needs a second machine (or a slow remote) to act inside a
seconds-wide window between plan and drain.

| # | Finding | Window |
|---|---|---|
| 1 | An idle foreign client that resumes typing while its session is queued for an automatic hand-off keeps its owner tag, so the drain still evicts it with `-D`. Recheck the client's activity at drain time. | plan → drain |
| 2 | `provideTerminalProfile` serves a queued `-D` profile after checking only `openSlots`; if another machine took the session after it was queued, it is detached. Revalidate owner and activity before serving a queued profile, not only in the drain. | plan → profile request |
| 3 | When `list-sessions` answers but `list-clients` times out, ready pids stay eligible and the rescan can spend a second deadline. Back off failed pid probes across scans without counting a transport failure as a miss. | slow remote |
| 4 | A revived tab without launch arguments that reports its pid after 2 s is cached as "no pid" for good, so closing it leaves its session running. Keep listening for a late pid without making the plan wait. | VS Code pty-host revive only |
| 5 | Test gap: queue a slot, reconnect, close its tab, then assert a profile request during the kill skips it. | test |
| 6 | The close watch holds one SSH channel for the connection's life; on a host with `MaxSessions 1` it could starve the other tmux commands (the rig runs 64). | host config |
| 7 | A late close watch from a previous connection can re-mark a window that has already reconnected (no per-connection nonce). | roaming link |
| 8 | On tmux < 3.2, concurrent check-then-append of `terminal-overrides` can leave a duplicate identical `xterm*:Tc` entry (documented as harmless in `docs/idea/tmux-approach.md`). | concurrent first attaches |
| 9 | An `auto` hand-off takes over an unknown-owner session (a manual `tmux attach`) after 120 s without typing. Documented trade-off; consider requiring the owner's close marker. | product decision |

## Connection

| # | Finding |
|---|---|
| 10 | A ProxyJump hop still uses the destination's `PreferredAuthentications`. |
| 11 | The pasted clipboard image path is not quoted when the remote `$HOME` contains a space. |
| 12 | A clipboard upload that hits its 60 s deadline is abandoned, not cancelled (the 48 h sweep removes the file). |

## Maintenance

| # | Finding |
|---|---|
| 13 | `health.md` reads any body line starting `BREAKING CHANGE:` as a footer, so a fenced example can suggest a major bump (errs high; a member reviews every release ask). |
| 14 | Nothing automated decides the off-cycle release for a high/critical advisory: both briefs run on Monday only. |
| 15 | The `main` ruleset requires only `developerz.ai review`; `pr.required_checks: ["check"]` names a job the ruleset does not require. |
