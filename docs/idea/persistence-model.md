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

**Shipped.** This is implemented, not aspirational: `src/tmux/terminalProvider.ts`
backs every integrated terminal with `tmux new-session -A -s <name>`
(`src/tmux/tmuxSession.ts`), `src/tmux/tmuxBootstrap.ts` probes for tmux ≥2.6 and
degrades gracefully if it's missing or the remote is Windows, and
`src/tmux/sessionReaper.ts` cleans up empty corpses on connect. See the
end-to-end matrix in
[`09-verify.md`](../plans/2026/07/24/101-v1-tmux-release/09-verify.md) for the
concrete pass/fail acceptance criteria this claim is checked against.

## Multi-client rules

Machine hand-off means more than one client can reach the same (host, workspace)
— the PC and the laptop, potentially at once. Three rules keep that predictable,
implemented in `TmuxTerminalProvider` (`src/tmux/terminalProvider.ts`):

- **No-steal.** Opening a *new* terminal never `-A`-attaches into a session
  another client currently holds attached. Each client tracks which slots are
  attached remotely (`list-sessions` → `#{session_attached}`) and allocates the
  lowest slot that is free both locally and on the remote. Two clients open at
  once each get their own session; neither silently mirrors the other's screen.
- **Per-client slot mapping.** The `slot → session name` mapping is stored in
  `vscode.Memento` — **client-local** workspace state, not shared. Each machine
  remembers *its own* terminals; the PC's tab layout and the laptop's tab layout
  can differ even though both point at sessions in the same tmux server.
- **Adoption on reconnect.** On reload/reconnect, a client first re-attaches its
  own mapped survivors, then *adopts* any detached-but-live orphan session of
  the same workspace that no client currently holds — the hand-off path (PC
  closes → laptop opens the workspace → picks up the orphaned session as a new
  tab). An orphan is only adopted, never stolen while another client still has
  it attached.

## What tmux does NOT fix (accepted)

- **Seamless roaming.** A network change still drops the SSH link; you reconnect
  (fast) and re-attach. The session never dies, but reconnection isn't invisible.
  That's the piece mosh would have solved — deliberately out of scope
  ([`decision-mosh-vs-tmux.md`](decision-mosh-vs-tmux.md)).
- **The VS Code protocol channel** (extension host, port forwards) still rides
  SSH and reconnects the normal way. tmux is about *terminals*, not the whole
  remote protocol — and terminals are the stated problem.

## Acceptance north star

The vision is met when:

- a long remote task (e.g. Claude Code) started in a tmux session **runs to
  completion** regardless of client connection state;
- **closing on the PC and opening on the laptop** re-attaches to the same live
  terminals — scrollback + processes intact;
- a **dropped connection** loses nothing — reconnect, re-attach, keep going;
- and every remaining gap (roaming) is **documented, not hidden**.

Every mechanism these criteria depend on is implemented (see "Shipped" above).
What's still open is the *empirical* check, not the code: the concrete
pass/fail steps for exactly these scenarios — on a real Unix remote, via the
Extension Development Host — live in
[`09-verify.md`](../plans/2026/07/24/101-v1-tmux-release/09-verify.md). Until
that matrix is run and green, treat this north star as implemented-but-unproven,
not shipped.
