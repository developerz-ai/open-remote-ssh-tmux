# Why I'm building this

## The setup

I develop across three machines and one dev environment:

- a **PC** at my desk,
- a **laptop** I take with me,
- a **VPS** that is the actual remote dev environment.

The PC and the laptop are just windows onto the VPS. The VPS is where the code
lives, where the terminals run, where the long jobs run. I want the machine in
front of me to be interchangeable — a viewport, not the source of truth.

## What breaks today with open-remote-ssh

**Switching machines loses my terminals.** I'm working on the PC with VS Code
connected to the VPS. I want to close the PC, walk away, open the laptop, and
land back in the *same* terminals — same scrollback, same running processes.
Today those terminals are tied to the client/session; leaving takes them down.

**Long-running work is the real casualty.** Right now I run **Claude Code** on
the remote and hand it a long task. I do *not* want to lose it — I want it to
**keep running until it finishes**, independent of whether my client is
connected or which machine I'm on. With open-remote-ssh, closing or dropping the
session can take the work down with it.

**Losing the network interrupts me.** Laptop in a car, connection drops, IP
changes when it comes back. The work shouldn't die — I just want to reconnect
and still be there.

## Scope: terminals only

The **only** problem is the terminals (and the processes running in them, like
Claude Code). Everything else about open-remote-ssh is fine — editing, file
changes, saving, extensions, port forwarding all reconnect correctly because the
vscode-server persists. So this fork touches **terminals only**; it does not
change the editing/file/protocol path, and must not regress it.

## What I want instead

> The remote **terminals** are durable. The client is disposable.
> It should **feel exactly like open-remote-ssh** — same UX, better underneath.

1. **Invisible.** Same connect flow, commands, and terminals as open-remote-ssh
   today. Under the hood it's tmux-backed and more resilient, but I don't manage
   it and never type a tmux command — I just open terminals and work.
2. **Terminals persist on the VPS**, decoupled from any VS Code window or SSH
   connection.
3. **Reboot-and-resume.** I close (or reboot) the PC, later start VS Code on the
   laptop, and my terminals + the long task are **still running** and re-attach
   automatically.
4. **Long tasks keep running.** A long Claude Code (or build, or migration) job
   runs to completion regardless of the client's connection state.
5. **No zombies.** It must not leave a graveyard of orphaned sessions behind —
   re-opening the same workspace re-attaches the *same* session, and truly dead
   ones get cleaned up. (See [`tmux-approach.md`](tmux-approach.md).)

## Why tmux (and not mosh)

The problem I actually have is **session persistence and hand-off between
machines** — not transport. That's exactly what a terminal multiplexer solves:

- **tmux runs a persistent server on the VPS.** Terminals, panes, and the
  processes inside them survive client disconnects, VS Code closing, and the
  vscode-server itself restarting.
- **Any client can attach.** `tmux attach` from the PC's VS Code terminal, the
  laptop, or a phone — that's the machine hand-off, which is the thing I care
  about most.
- **A dropped network** doesn't kill the session; I reconnect and re-attach.

I considered **mosh** (resilient UDP transport that roams across IP changes).
But mosh is the wrong layer for my problem: it makes a *live connection*
seamless, yet it **cannot do machine hand-off** (one client per server, no
detach/re-attach) and doesn't persist a session for a *different* machine to
pick up — which is the whole point. See
[`decision-mosh-vs-tmux.md`](decision-mosh-vs-tmux.md) for the full comparison.

So this fork keeps open-remote-ssh's SSH transport and adds **tmux-backed
persistent terminals**. See [`tmux-approach.md`](tmux-approach.md) for how.
