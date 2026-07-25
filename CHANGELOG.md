## 1.1.2
- fix: <kbd>PageUp</kbd> recalled the previous command instead of scrolling. tmux binds nothing to it, so the key reached the shell, where readline's stock `/etc/inputrc` maps it to history-search-backward — the keyboard half of the wheel bug fixed in 1.1.0. PageUp now enters tmux copy mode already paged up, and PageDown pages back down and drops out of it on its own at the bottom, so scrolling never surfaces a tmux mode. A full-screen app on the alternate screen (vim, less, htop) keeps both keys verbatim, and PageDown outside copy mode is swallowed rather than recalling the next command

## 1.1.1
- fix: the clipboard image paste did nothing on Windows and logged nothing about it. Two causes: the command fell through to a plain text paste without a word when it could not determine the remote authority (now it falls back to the resolver's own authority, and says so in the log when there is none), and the PowerShell reader was passed as inline `-Command` text whose `$variables` and quoting had to survive argument processing plus a CreateProcess round trip — both readers now go through `-EncodedCommand` (base64 UTF-16LE), which nothing downstream can reinterpret
- fix: Windows now tries two clipboard readers — WPF `[Windows.Clipboard]::GetImage()` with a `PngBitmapEncoder` first (the combination the long-standing implementations settled on), then WinForms as a second opinion, since the two negotiate clipboard formats differently and a DIB one declines the other can accept
- fix: a reload where VS Code revived *fewer* terminals than there were sessions made the odd one out wait out the full 10s backstop — eleven seconds before the second terminal appeared. Once any revive is observed the wait now ends a short quiet period after the last one, re-armed by each claim, so only a revive that never starts pays the backstop
- fix: folders opened on a host that is not named in the SSH config never appeared in "SSH Targets" — the tree's root nodes came only from `Host` entries while a remembered folder is keyed by the hostname from the remote authority, so connecting by FQDN recorded a folder with no node to hang on. The root list is now the union of both
- fix: the "SSH Targets" view answered from a snapshot taken at activation, so a folder opened in another window never showed up and even its own Refresh command could not surface it — `globalState` is shared across windows and is now read through on every render
- enhance: macOS no longer needs `brew install pngpaste` for the image paste — AppleScript's `the clipboard as «class PNGf»` is used as a built-in fallback, so a stock Mac has a native reader instead of being pushed to the visible webview panel

## 1.1.0
- feat: paste a local screenshot into the focused remote terminal with `Ctrl+Alt+V` (`Cmd+Alt+V` on macOS) — the image is written to the remote and its path pasted, so a remote CLI tool (e.g. Claude Code) can read it; falls through to an ordinary paste when the clipboard holds no image
- feat: `mouse on` so the scroll wheel scrolls the scrollback instead of cycling shell history, with `set-clipboard on` so drag-select still reaches the local clipboard over OSC52
- feat: `remote.SSH.tmux.setDefaultProfile` setting to opt out of the Workspace-scope `terminal.integrated.defaultProfile.<platform>` write that makes a plain "New Terminal" persistent
- fix: the tmux layer never wired at all — the fallback and the real provider both registered on the `tmux` profile id, VS Code throws on the second, and every "Persistent Shell" silently opened a plain shell with no tmux session; registration now has a single owner (`src/tmux/profileRegistration.ts`)
- fix: reopening a window abandoned live work — VS Code keeps a closed window's pty (and the tmux client inside it) alive for its 3h reconnection grace, which reconciliation misread as "another machine holds this"; ownership is now decided by the client-local slot mapping and our own stale client is evicted with tmux `-D` (`src/tmux/slotState.ts`)
- fix: `remote.SSH.tmux.historyLimit` was a complete no-op — tmux reads `history-limit` when a pane is created, before any chained `set-option` can run, so every terminal sat on the 2000-line default; it is now set globally before `new-session` and restored with `-gu` immediately after
- fix: closing a terminal left a running session nothing would ever show again (the "tombstone" behaviour); a user close now kills its session, as in stock open-remote-ssh, while a window close or reload still only detaches
- fix: a window reload could silently disable restore — all four `TerminalExitReason`s were treated as an explicit user close
- fix: split/group terminal layout was discarded on every reload (`isTransient`); restore now queues sessions for VS Code's own revive to claim, so the layout comes from VS Code and the sessions from here
- fix: a reload could still produce duplicate terminals — the restore queue closed on a fixed 2.5s timer, but VS Code revives when the workbench finishes restoring, seconds later on a real remote; the late revive then found an empty queue and minted new sessions, leaving four tabs (two unsplit, two split) where two belonged. The wait now ends on evidence — every queued slot claimed or observed in the window — with a timer only as the backstop for a revive that never comes
- fix: "wants to relaunch the terminal to contribute to its environment" on every reconnect — the `SSH_AUTH_SOCK` contribution is now diffed and skipped when unchanged, since relaunching is precisely what discards a surviving tmux session (`src/common/envCollection.ts`)
- fix: macOS remotes never got the default profile — `terminal.integrated.defaultProfile.<suffix>` is derived from the remote OS instead of hardcoded to `linux`
- fix: three races that could cost a live session — concurrent profile requests taking the same slot, `new-session -A` racing an in-flight `kill-session`, and overlapping `workspaceState` writes
- fix: a dropped channel pruned the slot mapping one slot at a time, because an undeliverable `has-session` probe was read as "session gone"
- fix: one failing `createTerminal` aborted the whole reconcile, discarding mapping state for sessions still alive on the remote
- docs: document the paste-image bridge, the tmux options the layer sets, and the close/detach semantics; drop stale claims about `isTransient` splits and "close = detach, never kill"

## 1.0.0
- feat: fork as open-remote-ssh-tmux — tmux-backed persistent remote terminals that survive client disconnects, window closes, and machine hand-off (PC ↔ laptop ↔ VPS)
- feat: deterministic tmux session naming keyed to host+workspace with attach-or-create semantics — re-opening a workspace re-attaches the same session, never a duplicate
- feat: automatic reaping of empty/dead tmux sessions on connect (`remote.SSH.tmux.reapOnConnect`)
- feat: `remote.SSH.tmux.enabled` setting (`auto` | `on` | `off`) with graceful fallback to plain terminals when tmux is unavailable or on Windows remotes
- feat: `remote.SSH.tmux.historyLimit` setting for remote terminal scrollback
- feat: command to kill all tmux sessions for the current workspace
- build: rebrand to `open-remote-ssh-tmux` / `developerz-ai` publisher identity; SSH transport, `ssh-remote` authority, and command/config ids unchanged from upstream

## 0.2.0
- feat: add compatibility with Code-OSS (#189)
- remodel: use base64 encoding for install script to support csh/tcsh login shells (#296)
- enhance(linux): use `flock` to prevent multiple server install scripts running in parallel (#285)
- enhance: increase polling loop to aid slowish machines (#290)
- refactor: rename `serverBinaryName` setting (#280)
- refactor: extract install scripts from `serverSetup.ts` into script files (#287)

## 0.1.2
- fix: split ProxyCommand into argv tokens before spawn (#274)

## 0.1.1
- don't assume `ProxyCommand` value's type (#270)

## 0.1.0
- replace `which` with `command -v` (#215)
- allow automatic download of remote extension host on FreeBSD (#244)
- add remote.SSH.serverInstallPath option (#259)
- cleanup on errors (#172)
- typo `attemp` -> `attempt` (#185)
- use original ssh-config dependency (#267)

## 0.0.49
- remove default `remote.SSH.serverDownloadUrlTemplate`

## 0.0.48
- Support `%n` in ProxyCommand
- fix: add missing direct @types/ssh2-stream dependency (#177)
- fix Win32 internal error (#178)

## 0.0.47
- Add support for loong64 (#175)
- Add s390x support (#174)
- Support vscodium alpine reh (#142)

## 0.0.46
- Add riscv64 support (#147)

## 0.0.45
- Use windows-x64 server on windows-arm64

## 0.0.44
- Update ssh2 lib
- Properly set extensionHost env variables

## 0.0.43
- Fix parsing multiple include directives

## 0.0.42
- Fix remote label to show port when connecting to a port other than 22

## 0.0.41
- Take into account parsed port from ssh destination. Fixes (#110)

## 0.0.40
- Update ssh-config package

## 0.0.39

- output error messages when downloading vscode server (#39)
- Add PreferredAuthentications support (#97)

## 0.0.38

- Enable remote support for ppc64le (#93)

## 0.0.37

- Default to Current OS User in Connection String if No User Provided (#91)
- Add support for (unofficial) DragonFly reh (#86)

## 0.0.36

- Make wget support continue download (#85)

## 0.0.35

- Fixes hardcoded agentsock for windows breaks pageant compatibility (#81)

## 0.0.34

- Add remote.SSH.connectTimeout setting
- adding %r username replacement to proxycommand (#77)

## 0.0.33

- feat: support %r user substitution in proxycommand

## 0.0.32

- feat: use serverDownloadUrlTemplate from product.json (#59)

## 0.0.31

- feat: support glob patterns in SSH include directives

## 0.0.30

- feat: support file patterns in SSH include directives
