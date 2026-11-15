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

## Candidate mechanisms (evaluated)

1. **tmux-backed terminal profile — shipped.** A `TerminalProfileProvider` (VS
   Code `contributes.terminal.profiles` + `window.registerTerminalProfileProvider`)
   launches `tmux new-session -A -s <name>` (attach-or-create) instead of a bare
   shell. New integrated terminals are tmux clients; reconnecting re-attaches
   the same session. It is the default terminal on a resolved Unix host.
   Implemented in `src/tmux/terminalProvider.ts` + `src/tmux/tmuxSession.ts`.
2. **Session manager UI — deferred.** A tree view (mirror the existing
   `sshHosts` view in `src/hostTreeView.ts`) listing tmux sessions on the
   connected host — run `tmux list-sessions` over the existing connection —
   with commands to attach / create / rename / kill, each opening a VS Code
   terminal on `tmux attach -t <name>`. Not needed for the terminals-only
   scope of this release (attach-or-create + reap already give "no zombies"
   without a UI); see [`roadmap.md`](roadmap.md).
3. **Bootstrap — shipped.** Detect `tmux` on the remote (like `serverSetup`
   handles the vscode-server); degrade (feature off, logged) if missing or too
   old. Per-session config (`set-option`, not `~/.tmux.conf`) applies scrollback
   and hides the status bar without touching the user's own config. Implemented
   in `src/tmux/tmuxBootstrap.ts` (probe) + the per-session options in
   `buildAttachOrCreate` (`src/tmux/tmuxSession.ts`).

## Spike decision: terminal profile provider spawns on the remote (2026-07-24)

`package.json` sets `extensionKind: ["ui"]` (`:436`) — the extension itself
(and any `window.registerTerminalProfileProvider` callback it registers) runs
in VS Code's **local** extension host even when the window is connected to a
remote SSH host. Slice `04-terminal-profile.md` flagged this as the plan's
biggest assumption: if `shellPath`/`shellArgs` returned by a locally-running
provider caused the shell to spawn on the *local* machine, Route A (the
profile-provider route) would be dead on arrival and we'd need Route B
(inject `terminal.integrated.defaultProfile.linux` / `profiles.linux` into
remote Machine settings instead).

**Decision: Route A — `TerminalProfileProvider` / `contributes.terminal.profiles`.**
The provider spawns its process on the **remote**, regardless of the calling
extension's `extensionKind`.

**Method.** The step-0 plan called for an EDH click-test (register a throwaway
provider returning `tmux new-session -A -s spike`, open a real remote window,
confirm the process on the remote host). This execution environment has no
VS Code desktop/Electron binary and no display, so that literal click-test
isn't runnable here — see "residual risk" below for what still closes the
loop. Instead the mechanism was traced directly in current `microsoft/vscode`
source, which settles the *architectural* question with equal confidence:

- `vscode.window.createTerminal()` (and thus a profile provider's returned
  `TerminalOptions`) is handled on the main-thread side by
  `MainThreadTerminalService.$createTerminal`
  ([`src/vs/workbench/api/browser/mainThreadTerminalService.ts:139-172`](https://github.com/microsoft/vscode/blob/main/src/vs/workbench/api/browser/mainThreadTerminalService.ts#L139-L172)).
  The `IShellLaunchConfig` it builds from the extension's `shellPath`/`shellArgs`
  carries **no per-call remote/authority field** — it's just
  `executable`/`args`/`cwd`/`env`. It's handed to the single window-wide
  `_terminalService.createTerminal(...)`, the same singleton every extension
  host (local UI or remote workspace) talks to via its own RPC proxy.
- `TerminalService.createTerminal()`
  ([`src/vs/workbench/contrib/terminal/browser/terminalService.ts:975`](https://github.com/microsoft/vscode/blob/main/src/vs/workbench/contrib/terminal/browser/terminalService.ts))
  resolves the pty backend via
  `this._terminalInstanceService.getBackend(this._environmentService.remoteAuthority)`
  (`:279`, `:453-457`) — `remoteAuthority` here is the **window's** resolved
  remote authority (set once for the whole workbench when it connects to our
  `ssh-remote` authority), not anything derived from which extension host
  issued the call.

So process placement is a property of **the window's connection**, not of the
calling extension's `extensionKind`. A `ui`-kind extension's provider code
*runs* locally, but the `shellPath`/`shellArgs` it *returns* are just data —
the actual `tmux new-session -A -s <name>` process is spawned by the remote
pty host, on the remote machine, exactly like a bare default shell profile
would be. This lines up with why `open-remote-ssh` upstream (and every other
Remote-SSH terminal profile) already works this way without needing
`extensionKind: ["workspace"]`.

**Residual risk / where real confirmation still happens.** This is a
source-grounded architectural read, not a click-observed one — `04`'s own
`## Verify` matrix step 1 ("New terminal → prompt appears; `tmux ls` on
remote shows one `code-*`") is the actual empirical gate and is unchanged by
this decision; it must still pass on a real Unix remote via F5 before `04`
ships. If it somehow doesn't (e.g. a VS Code version regresses this), the
fallback is still Route B as originally scoped — no plan changes needed to
pivot, just swap the injection point in `terminalProvider.ts`.

**Route A implications carried into `04`:**
- No remote *Machine*-settings mutation (Route B's `terminal.integrated.profiles.linux`
  shell injection) needed — lower risk, no risk of us clobbering the user's own shell
  config. VS Code's terminal extension point has no manifest-level "make this the
  default" flag (`id`/`title`/`icon` only — confirmed against `contributes.terminal`'s
  schema during `09` acceptance testing), so making tmux "the default terminal on a
  resolved Unix host" (as stated above) still needs exactly one settings write:
  `terminal.integrated.defaultProfile.linux`, **Workspace**-scoped and only when unset
  (`extension.ts#setDefaultTerminalProfileIfUnset`) — never User/Global, never
  overriding a choice already made. This is narrower than Route B and was missing from
  the original v1.0.0 RC; `09`'s matrix row 1 caught it (fresh terminal launched plain
  bash, zero tmux sessions on the remote) alongside a second bug in the same area: the
  RC's `contributes` block had a stray top-level `"terminal.profiles"` key (a copy of a
  *settings*-schema shape) instead of the real `"terminal": {"profiles": [...]}"`
  extension point, so `registerTerminalProfileProvider('tmux', ...)` was a silent
  no-op. Both fixed together, re-verified live (VSCodium + Xvfb + a real Docker SSH
  remote): `tmux ls` shows exactly one `code-*` session after opening a terminal.
- `contributes.terminal.profiles` (05) + `registerTerminalProfileProvider`
  is the real (non-spike) implementation shape for step 1 of `04`.
- Dedupe against VS Code's own persistent-terminal revive (`04` step 3) is
  still required — this decision only settles *where the process spawns*,
  not the double-persistence question.

## Ownership: tmux owns the process, VS Code owns the tab

The v1.0.0 design neutralised VS Code's persistent-terminal layer
(an `isTransient` terminal) so tmux would be the only owner. That threw away split
layouts on every reload, so it was reversed (1.1.0): VS Code persists and revives
the *tabs* and their layout, tmux owns the *processes*, and every revive is
answered by the profile provider with the same session — never a new one
(`REVIVE_GRACE_MS` / `REVIVE_DEADLINE_MS` in `terminalProvider.ts` explain the
ordering). One owner per concern, so re-attach is predictable.

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
- **Housekeeping on connect** (`remote.SSH.tmux.reapOnConnect`, shipped). Kills
  sessions of ours whose pane is dead, and detached sessions of ours with no
  activity for `remote.SSH.tmux.orphanMaxAgeDays` (default 14; `0` = never) — the
  ones a renamed or abandoned folder leaves behind. Never an attached session,
  never a name we did not mint, never this window's own mapped sessions. One Info
  line reports the count: `tmux housekeeping: K killed, O old sessions kept`. The
  manual "Kill Persistent Terminal Sessions (this workspace)" command stays for
  the power case.

The invariant: **one live session per (host, workspace, terminal-slot); zero
sessions with no purpose.**

## Resolved questions (2026-07-24)

All the open questions below are now shipped decisions, implemented in
`src/tmux/*` and covered by unit tests. Kept here (rather than deleted) as the
record of *why*, per the "write it down" house rule.

- ~~**Terminal profile vs. wrapper vs. shell-init** as the injection point~~ —
  resolved: terminal profile provider (Route A), confirmed to spawn on the
  remote regardless of `extensionKind` — see "Spike decision" above. **Shipped**
  in `src/tmux/terminalProvider.ts`.
- **Naming / discovery.** Resolved as `code-<sha1_12(host + ' ' + workspacePath)>-<slot>`,
  where host is the resolved `user@hostname:port` (lower-cased; since the hardening
  sweep — before it, the SSH alias as typed) and the path is normalised (`//`
  collapsed, trailing `/` dropped); sessions under the old name are renamed once —
  one deterministic namespace per (host, workspace), with a numeric `slot` for
  multiple terminals in the same workspace (terminal 0, 1, 2, …). No user-facing
  name; the `code-` prefix is also the exact namespace the reaper is allowed to
  touch, so a user's own `main` session is never at risk. **Shipped** in
  `sessionName` / `sessionSlot` (`src/tmux/tmuxSession.ts`).
- **Resize / reflow.** Resolved narrowly, not left open: each session sets
  `status off` (no tmux status bar — VS Code's own tab is the chrome) and a
  configurable `history-limit` (default 50000) for scrollback; tmux's automatic
  window resize-to-client behaviour is relied on as-is (a single VS Code
  terminal is always the sole client resizing the window in the common case).
  Multi-client concurrent-resize contention is accepted, undocumented tmux
  behaviour, not solved by this fork — see the multi-client rules in
  [`persistence-model.md`](persistence-model.md). **Shipped** in
  `buildAttachOrCreateArgv`; the full list of options it sets is under "What we
  write to the user's tmux server" below.
- **Claude Code specifically.** Resolved as *not* a first-class "attach to my
  long task" command — a well-known, deterministic session name is enough:
  `code-<hash>-0` (slot 0, the first terminal opened in a workspace) is where a
  first Claude Code run naturally lands, and it is findable with
  `tmux attach -t code-<hash>-0` from any client that knows the host+workspace
  hash. A dedicated "attach to my Claude Code task" command/UI (naming the
  session by intent rather than slot order) is deferred — see
  [`roadmap.md`](roadmap.md).
- **Windows remotes.** Resolved as: tmux is Unix-only, so the feature is off by
  default there — no terminal-profile registration, no reaper, no bootstrap
  probe attempted; the base (non-tmux) shell profile is untouched so the
  connect never breaks. **Shipped** via the platform gate in
  `probeTmux` (`src/tmux/tmuxBootstrap.ts`), which short-circuits to
  `{available: false, reason: 'windows'}`.

## What we write to the user's tmux server

The terminals run in the user's own tmux server (the default socket), so anything
we set is visible to their other sessions. The rule (`buildAttachOrCreateArgv`,
`src/tmux/tmuxSession.ts`): **session-scoped where tmux allows it, and a
server-wide value only replaces tmux's own default — never a value the user
chose.** Nothing is ever written to `~/.tmux.conf`. Verified on tmux 2.6, 3.0a,
3.4, 3.5a and 3.8 by the rig.

Session-scoped, on our `code-*` sessions only, on every attach: `@orst_owner`
(the hand-off owner tag), `remain-on-exit off`, `status off`, `history-limit`,
`mouse on`, `prefix None`, `prefix2 None` (Ctrl-B reaches the program). Also
session-scoped: `@orst_closed`, written by the per-connection close watch when the
window's SSH connection ends and reset to `none` when it reconnects (user options
are overwritten, never unset — unsetting one crashes tmux 2.6).

Server-scoped, and when:

| What | When | Why |
|---|---|---|
| global `history-limit` | tmux < 3.7 only: set to our value for the instant our pane is created, then put back to the user's exact value | before 3.7 a pane reads it only at creation, so a session value comes too late |
| server user option `@orst_saved_hl` | tmux < 3.7: holds the user's value during that swap; left set afterwards (inert) | unsetting a global user option crashes the tmux 2.6 server |
| `escape-time` → 10 ms | only while it is still 500, the pre-3.5 default | a lone Esc otherwise lags half a second in every TUI |
| `set-clipboard` → `on` | only while it is still `external`, the default | drag-select in tmux reaches the local clipboard over OSC 52 |
| root-table `PageUp` / `PageDown` bindings | only if the key is unbound | key tables are server-global; the bindings act only at a bare shell prompt (alternate screen and non-shell programs such as Claude Code keep the keys) |

## Deferred (not in this release)

See [`roadmap.md`](roadmap.md) for the full list and rationale: a session-manager
tree view (candidate mechanism 2, above), a first-class "attach to my Claude Code
task" command, and mosh-over-tmux for seamless roaming.

## What this is NOT

- **Terminals only.** Editing, file changes, saving, extensions, and port
  forwarding already reconnect fine (the vscode-server persists) — we don't touch
  that path and must not regress it. The scope is the terminal lifetime.
- No transport change — SSH stays. (mosh was considered and dropped —
  [`decision-mosh-vs-tmux.md`](decision-mosh-vs-tmux.md).)
- No custom protocol, no new native binary we author. tmux is the (battle-tested)
  dependency; we integrate it.
