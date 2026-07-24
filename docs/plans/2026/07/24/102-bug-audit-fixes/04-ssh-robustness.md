# 04 — SSH robustness (upstream fixes)

> Part of [`overview.md`](overview.md). Depends on: none. All upstream files — surgical diffs, no reformatting.

## Files to change

### Crash-proofing (unhandled `'error'` events kill the extension host)
- `src/ssh/sshConnection.ts:296-314` — tunnel `stream.pipe(socket)`/`socket.pipe(stream)` (both port + unix-socket branches) have no `'error'` handlers → ECONNRESET crashes the host. Add handlers destroying the counterpart.
- `src/authResolver.ts:400-408` — same in the SOCKS server pipes. Same fix.
- `src/authResolver.ts:248-250` — ProxyCommand child has no `'error'` listener → ENOENT on a bad `ProxyCommand` binary = uncaught exception instead of the resolver's error dialog. Attach child + stream error handlers routed to the resolve-error path.
- `src/ssh/sshConnection.ts:274,295` — `this.connect().then(...)` in tunnel `connection` handlers has no `.catch`; on failure the accepted socket leaks open. Add `.catch` → destroy socket.
- `src/authResolver.ts:441-559,225,265` — async auth handler invoked fire-and-forget → any throw (e.g. key file deleted between `fileExists:474` and `readFile:480`) = unhandled rejection + auth stalls to `readyTimeout`. Wrap body in try/catch funneling to `callback(false)` + log.

### Parsing / auth correctness
- `src/ssh/sshDestination.ts:11-24` — `lastIndexOf(':')` mangles IPv6: `user@::1` → hostname `":"`, port 1. Support `[addr]:port` brackets; treat suffix as port only if all-digits and host isn't a bare IPv6 literal.
- `src/ssh/sshDestination.ts:42-51,19` — `parseEncoded` trusts any hex-decoding-to-JSON input (`'31'` → `1` → undefined hostName); `host:abc` → `port: NaN`. Validate decoded shape (`typeof data.hostName === 'string'`) and port digits.
- `src/ssh/identityFiles.ts:44-57` — encrypted private key without sibling `.pub` is dropped as a "bad public key" → passphrase prompt (`authResolver.ts:482-495`) never reached. On the encrypted-key parse error, keep the entry flagged; set `isPrivate` (currently never set — `authResolver.ts:467-473` is dead code) so the prompt path works.
- `src/authResolver.ts:206` — first ProxyJump hop defaults to the *destination's* port (`proxy.port || sshPort`) instead of 22 (inconsistent with `:231`). Default 22.
- `src/authResolver.ts:178,236` — `%`-token expansion: single-occurrence `replace`, no `%%` escape. Global regex + `%%` handling.
- `src/authResolver.ts:538-554` — cancelling keyboard-interactive mid-sequence calls `finish()` with a partial response array (and decrements retry below 0). On cancel → abort (`callback(false)`), never partial `finish`.

### sshConfig
- `src/ssh/sshConfig.ts:74-104` — `Include` recursion has no cycle/depth guard → `Include config` hangs the resolver. Track visited absolute paths, cap depth 16 (OpenSSH).
- `src/ssh/sshConfig.ts:82-98` — `Include` inside a `Host` section not expanded (silently ignored options). Recurse into `Section.config`.
- `src/ssh/sshConfig.ts:120-127` — `Host a b c` → only first name listed in the SSH Targets tree. Iterate all values, pattern-filter each.

### Connection lifecycle
- `src/ssh/sshConnection.ts:199-204,239,15` — `__retries` incremented per API call (not per attempt) → reconnect budget exhausted instantly; doc says "Default true" but `reconnect` defaults false. Count actual attempts only; fix the doc/default mismatch (keep behavior: default false).
- `src/authResolver.ts:562-572` — ProxyJump dispose closes only hop[0], never `sshConnection.close()` → the final connection's local tunnel servers keep listening. Close main connection + tunnels always.
- `src/ssh/sshConnection.ts:224,186-194` — dead `'ready'` err-param branch; `close()` doesn't reset `__$connectPromise`/`sshConnection` → later calls reuse a resolved promise on an ended client. Drop dead branch; reset state in `close()`.
- `src/ssh/sshConnection.ts:96-97,121-122` — `exec(cmd, params)` joins params unquoted into the remote shell line (injection surface contra CLAUDE.md guardrail). Shell-quote each param; audit callers (tmux layer builds argv separately — keep it that way).

## Steps
1. TDD pure parts first: `sshDestination` (IPv6/brackets/NaN/encoded-shape), sshConfig (cycle, host-scoped include, multi-name), `%`-expansion helper, exec-quoting helper.
2. Apply crash-proofing handlers (not unit-testable without heavy mocks — keep changes minimal, verified by lint/tsc + EDH).
3. identityFiles: fixture-based tests (encrypted key without `.pub` → entry kept + flagged).
4. Lifecycle fixes; run existing suite to catch regressions.

## Tests (write first — TDD)
- `SSHDestination.parse`: `user@::1`, `[::1]:2222`, `fe80::1`, `host:22`, `host:abc` (reject/NaN-guard), `@host`; round-trip `toString`.
- `parseEncoded`: `'31'` (hex→`1`) → falls back to `parse`, never undefined hostName; hex-JSON happy path.
- sshConfig: self-include → terminates; A↔B include → terminates; `Host x` containing `Include extra.conf` → options applied; `Host dev staging` → both hosts returned.
- `%`-expansion: `%h %h` both replaced; `%%h` → literal `%h`.
- exec quoting: param with `;`/`$( )`/space → single remote token.
- identityFiles: encrypted-no-pub kept with flag; `isPrivate` set.
- Commands: `npm test`, `npm run compile:src`, `npm run lint`.

## Verify
- Unit green; tsc/lint/bundle clean; existing 153 tests still pass.
- F5/EDH: normal connect unaffected (terminals-only regression guard); bad `ProxyCommand` binary → clean error dialog, no host crash; connect to an IPv6 destination if available.

## Done when
- No unhandled-`'error'`/unhandled-rejection path remains in the audited flows; IPv6 destinations parse; encrypted-key-only auth prompts for passphrase; sshConfig can't hang on cyclic includes.
