# 09 — End-to-end verification matrix

> Part of [`overview.md`](overview.md). Depends on: all prior. Run against the
> release candidate (installed vsix preferred, F5 EDH acceptable).

Maps 1:1 to the acceptance north star in `docs/idea/persistence-model.md:59-67`
and the invariants in `CLAUDE.md`.

## Environment
- Unix remote (Linux VPS) with tmux ≥ 2.6; second Unix remote **without**
  tmux; a Windows remote (or `remote.SSH.remotePlatform` forced to windows).
- Two client machines if available ("PC" + "laptop"); else two VSCodium
  profiles/windows simulate hand-off.

## Matrix
| # | Scenario | Pass criteria |
|---|----------|---------------|
| 1 | Fresh connect, open terminal | Shell prompt; `tmux ls` on remote: exactly one `code-*` session |
| 2 | Long task survives window close | `sleep 999 &` + marker echo → close window → reopen → same scrollback, process alive |
| 3 | Machine hand-off | Start task on client A → close A → open same workspace on client B → same terminal, task alive |
| 4 | vscode-server restart | Kill server process on remote → reconnect → terminals re-attach |
| 5 | Dropped connection | Kill SSH (network off / kill ssh channel) → reconnect → nothing lost |
| 6 | No zombies: close terminal | Exit shell → session disappears from `tmux ls` |
| 7 | No zombies: churn | Open/close 5 terminals repeatedly → `tmux ls` count == open terminals |
| 8 | No zombies: reopen workspace | Close + reopen workspace 3× → no session-count growth |
| 9 | No duplicates on revive | Window reload with 2 terminals → still 2 terminals, 2 sessions (no plain-shell doubles from VS Code revive) |
| 10 | Invisible UX | No "tmux" in terminal tab names, settings descriptions visible by default, notifications, status bar; no tmux status line in terminal |
| 11 | User's own tmux untouched | Remote `~/.tmux.conf` with a distinctive option → our sessions don't clobber it; user's manual `tmux` sessions (`main` etc.) never reaped |
| 12 | Unix, no tmux | Connect works, stock terminals, one log line, no popups |
| 13 | Windows remote | Connect + terminals identical to upstream; no probe errors in log |
| 14 | Feature off | `remote.SSH.tmux.enabled: "off"` → pure upstream behaviour on tmux-capable host |
| 15 | Kill command | `Kill Persistent Terminal Sessions` → confirm → workspace sessions gone; cancel → nothing |
| 16 | Hostile workspace path | Workspace dir containing `'` and space → terminals work, no injection (also covered by 02 unit tests) |
| 17 | Editing path unregressed | File edit/save, extension install, port forward — unchanged during all above |
| 18 | Claude Code scenario | Start `claude` in terminal on client A, close A mid-task, reopen on B → session live, TUI redraws |
| 19 | Concurrent clients — no stealing | PC attached with 2 terminals; laptop opens same workspace + new terminal → laptop gets a *fresh* session (slot 2), PC's terminals undisturbed; `tmux ls`: 3 sessions |
| 20 | Reconciliation after both close | Continue 19: close laptop, close PC, reopen PC → PC shows its 2 old terminals **plus** the laptop's adopted one; `tmux ls`: still 3, no duplicates |
| 21 | Hand-off = adoption | PC with 1 terminal closes; laptop opens workspace → PC's detached session appears as a terminal on the laptop (scrollback intact) |

## Steps
1. `bin/check` green at RC commit.
2. Run matrix top to bottom; record each result (pass/fail + note) in a
   `results-<date>.md` next to this file.
3. Any fail → fix in the owning slice, re-run the failed rows + 6-9
   (zombie rows re-run always — cheapest regression to introduce).

## Done when
- All 21 rows pass on the RC build; results file committed; then 08's release
  steps cut the tag.
