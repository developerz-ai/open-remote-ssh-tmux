# Troubleshooting persistent terminals

Everything the extension decides about terminals is written to one place: the
**Remote - SSH** output channel (`Remote-SSH: Show Log` from the Command Palette,
or the Output panel). This page explains what you will find there, the
notifications the extension can show, and how to inspect the remote yourself.

The channel names hosts, users and remote paths. Check it before pasting it into a
public issue; see [SECURITY.md](../SECURITY.md#what-is-logged) for what is and is
not logged.

## Reading the Remote - SSH output channel

### Log levels

Lines come at two levels:

- **Info** — always written: outcomes worth knowing (terminals restored, taken
  over, cleaned up, the remote not answering).
- **Trace** — the per-terminal reasoning behind those outcomes. Written only when
  VS Code's log level is **Trace**: run `Developer: Set Log Level…` and pick
  `Trace`, then reconnect.

When reporting a terminal problem, set Trace first and reproduce it; the Info
lines alone rarely say *why*.

### Lines you will see

| Line | Level | Meaning |
|---|---|---|
| `Tmux terminal layer wired successfully` | Trace | Persistent terminals are on for this window. |
| `Tmux wiring failed: …` | Trace | Wiring threw; terminals are plain shells until the next connect. The message says why. |
| `Persistent terminals: the remote did not answer the capability check — plain shells for now, retrying on reconnect` | Info | The tmux check (5 s limit) got no answer. Nothing is cached; the next connect checks again. |
| `Persistent terminals: the remote did not answer in time — opening a plain shell for this terminal` | Info | One **New Terminal** could not reach the remote; that one terminal is a plain shell. For 5 s after such a failure, further new terminals are plain shells at once instead of waiting again. |
| `Persistent terminals: close watch failed: …` | Trace | The remote could not be set up to notice this window closing. Another machine then waits for 2 minutes without typing before taking the terminals over. |
| `tmux reconcile: N slot(s) to resolve, M session(s) on remote` | Trace | Start of the per-connect check of this workspace's terminals. |
| `tmux slot N: … -> <action> (<reason>)` | Trace | The decision for one terminal, with the evidence it was made on (below). |
| `tmux terminals: A to re-attach, B to reclaim, C to adopt, D to take over from an idle machine, E pruned` | Info | Summary of that check. Written only when something is non-zero. |
| `tmux terminals: took over N session(s) from another machine at the user's request` | Info | You clicked **Take over**. |
| `tmux terminals: slot N was taken over by another machine — session kept, not re-attaching` | Info | Another machine took this terminal; this window lets it go instead of taking it back. |
| `tmux terminals: adopted N session(s) from the previous naming scheme` | Info | One-time rename after an upgrade (see [Session names](#session-names)). |
| `tmux housekeeping: K killed, O old sessions kept` | Info | Connect-time cleanup: `K` terminals closed (dead, or idle longer than `remote.SSH.tmux.orphanMaxAgeDays`), `O` detached terminals still kept. |
| `Terminal lifetime: KillUserProcesses=… Linger=… -> at risk` | Trace | The host ends your processes at logout — see [Terminals closed after disconnect](#terminals-closed-after-disconnect). |

### The per-terminal decision line

```
tmux slot 0: mapped=yes open=no attached=yes windows=1 owner=me stale=no handOff=auto -> restore-takeover (held by our own stale client — reclaiming with -D)
tmux slot 1: mapped=no open=no attached=yes windows=1 owner=other stale=no handOff=auto -> offer (held by another machine — offering, never taking)
```

| Field | Meaning |
|---|---|
| `mapped` | This window's workspace has had this terminal before. |
| `open` | It is already open in this window. |
| `attached` | Some window (on any machine) is showing it right now. |
| `owner` | Whose window that is: `me` (an earlier window of this one, still held open by VS Code), `other` (another machine or window), `unknown` (a terminal created before ownership was recorded). |
| `stale` | The other window is abandoned: its connection ended (the remote marked the session closed) and nobody has typed in it since, or nobody has typed in it for 2 minutes. |
| `remote=none` | The remote listed no such terminal (printed in place of the four fields above). |

Actions: `restore` (re-attach), `restore-takeover` (re-attach, dropping this
machine's own leftover window), `adopt` (open a terminal another window left
behind), `handoff-takeover` (move it from an idle machine), `offer` (ask you
first), `skip` (leave it; the reason says why).

## Notifications

All are ordinary, non-modal notifications.

- **"This workspace's terminals are open on another machine."**
  **[Take over]** moves them to this window: the other window's tabs close and
  nothing running in them stops. **[Not now]** (or dismissing it) leaves them
  where they are; this window does not ask again until it is reloaded. When it
  appears is controlled by `remote.SSH.tmux.handOff`: `auto` (default) moves
  terminals from a machine idle for 2 minutes without asking and offers the rest,
  `ask` always offers and never moves without a click, `never` never offers.
- **"N background terminals from this workspace are still running."**
  Shown after `remote.SSH.tmux.enabled` is set to `off` while connected.
  **[Close them]** ends them; **[Keep]** leaves them running (housekeeping closes
  them once they are older than `remote.SSH.tmux.orphanMaxAgeDays`).
- **"Terminals on this host may not survive a disconnect: the host ends your
  processes when you log out."** Shown once per host — see the next section.
- **"remote.SSH.tmux.enabled is set to "on" … but tmux is not available on this
  remote."** Install tmux 2.6 or newer on the remote, or set the setting to `auto`.

## Terminals closed after disconnect

Every terminal is gone after a disconnect or a window close, and they come back
empty. The usual cause is **systemd-logind ending your processes at logout**: with
`KillUserProcesses=yes`, logind terminates everything started from the SSH login
when the connection closes — the tmux server that holds your terminals included.
The extension checks for this on connect and warns once per host.

Check on the remote:

```bash
loginctl show-session -p KillUserProcesses   # KillUserProcesses=yes means affected
```

Fix it on the remote (needs root), in `/etc/systemd/logind.conf` or a drop-in
under `/etc/systemd/logind.conf.d/`:

```ini
[Login]
KillUserProcesses=no
# or keep it on for everyone else and exempt yourself:
# KillExcludeUsers=root youruser
```

Then `sudo systemctl restart systemd-logind` (or reboot). `loginctl enable-linger`
alone does **not** help: it keeps your user service manager running, but the
terminals live in the login session, which is still ended.

Two other things end every terminal, and neither is fixable from here: a **reboot
of the remote** (tmux keeps terminals across disconnects, not across a restart),
and anything that kills your tmux server (`tmux kill-server`, an OOM kill).

## Agent forwarding after a reconnect

A shell that was running before a reconnect keeps the old `SSH_AUTH_SOCK`, which
no longer exists, so `git` or `ssh` in that shell may stop finding your keys. A
new terminal gets the current socket. To fix an existing shell, run this inside
it:

```bash
eval "$(tmux show-environment -s SSH_AUTH_SOCK)"
```

## Inspecting the remote by hand

Every persistent terminal is a plain tmux session on the remote; nothing is
hidden.

```bash
tmux ls                                                          # sessions: code-<hash>-<slot>
tmux list-clients -F '#{client_tty} -> #{client_session}'        # which are on screen somewhere
tmux list-panes -a -F '#{session_name} #{pane_current_command}'  # what runs in each
tmux kill-session -t =code-<hash>-<slot>                         # close one
```

To close every terminal of the current workspace from VS Code, run
**Remote-SSH: Kill Persistent Terminal Sessions (this workspace)**. Sessions not
named `code-<hash>-<slot>` — your own tmux sessions — are never touched by the
extension.

### Session names

`code-<hash>-<slot>`, where `<hash>` is the first 12 hex characters of the SHA-1
of `user@host:port` (the target the connection really reaches, after your SSH
config; host lower-cased), a space, and the folder path (repeated `/` collapsed,
trailing `/` removed). `<slot>` numbers the terminals of that workspace from 0.
To find a workspace's sessions:

```bash
printf '%s' 'me@build.example.com:22 /srv/project' | sha1sum | cut -c1-12
```

Versions before this naming used the SSH alias as typed and the raw folder path;
their sessions are renamed to the new name on the first connect, with their
processes untouched.

## Where the log files are

The output channel is also written to disk. `Developer: Open Logs Folder` opens
the current session's folder; the channel is in
`window<N>/exthost/output_logging_<timestamp>/` as `<N>-Remote - SSH.log`. The
logs root is typically:

| Editor | Linux | macOS | Windows |
|---|---|---|---|
| VS Code | `~/.config/Code/logs/` | `~/Library/Application Support/Code/logs/` | `%APPDATA%\Code\logs\` |
| VSCodium | `~/.config/VSCodium/logs/` | `~/Library/Application Support/VSCodium/logs/` | `%APPDATA%\VSCodium\logs\` |
