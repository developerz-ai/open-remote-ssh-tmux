# 09 — Full verification and release

> Part of [`overview.md`](overview.md). Depends on: 01-08.

## Files to change
- `test/rig/edh/` (new) — commit the EDH driver the v1 run used ad hoc (Xvfb + VSCodium +
  xdotool/scrot + the slice-01 containers; description in
  `docs/plans/2026/07/24/101-v1-tmux-release/results-2026-07-24.md:3-22`). One script per matrix
  row where automatable; rows needing eyes produce a screenshot + the output-channel log.
- `docs/plans/2026/11/13/101-bulletproof-hardening-sweep/results-<YYYY-MM-DD>.md` (new) — results.
- `CHANGELOG.md`, `package.json` version — release prep (commit/tag only when the owner asks).

## Steps
1. Gates, in order, all green: `npm run compile:src`, `npm run lint`, `npm test`,
   `npm run test:coverage`, `npm run test:tmux` (all versions), `npm run bundle`,
   `npm run package` (Node 22).
2. Re-run the v1 matrix (definition:
   `docs/plans/2026/07/24/101-v1-tmux-release/09-verify.md`) on the new build, every row, no
   manual tmux commands allowed.
3. New rows (append to the matrix):

| Row | Scenario | Pass condition |
|---|---|---|
| 22 | A adopts from B; B reconnects | A's terminal stays attached; B offered take-over (per setting) |
| 23 | A's network cut (no clean close); B opens workspace | B gets the sessions after the staleness threshold, no manual detach |
| 24 | Remote exec hangs (SIGSTOP) during probe / new terminal / reconcile | Connect completes; terminal opens plain shell within deadline; no tmux text in UI |
| 25 | `historyLimit` = 1.5, -1, 1e10 | Terminals open; value clamped |
| 26 | User `~/.tmux.conf` with custom history-limit, PPage binding, set-clipboard | Server state unchanged after attach except documented list |
| 27 | Folder path with `#(…)`, `#S`, `;`, quotes, unicode | Correct cwd; nothing executed |
| 28 | `remote.SSH.tmux.enabled` toggled off then on, no reload | Cleanup offer; no unseen sessions; tmux terminals return |
| 29 | Same folder via alias vs IP vs trailing slash; upgrade from 1.2.0 with live sessions | Same sessions; legacy sessions adopted once |
| 30 | Reconnect storm inside revive window | tabs == sessions, no duplicate slots |
| 31 | Orphan older than `orphanMaxAgeDays` | Aged out; housekeeping line logged |
| 32 | Listener audit during a session | Only `127.0.0.1` listeners |
| 33 | Lowest supported tmux and latest tmux | Rows 1-12 pass on both |
| 34 | Login shells bash / zsh / fish / dash / tcsh | Terminal opens; sweep + reaper commands succeed |
| 35 | Ctrl-B / Esc / truecolor inside Claude Code and vim | Single keypress; no visible delay; colours correct |
| 36 | Host with logind `KillUserProcesses=yes` | Warning shown once; documented |

4. Row 13 (Windows remote): run against a real Windows OpenSSH target if one is available;
   otherwise keep documented, with the platform gate unit-tested. Row 18 (Claude Code redraw):
   covered by 35 + reattach; mark PASS or document precisely what differs.
5. Base-experience regression pass (must match stock open-remote-ssh): connect via config host,
   ProxyJump, password + key auth, host-key prompt first connect, file edit/save, extension
   install on remote, port forward, reconnect after link drop, SSH Targets tree, recent folders.
6. Field replay: install the built vsix locally, connect to the real dev box for a normal work
   session, then re-run the log sweep (same greps as overview "Field evidence") — expect zero
   Error-level lines on healthy connects and no unexplained prunes.
7. Write results; update `status.yml` (percent, evidence = PR numbers + CI run links).

## Tests (write first — TDD)
- None new in this slice; it executes the suites built in 01-08. Any failure found here gets a
  failing unit/rig test in the owning slice's test file before the fix.
Commands: step 1 list.

## Verify
- Results file lists every row with PASS/FAIL/DOCUMENTED and its evidence (log excerpt, rig test
  name, or screenshot path).
- Zombie check at the end of the run: `tmux ls` on each rig container shows only sessions the
  matrix expects to be alive.

## Done when
- Rows 1-12, 14-17, 19-36 PASS with no manual intervention; 13 and 18 PASS or documented with a
  concrete reason.
- All overview "Done when" items hold; `status.yml` is `complete` with evidence.
