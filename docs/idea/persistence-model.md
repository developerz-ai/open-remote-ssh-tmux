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

## What tmux does NOT fix (accepted)

- **Seamless roaming.** A network change still drops the SSH link; you reconnect
  (fast) and re-attach. The session never dies, but reconnection isn't invisible.
  That's the piece mosh would have solved — deliberately out of scope
  ([`decision-mosh-vs-tmux.md`](decision-mosh-vs-tmux.md)).
- **The VS Code protocol channel** (extension host, port forwards) still rides
  SSH and reconnects the normal way. tmux is about *terminals*, not the whole
  remote protocol — and terminals are the stated problem.

## Acceptance north star

Done for the vision when:

- a long remote task (e.g. Claude Code) started in a tmux session **runs to
  completion** regardless of client connection state;
- **closing on the PC and opening on the laptop** re-attaches to the same live
  terminals — scrollback + processes intact;
- a **dropped connection** loses nothing — reconnect, re-attach, keep going;
- and every remaining gap (roaming) is **documented, not hidden**.
