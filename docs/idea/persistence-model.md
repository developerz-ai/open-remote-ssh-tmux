# Persistence model — the honest technical picture

The vision ([`why.md`](why.md)) is "don't lose my terminals." This doc separates
what that means precisely, what already survives today, what doesn't, and how
tmux fixes it. Read it before promising persistence in a feature.

## The three layers

A VS Code remote terminal is really three stacked lifetimes:

| Layer | Where it lives | What ends it |
|-------|----------------|--------------|
| **Client** (VS Code window) | your PC/laptop | closing the window, quitting the app, switching machines |
| **Transport** (SSH) | client ↔ VPS link | TCP break: IP change, sleep, dropout |
| **Terminal + its processes** (shell, your Claude Code task) | the VPS | whatever owns the terminal's lifetime dies |

"Losing my terminals" is the top layer's death cascading down. The goal is to
**move the terminal's lifetime to a process that no client owns** — that's tmux.

## What survives today (and what doesn't)

- The **vscode-server** on the VPS is long-running and can outlive a single
  window, and VS Code has persistent terminal sessions that re-attach *if the
  server stays up and you reconnect to the same server*.
- But: terminals are still tied to the vscode-server's lifetime. **If the server
  restarts, the terminal's processes die.** Machine hand-off is unreliable, and a
  long task has no guarantee of surviving a disconnect or window close.

So the problem isn't "terminals are never persistent" — it's that their lifetime
is **coupled to the vscode-server / client**, so hand-off and long-task survival
aren't dependable.

## How tmux fixes it

tmux introduces a **fourth process that no client owns** — the tmux server —
and moves the terminal's lifetime into it:

- terminals/panes and their processes live in the **tmux server**, a long-lived
  process independent of the vscode-server and the SSH link;
- **any client attaches** (`tmux attach`) — the PC's VS Code terminal, the
  laptop, a phone — giving true machine hand-off;
- vscode-server restart, window close, or a dropped connection no longer kill the
  work; you re-attach and it's all there.

This decouples the "Terminal + processes" layer from the top two. The client and
transport become genuinely disposable.

**Status (2026-11-14): shipped and tested against real tmux.**
`src/tmux/terminalProvider.ts` backs every "Persistent Shell" terminal with
`tmux new-session -A -s <name>` (`src/tmux/tmuxSession.ts`),
`src/tmux/tmuxBootstrap.ts` probes for tmux ≥ 2.6 and degrades to plain shells if
it is missing, too old, unreachable, or the remote is Windows, and
`src/tmux/sessionReaper.ts` does connect-time housekeeping. The remote side is
proven on every supported tmux version by the docker rig (`npm run test:tmux`);
VS Code's side by the F5 acceptance matrix
([`09-verify.md`](../plans/2026/07/24/101-v1-tmux-release/09-verify.md), re-run in
[`101-bulletproof-hardening-sweep/09-verify.md`](../plans/2026/11/13/101-bulletproof-hardening-sweep/09-verify.md)).

### Who owns what

- **tmux owns the process.** The shell and everything in it run in the tmux
  server; nothing VS Code does to a window ends them.
- **VS Code owns the tab.** The terminals are not `isTransient`: VS Code persists
  and revives the tabs and their split layout, and each revive is answered by the
  profile provider with the *same* session. Closing a tab kills its session (as in
  stock open-remote-ssh); closing or reloading the window leaves it running.

## Multi-client rules (machine hand-off)

Machine hand-off means more than one machine can reach the same (host,
workspace) — the PC and the laptop, possibly at once. The rules, decided in one
pure function (`decideSlotAction`, `src/tmux/slotState.ts`) and carried out by
`TmuxTerminalProvider`:

- **Ownership is read from the remote.** Each window marks the terminals it opens
  with an id derived from a hash of its machine id plus a per-window nonce
  (`src/tmux/clientIdentity.ts`); it is never the raw machine id. The tag lives in
  the tmux session, so every machine sees the same answer. The slot mapping each
  window keeps in `workspaceState` is client-local and only says "this machine
  once had it".
- **A closed window is noticed by the remote, not by the window.** VS Code kills
  the extension host milliseconds after a window closes, so nothing sent from the
  window at close arrives, and its tmux clients live on in VS Code's pty host for
  the reconnection grace (up to 3 hours). Instead, each connection carries a
  remote "close watch" (`buildCloseWatchCommand` in `tmuxSession.ts`, started by
  `createCloseWatch` in `remoteExec.ts`): when the SSH connection ends, it marks
  that window's sessions `@orst_closed = <clientId>:<epoch>`. Nothing is detached.
  A window that reconnects (reload, network blip) withdraws its markers on its
  next reconcile.
- **Abandoned = marked closed with no typing since, or 2 minutes of no typing.**
  Another machine treats a held session as abandoned when its close marker names
  the current owner and nobody has typed in it since the close — so a closed
  window's terminals move at once — or, without a marker (laptop asleep before
  the remote noticed, VS Code killed), once there has been no keyboard input for
  2 minutes. With `remote.SSH.tmux.handOff: auto` an abandoned session is taken
  over without asking.
- **Live terminals are never taken without a click.** If the other machine is in
  active use, one notification offers them: "This workspace's terminals are open
  on another machine." [Take over] [Not now]. Taking over closes the other
  window's tabs; nothing running stops. `handOff: ask` always offers (never moves
  without a click); `handOff: never` leaves them alone.
- **No ping-pong.** A window whose terminal was taken over forgets it instead of
  re-attaching, and when that machine reconnects the terminal is judged like any
  other machine's: offered while the new holder is in use, moved silently only if
  that holder has been idle for 2 minutes (under `auto`).
- **No mirroring.** Opening a new terminal never attaches a session another
  client holds. A new slot is claimed on the remote first (`new-session -d`, which
  tmux refuses for a name that exists), so two machines opening a terminal at the
  same moment get two sessions.

**Trade-off, stated plainly.** Idleness is measured on keyboard input, not output
(`#{client_activity}` moves on keystrokes only — verified on every rig version).
A window someone is only *watching* — a long Claude Code run, no typing for 2
minutes — counts as idle, so under `auto` another machine opening the workspace
moves the terminals without asking. Nothing running stops, but the watching
window's tabs close. Likewise, a network drop ends the connection exactly like a
close does: until the window reconnects and withdraws its marker, another machine
opening the workspace takes the terminals at once. Users who want a click every
time set `handOff: ask`.

## Session lifecycle

- **Identity.** `code-<sha1_12(host + " " + path)>-<slot>`, where host is the
  resolved `user@hostname:port` (lower-cased) and path has repeated `/` collapsed
  and the trailing `/` removed. Sessions named under the older alias-based identity
  are renamed once, process kept. Not resolved: symlinks, and an IP address vs. a
  DNS name for the same machine.
- **Housekeeping on connect** (`remote.SSH.tmux.reapOnConnect`): sessions of ours
  whose pane is dead, and detached sessions of ours idle (`#{session_activity}`)
  longer than `remote.SSH.tmux.orphanMaxAgeDays` (default 14, `0` = never), are
  killed. Attached sessions, sessions not named like ours, and this window's own
  mapped sessions are never touched. It runs whenever tmux is available, even with
  `remote.SSH.tmux.enabled: off`, so sessions from before a switch-off do not run
  forever. Log: `tmux housekeeping: K killed, O old sessions kept`.
- **Settings apply live.** Turning `enabled` off unwires the layer and offers
  "N background terminals from this workspace are still running." [Close them]
  [Keep]; turning it back on rewires. `historyLimit`, `handOff` and
  `setDefaultProfile` take effect without a reload; `reapOnConnect` and
  `orphanMaxAgeDays` at the next connect.

## What tmux does NOT fix (accepted)

- **Seamless roaming.** A network change still drops the SSH link; you reconnect
  (fast) and re-attach. The session never dies, but reconnection isn't invisible.
  That's the piece mosh would have solved — deliberately out of scope
  ([`decision-mosh-vs-tmux.md`](decision-mosh-vs-tmux.md)).
- **The VS Code protocol channel** (extension host, port forwards) still rides
  SSH and reconnects the normal way. tmux is about *terminals*, not the whole
  remote protocol — and terminals are the stated problem.
- **A remote reboot.** All sessions are gone; tmux has no resurrection, and this
  fork adds none.
- **Hosts that end user processes at logout.** With systemd-logind
  `KillUserProcesses=yes`, the tmux server started from the SSH login is killed
  with that login, so every terminal dies on disconnect. `Linger` alone does not
  help. The extension detects it and warns once per host; the fix is on the host
  ([`troubleshooting.md`](../troubleshooting.md#terminals-closed-after-disconnect)).
- **Shell integration.** The program VS Code launches is tmux, so VS Code's shell
  integration (command decorations, cwd tracking) is not available in these
  terminals.
- **`SSH_AUTH_SOCK` in a surviving shell.** A shell that outlives a reconnect keeps
  the old agent socket; new terminals get the current one.

## Acceptance north star

The vision is met when:

- a long remote task (e.g. Claude Code) started in a tmux session **runs to
  completion** regardless of client connection state;
- **closing on the PC and opening on the laptop** re-attaches to the same live
  terminals — scrollback + processes intact;
- a **dropped connection** loses nothing — reconnect, re-attach, keep going;
- and every remaining gap (roaming) is **documented, not hidden**.

The first three were observed end to end in the v1.0.0 F5 run and hold on real
tmux in the rig. The hand-off rules above (owner tag, 2-minute idleness, the offer)
were rebuilt afterwards and are proven on the rig; their F5 re-run is the hardening
sweep's [`09-verify.md`](../plans/2026/11/13/101-bulletproof-hardening-sweep/09-verify.md)
— read its results before claiming them in VS Code. The remaining gaps are listed
above and in the README's "Known limitations".
