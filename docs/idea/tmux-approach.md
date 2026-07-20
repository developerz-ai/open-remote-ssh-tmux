# The tmux approach

How **open-remote-ssh-tmux** delivers durable, re-attachable terminals. This is
the design direction, not a spec — `/planx` + exploration decide the details.

## Principle

Keep everything open-remote-ssh already does (SSH transport, server install,
host tree, config parsing — see the SRP map in [`CLAUDE.md`](../../CLAUDE.md)),
and keep the **UX identical to open-remote-ssh** — same connect flow, same
commands, same terminals. **Add exactly one thing under the hood: back the remote
terminals with tmux** so their lifetime is owned by the tmux server, not by the
VS Code window or the SSH link. The user never sees or types tmux.

```
VS Code (PC or laptop)  ──SSH──▶  VPS
                                   ├─ vscode-server           (can restart)
                                   └─ tmux server             (long-lived)
                                        └─ session "main"     ← Claude Code runs here
                                        └─ session "build"       survives everything
```

Because the tmux server is a separate process, sessions and the processes inside
them survive vscode-server restarts, window closes, disconnects, and are
re-attachable from **any** machine — that's the machine hand-off.

## Candidate mechanisms (to evaluate)

1. **tmux-backed terminal profile.** Register a `TerminalProfileProvider` (VS
   Code `contributes.terminal.profiles` + `window.registerTerminalProfileProvider`)
   that launches `tmux new-session -A -s <name>` (attach-or-create) instead of a
   bare shell. New integrated terminals are tmux clients; reconnecting re-attaches
   the same session. Likely the default terminal on a resolved host.
2. **Session manager UI.** A tree view (mirror the existing `sshHosts` view in
   `src/hostTreeView.ts`) listing tmux sessions on the connected host — run
   `tmux list-sessions` over the existing connection — with commands to
   attach / create / rename / kill, each opening a VS Code terminal on
   `tmux attach -t <name>`.
3. **Bootstrap.** Detect `tmux` on the remote (like `serverSetup` handles the
   vscode-server); if missing, guide install. Ship a sane default tmux config
   (mouse on, large history, sensible status) without clobbering the user's.

## Ownership: let tmux own persistence

VS Code has its own persistent-terminal reconnection. Layering it on top of tmux
double-persists. **Decide one owner — tmux** — and neutralise VS Code's for
tmux-backed terminals, so re-attach behaviour is predictable (one of the SOLID
"one reason to change" calls).

## Session lifecycle — no zombies

Persistence must not become a session graveyard (a stated hard requirement). The
strategy:

- **Deterministic naming, keyed to host + workspace.** A session name like
  `code-<workspaceHash>` (or per-terminal `code-<workspaceHash>-<n>`) means
  re-opening the same workspace **re-attaches the same session** instead of
  spawning a duplicate. `tmux new-session -A -s <name>` (attach-or-create) makes
  this idempotent — this is the core anti-zombie mechanism.
- **Stable client↔session mapping on restore.** VS Code restores its terminal
  tabs on reconnect; each restored terminal must map back to *its* session by a
  stable id (persist the mapping in workspace state), so N terminals re-attach to
  the right N sessions — not a fresh set.
- **Reap the truly dead.** A session whose processes have all exited should end,
  not linger: run panes with `remain-on-exit off` so the pane closes when its
  process exits and the empty session dies naturally. Never
  `destroy-unattached on` — that would kill on detach and defeat persistence.
- **Keep intentional long-lived sessions.** The Claude Code task session persists
  by design; only *empty/abandoned* sessions are candidates for cleanup.
- **Housekeeping on connect.** On resolving a host, optionally prune sessions that
  are empty or older than a threshold with no live processes; surface a count if
  it grows unusually. A manual "kill session" affordance stays available for the
  power case, but the default path must self-clean.

The invariant: **one live session per (host, workspace, terminal-slot); zero
sessions with no purpose.**

## Open questions for `/planx`

- **Naming / discovery** of sessions per host+workspace (one "main" per folder?
  user-named? a `vscode-<workspaceHash>` scheme?).
- **Resize / reflow.** tmux status bar, mouse mode, and tmux's own scrollback vs
  VS Code's — get the UX clean, not doubled.
- **Terminal profile vs. wrapper vs. shell-init** as the injection point — which
  is least invasive and most reliable across shells (bash/zsh/fish).
- **Claude Code specifically** — a first-class "attach to my long task" command,
  or just a well-known session name?
- **Windows remotes** — tmux is Unix-only; degrade gracefully (feature off, or
  document WSL).

## What this is NOT

- **Terminals only.** Editing, file changes, saving, extensions, and port
  forwarding already reconnect fine (the vscode-server persists) — we don't touch
  that path and must not regress it. The scope is the terminal lifetime.
- No transport change — SSH stays. (mosh was considered and dropped —
  [`decision-mosh-vs-tmux.md`](decision-mosh-vs-tmux.md).)
- No custom protocol, no new native binary we author. tmux is the (battle-tested)
  dependency; we integrate it.
