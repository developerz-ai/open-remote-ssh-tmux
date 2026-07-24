# Open Remote - SSH (tmux)

A VS Code / VSCodium extension that connects to a remote dev machine over
SSH — **identical to [open-remote-ssh](https://github.com/jeanp413/open-remote-ssh)
in look and feel** — with one under-the-hood upgrade: **remote terminals are
backed by [tmux](https://github.com/tmux/tmux)**, so they persist and can be
re-attached from any machine.

![Open Remote SSH](https://raw.githubusercontent.com/jeanp413/open-remote-ssh/master/docs/images/open-remote-ssh.gif)

## Why

You work across a PC, a laptop, and a VPS that's the actual dev environment.
Close the PC, open the laptop, and land back in the **same terminals** — same
scrollback, same running processes (a long `Claude Code` task, a build, a
migration) — regardless of which client connected last or whether the network
dropped in between.

With stock open-remote-ssh, a remote terminal's lifetime is coupled to the
client/session that opened it: closing the window, switching machines, or a
vscode-server restart can take a running task down with it. This fork moves
that lifetime into a **tmux server on the remote** — a process no client
owns — so terminals and the work inside them outlive any one connection.

**Scope is terminals only.** Editing, file changes, saving, extensions, and
port forwarding already reconnect fine (the vscode-server persists) — this
fork doesn't touch that path. It's invisible: no tmux commands, no tmux UI,
same connect flow as open-remote-ssh. See
[`docs/idea/why.md`](docs/idea/why.md) for the full motivation and
[`docs/idea/persistence-model.md`](docs/idea/persistence-model.md) for the
honest technical picture (below).

## Install

Releases ship as a `.vsix` on the
[Releases page](https://github.com/developerz-ai/open-remote-ssh-tmux/releases)
(not yet on Open VSX or the VS Code Marketplace).

1. Download `open-remote-ssh-tmux-<version>.vsix` from the latest release.
2. Optionally verify it against the published `.sha256`:
   `sha256sum -c open-remote-ssh-tmux-<version>.vsix.sha256`
3. In VS Code / VSCodium: Command Palette → `Extensions: Install from VSIX…`
   → pick the downloaded file.
4. VSCodium < 1.75 and VSCode-OSS also need the extension enabled in
   `argv.json` — see [Activation](#activation) below.

## Requirements

- **Remote host:** tmux **≥ 2.6** for tmux-backed persistent terminals on
  Unix-like remotes (Linux, macOS). Detected automatically on connect — if
  tmux is missing or too old, the extension logs why and falls back to plain
  (non-persistent) terminals; the base SSH connection is never blocked.
- **Windows remotes:** tmux is Unix-only. Windows remotes get stock,
  non-persistent terminals — same as upstream open-remote-ssh — and nothing
  else about the connection changes.
- Everything in upstream's [SSH Host Requirements](#ssh-host-requirements)
  and [Requirements](#activation) below still applies (this fork changes
  terminals only, not the SSH/server-install path).

## Settings

| Setting | Default | Description |
|---|---|---|
| `remote.SSH.tmux.enabled` | `auto` | `auto` enables tmux-backed terminals on Unix-like remotes and disables on Windows; `on` requires tmux (fails if unavailable); `off` disables the feature entirely. |
| `remote.SSH.tmux.reapOnConnect` | `true` | Automatically clean up empty/dead tmux sessions when connecting to a remote. Keeps hand-off deterministic — no zombie session graveyard. |
| `remote.SSH.tmux.historyLimit` | `50000` | Maximum scrollback lines retained per tmux terminal. |

All other settings (`remote.SSH.*` for SSH config, server install, agent
forwarding, etc.) are unchanged from upstream open-remote-ssh.

## Honesty: what this does and doesn't fix

tmux moves terminal lifetime off the client — it does **not** make the network
connection itself seamless. A dropped connection still needs a reconnect (fast,
but not invisible); that's the piece a transport like mosh would solve, and it
was deliberately left out — see
[`docs/idea/decision-mosh-vs-tmux.md`](docs/idea/decision-mosh-vs-tmux.md).
The full breakdown of what survives today vs. what tmux fixes is in
[`docs/idea/persistence-model.md`](docs/idea/persistence-model.md).

### Known limitations in v1.0.0

v1.0.0 was validated against a real rig — two isolated VSCodium clients driving
two Docker remotes over real SSH, with every remote-side assertion read back
over an independent connection. 19 of 21 acceptance rows pass, including every
row covering the two hard invariants (invisible UX, no zombies) and the full
multi-client hand-off model. Full results:
[`results-2026-07-24.md`](docs/plans/2026/07/24/101-v1-tmux-release/results-2026-07-24.md).

Two rows are **not** fully closed, and are listed here rather than glossed over:

- **Windows remotes are untested end-to-end.** The platform gate is confirmed
  to engage (a Windows remote takes the PowerShell install path and skips the
  tmux probe entirely, so it should behave exactly like upstream
  open-remote-ssh), but no real Windows SSH target was available to observe a
  full connect + terminal parity.
- **Long-lived TUI redraw after reattach was not visually confirmed.** That a
  backgrounded process and its scrollback survive a full close/reopen *is*
  verified, as is session adoption across machines — but the specific "a
  redrawing full-screen TUI repaints correctly on reattach" observation is
  still outstanding.

Reports on either are welcome in
[Issues](https://github.com/developerz-ai/open-remote-ssh-tmux/issues).

## SSH Host Requirements

You can connect to a running SSH server on the following platforms.

**Supported**:

- x86_64 Debian 8+, Ubuntu 16.04+, CentOS / RHEL 7+ Linux
- ARMv7l (AArch32) Raspbian Stretch/9+ (32-bit)
- ARMv8l (AArch64) Ubuntu 18.04+ (64-bit)
- IBM Z (s390x) Debian 13, RHEL 8+, Ubuntu 22.04+, SLES 15+
- macOS 10.14+ (Mojave)
- Windows 10+
- FreeBSD 13+ (Requires custom serverDownloadUrlTemplate setting)
- DragonFlyBSD (Requires manual remote-extension-host installation)

## Activation

**Configuration**

Your SSH server's configuration needs to have the following setting:
- `AllowTcpForwarding yes`

**Activation**

> NOTE: Not needed in VSCodium since version 1.75

Enable the extension in your `argv.json`

```json
{
    ...
    "enable-proposed-api": [
        ...,
        "developerz-ai.open-remote-ssh-tmux",
    ]
    ...
}
```
which you can open by running the `Preferences: Configure Runtime Arguments` command.
The file is located in `~/.vscode-oss/argv.json`.

**Alpine linux**

When running on alpine linux, the packages `libstdc++` and `bash` are necessary and can be installed via
running
```bash
sudo apk add bash libstdc++
```

## SSH configuration file

[OpenSSH](https://www.openssh.com/) supports using a [configuration file](https://linuxize.com/post/using-the-ssh-config-file/) to store all your different SSH connections.
To use an SSH config file, run the `Remote-SSH: Open SSH Configuration File...` command.

## Note for VSCode-OSS users

If you are using VSCode-OSS instead of VSCodium, you need some extra steps to make it work.

Modify the following entries in the plugin settings:

```
"remote.SSH.serverBinaryName": "codium-server",
"remote.SSH.serverDownloadUrlTemplate": "https://github.com/VSCodium/vscodium/releases/download/${version}${release}/vscodium-reh-${os}-${arch}-${version}${release}.tar.gz",
"remote.SSH.serverVersion": "latest",
"remote.SSH.serverValidation": "force",
```

VSCodium versions have an extra `release` part that do not have equivalent for VSCode-OSS.
So leaving `serverVersion` to the default `"match"` will fail.
The plugin will install the latest release of VSCodium if `serverVersion` is set to `"latest"`.
If you need to match the VSCode-OSS version, set `serverVersion` to `"closest"`, to
automatically fetch the last release of VSCodium for this version.

You can look for the release numbers associated with your VSCode version in the
[release page](https://github.com/VSCodium/vscodium/releases/). For instance, for VSCode
version "1.96.0", the (last) VSCodium release number is "24352".

You can also set `serverVersion` to a specic version (e.g. "1.116.0") or a specific
version-release (e.g. "1.116.02821").

If the local and remote VSCodium versions don't match, which will be the case on VSCode-OSS,
remote server validation needs to be bypassed. Setting `serverValidation` to `"force"` will
modify the commit of the remote server to make it match the local VSCode commit.
If `serverValidation` is set to `"skip"`, the remote server will skip checking that the commits
match. This option is working only if the remote VSCodium version is `>=1.120`.

Starting with VSCodium version 1.99.0, the `release` number is not separated from the `version` by a dot `.` anymore.
Therefore `serverDownloadUrlTemplate` needs to be filled with the new scheme (as shown above).

Before 1.99.0, the old scheme needs to be used:

```
"remote.SSH.serverDownloadUrlTemplate": "https://github.com/VSCodium/vscodium/releases/download/${version}.${release}/vscodium-reh-${os}-${arch}-${version}.${release}.tar.gz",
```

## Credit

This extension is a fork of
[jeanp413/open-remote-ssh](https://github.com/jeanp413/open-remote-ssh), which
does all the heavy lifting of resolving the `ssh-remote` authority, installing
the VS Code server, and running the remote session over SSH. This fork keeps
that entirely intact and adds tmux-backed persistent terminals on top. All
credit for the SSH/server-install foundation goes to the upstream project and
its contributors.
