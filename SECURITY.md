# Security policy

## Supported versions

Only the latest release line gets security fixes. Older releases are not patched.
Upgrade to the newest version from the
[releases page](https://github.com/developerz-ai/open-remote-ssh-tmux/releases).

| Version | Supported |
|---------|-----------|
| 1.2.x   | yes       |
| < 1.2   | no        |

## Reporting a vulnerability

Please **do not open a public issue**. Report privately through GitHub's security advisories:
[Report a vulnerability](https://github.com/developerz-ai/open-remote-ssh-tmux/security/advisories/new).

Include the version, the local OS and the remote OS, what an attacker controls (a remote
host, an SSH config entry, a workspace folder name, a local process), and steps to
reproduce. We aim to acknowledge a report within a week and to agree on a disclosure date
with you before anything is published.

If the issue is in upstream code that this fork shares
([jeanp413/open-remote-ssh](https://github.com/jeanp413/open-remote-ssh)), report it here
anyway; we will coordinate with upstream.

## Scope

The extension handles credentials and runs commands on remote machines, so these areas are
in scope:

- **Credentials and keys**: SSH passwords, key passphrases, private keys and the agent
  socket (`src/ssh/*`, `src/authResolver.ts`); known_hosts verification (`src/ssh/hostfile.ts`).
- **Remote command execution**: the VS Code server install scripts (`src/scripts/*`) and
  everything templated into them (`src/serverSetup.ts`), including user settings such as
  `remote.SSH.serverDownloadUrlTemplate` and `remote.SSH.defaultExtensions`.
- **tmux command lines**: session names, paths and options built in `src/tmux/*` and sent
  to the remote shell. Workspace and host names must never be able to inject shell syntax.
- **Clipboard image bridge**: the remote paths and commands built in `src/clipboard/*`.
- **Local listeners**: the dynamic-forwarding SOCKS proxy and port tunnels the extension
  opens on your machine. They bind to `127.0.0.1` only; anything reachable from another
  host is a vulnerability.

Out of scope: the security of the VS Code server itself, of the remote host's sshd, and of
tmux; please report those to their projects.

## What is logged

Logs go to the local "Remote - SSH" output channel only; nothing is sent anywhere.

- At **Info** and **Error** level: the remote authority being resolved (it names the host),
  each authentication method tried (for a key: its file name, type and public fingerprint),
  server install progress, persistent-terminal status, and error messages. Passwords, passphrases and key material are never logged.
- At **Trace** level only: the server install command and its output, the ProxyCommand
  being spawned, and the list of identity files found.
  The connection token is redacted from the install command and its output, and
  ProxyCommand arguments are replaced by their count. Trace lines appear only when VS Code's
  log level is set to Trace. On VS Code hosts before 1.74, which have no log level for
  extensions, they are always written; the redactions above still apply.

Check the channel before pasting it into a public issue: it contains host names, user names
and remote paths.

## Known limitations

- **VS Code server download is verified by TLS only.** The install script downloads the
  server tarball from `remote.SSH.serverDownloadUrlTemplate` (VSCodium's GitHub releases
  over HTTPS by default) and checks no checksum or signature. Whoever controls that URL, or
  a TLS-intercepting proxy the remote host trusts, controls the server that runs on the
  remote.
- **tmux is Unix-only.** On Windows remotes the tmux layer is off and terminals are plain
  shells; there is no tmux attack surface there, and no persistence either.
