# EDH driver — real VSCodium against the real-tmux rig

The acceptance matrix (`docs/plans/2026/07/24/101-v1-tmux-release/09-verify.md`, extended by
`docs/plans/2026/11/13/101-bulletproof-hardening-sweep/09-verify.md`) run by script instead of
by hand. A real VSCodium with the `.vsix` under test, on its own Xvfb inside docker, connects
over real SSH to a rig container (`../Dockerfile`, tmux built from the pinned release), and
xdotool drives it through keybindings. Every assertion reads the **remote** — `tmux ls`,
`list-clients`, the children of the VS Code pty host, files — not pixels.

```bash
test/rig/edh/run.sh <extension.vsix> [row …]
test/rig/edh/run.sh ./open-remote-ssh-tmux-1.3.0.vsix                  # every row
test/rig/edh/run.sh ./x.vsix 06-exit-closes 07-churn 08-reopen-3x 09-revive-no-dup   # zombie rows
EDH_TMUX=2.6 EDH_OUT=/tmp/edh test/rig/edh/run.sh ./x.vsix 01-connect 09-revive-no-dup
```

Needs docker only — nothing is installed on the host and the host display is never used.
The first run builds three images (rig tmux, `orst-edh-remote`, `orst-edh-client`; a few
minutes, then cached). Output: `EDH_OUT` (default a fresh `mktemp -d`) holds `results.tsv`
(row, PASS/FAIL/NOT-AUTOMATED, duration, dir) and per row a `transcript.txt`, the
`… .remote-ssh.log` ("Remote - SSH" output channel), screenshots (`*.png`) and
`remote-state.txt`. Exit status 0 only when every selected row passed.

## What runs where

| Piece | What it is |
|---|---|
| `remote.Dockerfile` | `orst-tmux-rig:<EDH_TMUX>` (default 3.4) + user `wedh` with the VSCodium REH pre-installed at `~/.vscodium-server/bin/<commit>` (no download at connect; the rig has no wget/curl) |
| `client.Dockerfile` | Debian + pinned VSCodium (`run.sh`: version + sha256) + Xvfb + xdotool + ImageMagick + `ss`; user `pc` |
| `client/entrypoint.sh` | key + `~/.ssh/config` + pinned host key (`ssh-keyscan`), `argv.json` `enable-proposed-api` (as README "Activation"), Xvfb `:99 -nolisten tcp`, installs the mounted `.vsix` |
| `client/settings.json` | quiet start-up, no confirmations, `remote.SSH.remotePlatform`, driver commands in `commandsToSkipShell`, and `-workbench.action.toggleSidebarVisibility` so Ctrl+B reaches the terminal (stock VS Code eats it — upstream behaviour, not this extension) |
| `client/keybindings.json` | Ctrl+Alt+Shift+F1 new terminal, F2 reload window, F3 close window, F4 kill terminal, F5 focus terminal, F6 Remote-SSH: Connect to Host..., F7 Remote Explorer |
| `lib.sh` | remote probes, client control, `wait_until`/`wait_stable`/`expect` |
| `rows/*.sh` | one per row; `# edh: machines=2` in the header starts the second client ("laptop") |

Containers are `orst-edh-{remote,pc,laptop}-<pid>` on a private network `orst-edh-net-<pid>`;
no port is published. The ed25519 key is generated per run in a temp dir and deleted on exit,
and the containers and network are removed on exit whatever happens. Every docker call is
under `timeout`; nothing attaches a TTY.

Between rows: VSCodium is killed and its user-data and log dirs wiped; on the remote every
`wedh` process (vscode-server, pty host, tmux server, sshd sessions) is killed and per-row
files removed. Rows that kill a machine (`23`) get a fresh one from the next row's
`ensure_client`.

## Rows

| Script | Matrix row | Pass condition checked on the remote |
|---|---|---|
| `01-connect` | 1 (+10 screenshot) | one `code-*` session, one client, pty host runs tmux and no plain shell |
| `01b-first-terminal-race` | 1 (strict) | New Terminal pressed the moment the window logs "wired" on a first connect is already tmux, and the default-profile write had landed by then (`connect` waits for "wired" and nothing else) |
| `02-reload-reattach` | 2 (reload) | after Reload Window: same session name + creation time, `sleep` alive, marker in scrollback, 1 tmux / 0 plain |
| `03-close-reopen` | 2 (close) | closing marks the session closed (`@orst_closed`, set by the remote when the window's connection drops); reopen: same session, process + marker, no duplicate, marker withdrawn |
| `06-exit-closes` | 6 | `exit` → session gone, no pty left |
| `07-churn` | 7 | 5× open/Kill Terminal: session killed each time, slot 0 reused; 3 open − 1 = 2 sessions = 2 tmux ptys |
| `08-reopen-3x` | 8 | close + reopen 3×: same single session, one client, no plain shell |
| `09-revive-no-dup` | 9 | reload with 2 terminals: same 2 sessions, one client each, 2 tmux / 0 plain ptys |
| `22-handoff-clean` | 22 | laptop closes cleanly → PC takes over at once (`-> handoff-takeover` or `-> adopt`, never `-> offer`), one session, no `new slot` → laptop reopens: PC's client pid unchanged, laptop logs `-> offer` (notification: screenshot) |
| `23-handoff-cut` | 23 | PC cut off the network then killed; after the PC client idles > 120 s the laptop takes over (`-> handoff-takeover`), sole client, process + scrollback intact |
| `24-exec-hang` | 24 | tmux server SIGSTOPped: new terminal is a plain shell within 13 s (one 8 s deadline + overhead) + info log line; reload completes while hung, and New Terminal after it is plain within 13 s too; SIGCONT → session intact |
| `28-toggle-enabled` | 28 | setting `off` live → next terminal plain, existing tmux terminal stays; `auto` → tmux again (cleanup offer: screenshot) |
| `30-reconnect-storm` | 30 | remote `sshd: wedh` killed 3× in ~10 s → same 2 sessions, one client each, 2 tmux / 0 plain ptys |
| `32-listener-audit` | 32 | `ss -ltnp`/`-lunp` in the client: every VSCodium-owned listener is loopback |
| `35-keys-esc` | 35 | Ctrl-B → `0x02`, Esc → `0x1b`, each exactly once; worst Esc latency ≤ worst baseline + 100 ms (truecolor: screenshot) |
| `40-open-in-window` | 40 | not the remote — the client's windows (`xdotool`, title set to carry `${remoteName}`): Connect to Host from an empty local window connects that window (1 window, remote); from a local-folder window it opens a second, remote one and keeps the local one; in SSH Targets the twistie only expands and a host-label click connects (new window from a remote one). Screenshots: the quick pick, the view (connected mark, tooltip, inline buttons) |

"Tabs" are counted as the children of the remote VS Code pty host: one process per terminal
VS Code keeps, `tmux: client` for ours and the login shell for a plain one. Both machines
share one vscode-server (same user, same commit), so the two-machine rows identify a
machine's terminal by its tmux client pid instead.

Row 24 freezes the tmux **server**, not the sshd session: stopping sshd freezes VS Code's own
server channel too, so no terminal of any kind could open; the sshd-SIGSTOP variant is the
rig itest `deadlines.itest.ts` instead.

Rows covered by the rig integration suite (`npm run test:tmux`) are not re-scripted here:
25 → `hardening.itest.ts` (04a historyLimit); 26 → `hardening.itest.ts` (baseline, 04b, 04c);
27 → `hardening.itest.ts` (04f) + `attachOrCreate.itest.ts` (cwd); 29 →
`lifecycle.itest.ts` (05 c legacy adoption) + unit tests for identity canonicalisation;
31 → `reaper.itest.ts` (orphan aging); 33 → every itest on 2.6…3.8, and these rows with
`EDH_TMUX=2.6` / `3.8`; 34 → `probe.itest.ts` / `listParse.itest.ts` (every login shell).

## Not automated

- **Notifications** (row 22 offer, row 28 cleanup offer) and **row 10** tab titles / no tmux
  text: screenshots only — read the PNGs.
- **Truecolor** (row 35): `truecolor.png`.
- **Row 13** (Windows remote), **row 36** (logind `KillUserProcesses=yes`): need a real host.
- Base-experience regressions (ProxyJump, password auth, port forward, …): manual.
