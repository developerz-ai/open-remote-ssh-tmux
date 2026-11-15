# 06 — Connection path: security and robustness (upstream-derived files)

> Part of [`overview.md`](overview.md). Depends on: 02 (uses `withDeadline`).

Upstream-derived code. Rule: minimal hunks, no reformatting, comment each hunk with why, list
every hunk in the PR body. Behaviour of the editing/file/forwarding path unchanged except where a
row below says otherwise.

## Findings
| # | Finding | Where | Ev. |
|---|---|---|---|
| a | **Listeners bind all interfaces.** `.listen(port)` with no host → `::`/`0.0.0.0`. Dynamic forwarding defaults on → an unauthenticated SOCKS5 relay into the remote's network for anyone on the client's LAN; server tunnel exposed too (token-protected). `findRandomPort` checks `127.0.0.1` only | `src/ssh/sshConnection.ts:392`, `src/authResolver.ts:837`, `src/common/ports.ts:14` | V |
| b | `Proxy connection timed out` ×6 in field logs, ~22 s after connect, bursts across windows | `src/authResolver.ts:~800-835` (SOCKS client path) | V observed, cause unknown |
| c | Connect path without deadlines: `uname -s` (`src/serverSetup.ts:135`), install via `bash -l` (`:239`), Windows `execPartial` (`:231`), ProxyJump `forwardOut` (`src/authResolver.ts:621`), agent identity lookup (`src/ssh/identityFiles.ts:93-104`); progress not cancellable (`authResolver.ts:557`) | — | V |
| d | `close()` awaits `closeTunnel()` → `server.close(cb)` waits for every socket; on a dead link old client + sockets leak until OS timeout; `teardownAttempt` does not await | `src/ssh/sshConnection.ts:215-227,409`, `src/authResolver.ts:375` | S |
| e | Host keys: only `~/.ssh/known_hosts`; ignores `UserKnownHostsFile`, `GlobalKnownHostsFile`, `/etc/ssh/ssh_known_hosts`, `HostKeyAlias`; `@cert-authority` skipped. Fails safe (prompt) | `src/ssh/hostfile.ts:7-8,151-157`, `src/ssh/sshConfig.ts:14,20` | V |
| f | Windows: `.bat`/`.cmd` ProxyCommand spawned `shell: true` + `windowsVerbatimArguments`, args quoted only on space, `%h`/`%n` from the authority → cmd metachar injection | `src/authResolver.ts:625-632` | S |
| g | Log hygiene: full install script at Trace every connect (37× in field logs); full expanded ProxyCommand logged (may carry tokens); agent `ECONNRESET` at Error though auth proceeds; `Log.trace` not level-gated | `src/serverSetup.ts:188,235`, `src/authResolver.ts:635`, `src/common/logger.ts:14-31` | V |
| h | Small: `reject(null)` → error text "null" (`sshConnection.ts:284`); missing `listeningOn` → `TypeError` classed retryable → endless retry (`serverSetup.ts:259`); server tarball unverified (TLS only, `src/scripts/server-setup.sh:177-199`); `simple-socks` is a git dependency without integrity | — | V |
| i | Clipboard: sweep uses `2>/dev/null` unwrapped (csh breaks) (`src/clipboard/clipboardImage.ts:284`); native readers each 15 s before text check (`src/clipboard/pasteImage.ts:229`); webview without CSP (`src/clipboard/clipboardWebview.ts:92-171`); bracketed paste sent unconditionally (`clipboardImage.ts:296-298`) | — | V |

## Files to change
- `src/ssh/sshConnection.ts:392`, `src/authResolver.ts:837` — `.listen(port, '127.0.0.1')`.
  If anyone relied on LAN exposure: no setting; note in CHANGELOG as a security fix.
- `src/authResolver.ts` — (b) after root cause: fix or downgrade to a single Info line with
  destination; (c) deadlines via `withDeadline` on `forwardOut`, cancellable progress wired to
  teardown; (f) reject authority hostnames containing cmd metacharacters before token expansion
  and always quote expanded tokens; (g) redact ProxyCommand args.
- `src/serverSetup.ts:135,231,239,259` — deadlines (platform detect short; install long,
  configurable ceiling); explicit non-retryable error when `listeningOn` missing; script body
  logged once per session, later connects log a hash line.
- `src/ssh/identityFiles.ts:93-104` — agent lookup under deadline; failure logged at Info.
- `src/ssh/sshConnection.ts:215-227,284,409` — destroy tracked tunnel sockets on close; bounded
  wait then `end()`; never `reject(null)`.
- `src/ssh/hostfile.ts`, `src/ssh/sshConfig.ts` — read known-hosts from `UserKnownHostsFile` +
  `GlobalKnownHostsFile` + `/etc/ssh/ssh_known_hosts` (read-only for global); honour
  `HostKeyAlias`; writes still go to the user file. `@cert-authority`: out of scope, documented.
- `src/common/logger.ts` — respect the output channel log level for trace.
- `src/clipboard/clipboardImage.ts`, `pasteImage.ts`, `clipboardWebview.ts` — wrap remote
  commands in `sh -c`; cheap "clipboard has image?" check before the 15 s readers; CSP meta with
  nonce.
- `package.json` / lockfile — replace git `simple-socks` with a registry version pinned exactly,
  or vendor with integrity noted; decide in PR.
- `src/scripts/server-setup.sh` — untouched unless a checksum source exists upstream; else
  document (README security section).

## Steps
1. (a) first, alone, with its own test and CHANGELOG security entry.
2. (b) reproduce: instrument on the rig (multiple windows, one connection) to find what times
   out at ~22 s; fix cause, not the log.
3. (c)(d) deadlines + close; (e) known_hosts; (f) reproduce on Windows or by unit-testing the
   argv construction, then fix; (g)(h)(i).

## Tests (write first — TDD)
- `test/ssh/sshConnection.test.ts` — tunnel server `address().address === '127.0.0.1'`
  (real `net` server on port 0); `close()` settles with a never-ending client socket; no
  `null` rejection.
- `test/authResolver.*.test.ts` — forwarding server bound to loopback; authority with `&`, `|`,
  `^`, `%`, `"` rejected or inertly quoted in the Windows ProxyCommand argv; ProxyCommand log
  line redacted; `forwardOut` deadline.
- `test/ssh/hostfile.test.ts` — key found in a custom `UserKnownHostsFile`, in the global file;
  `HostKeyAlias` lookup; new keys written only to the user file; revoked still refused.
- `test/serverSetup.test.ts` — missing `listeningOn` → non-retryable typed error; install script
  logged once.
- `test/ssh/identityFiles.test.ts` — hung agent → continues with file identities.
- `test/common/logger.test.ts` — trace suppressed below trace level.
- `test/clipboard/*.test.ts` — commands `sh -c` wrapped; CSP present in HTML; reader skipped when
  no image.
Commands: `npm run compile:src`, `npm run lint`, `npm test`.

## Verify
- F5 connect: `ss -ltnp | grep <extension host pid>` shows only `127.0.0.1` listeners; port
  forwarding, extensions install, file editing all still work (base-experience regression pass).
- Field-log replay: no Error-level lines on a healthy connect; log size per connect drops.
- Rig with dropped link: reconnect leaves no growing socket count in the extension host.

## Done when
- No non-loopback listener. No unbounded wait on the connect path. Host-key lookup matches
  OpenSSH for the documented options. Logs carry no ProxyCommand secrets.
