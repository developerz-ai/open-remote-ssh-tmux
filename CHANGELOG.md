# Changelog

One file per release in [`docs/changelog/`](docs/changelog/), newest first. Releases before
1.0.0 are upstream [open-remote-ssh](https://github.com/jeanp413/open-remote-ssh)'s, from
before the fork.

- [1.5.0](docs/changelog/1.5.0.md) — Bug sweep: eight adversarial reviewers, fixes test-first, proven on real tmux 2.6 to 3.8 and in real VSCodium
- [1.4.2](docs/changelog/1.4.2.md) — fix: the first New Terminal on a first connect over a real-latency link could still be a plain shell
- [1.4.1](docs/changelog/1.4.1.md) — fix(ci): release `.sha256` files are in `sha256sum -c` format, so the README's verify step works
- [1.4.0](docs/changelog/1.4.0.md) — **Connect to Host...** reuses an empty window and lists recent hosts; a reworked SSH Targets view
- [1.3.0](docs/changelog/1.3.0.md) — Hardening sweep, proven against real tmux 2.6, 3.0a, 3.4, 3.5a and 3.8 over real SSH in the new docker rig
- [1.2.0](docs/changelog/1.2.0.md) — A security and correctness release from a full audit of the codebase
- [1.1.3](docs/changelog/1.1.3.md) — fix: the 1.1.2 PageUp binding took the key from Claude Code
- [1.1.2](docs/changelog/1.1.2.md) — fix: <kbd>PageUp</kbd> recalled the previous command instead of scrolling
- [1.1.1](docs/changelog/1.1.1.md) — fix: the clipboard image paste did nothing on Windows and logged nothing about it
- [1.1.0](docs/changelog/1.1.0.md) — feat: paste a local screenshot into the focused remote terminal with `Ctrl+Alt+V` (`Cmd+Alt+V` on macOS)
- [1.0.0](docs/changelog/1.0.0.md) — feat: fork as open-remote-ssh-tmux — tmux-backed persistent remote terminals
- [0.2.0](docs/changelog/0.2.0.md) — feat: add compatibility with Code-OSS (#189)
- [0.1.2](docs/changelog/0.1.2.md) — fix: split ProxyCommand into argv tokens before spawn (#274)
- [0.1.1](docs/changelog/0.1.1.md) — don't assume `ProxyCommand` value's type (#270)
- [0.1.0](docs/changelog/0.1.0.md) — replace `which` with `command -v` (#215)
- [0.0.49](docs/changelog/0.0.49.md) — remove default `remote.SSH.serverDownloadUrlTemplate`
- [0.0.48](docs/changelog/0.0.48.md) — Support `%n` in ProxyCommand
- [0.0.47](docs/changelog/0.0.47.md) — Add support for loong64 (#175)
- [0.0.46](docs/changelog/0.0.46.md) — Add riscv64 support (#147)
- [0.0.45](docs/changelog/0.0.45.md) — Use windows-x64 server on windows-arm64
- [0.0.44](docs/changelog/0.0.44.md) — Update ssh2 lib
- [0.0.43](docs/changelog/0.0.43.md) — Fix parsing multiple include directives
- [0.0.42](docs/changelog/0.0.42.md) — Fix remote label to show port when connecting to a port other than 22
- [0.0.41](docs/changelog/0.0.41.md) — Take into account parsed port from ssh destination. Fixes (#110)
- [0.0.40](docs/changelog/0.0.40.md) — Update ssh-config package
- [0.0.39](docs/changelog/0.0.39.md) — output error messages when downloading vscode server (#39)
- [0.0.38](docs/changelog/0.0.38.md) — Enable remote support for ppc64le (#93)
- [0.0.37](docs/changelog/0.0.37.md) — Default to Current OS User in Connection String if No User Provided (#91)
- [0.0.36](docs/changelog/0.0.36.md) — Make wget support continue download (#85)
- [0.0.35](docs/changelog/0.0.35.md) — Fixes hardcoded agentsock for windows breaks pageant compatibility (#81)
- [0.0.34](docs/changelog/0.0.34.md) — Add remote.SSH.connectTimeout setting
- [0.0.33](docs/changelog/0.0.33.md) — feat: support %r user substitution in proxycommand
- [0.0.32](docs/changelog/0.0.32.md) — feat: use serverDownloadUrlTemplate from product.json (#59)
- [0.0.31](docs/changelog/0.0.31.md) — feat: support glob patterns in SSH include directives
- [0.0.30](docs/changelog/0.0.30.md) — feat: support file patterns in SSH include directives
