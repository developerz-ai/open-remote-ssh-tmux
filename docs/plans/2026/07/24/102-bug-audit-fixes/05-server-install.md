# 05 — server install & release resolution (upstream fixes)

> Part of [`overview.md`](overview.md). Depends on: none. Upstream files — surgical diffs.

## Files to change

### `src/scripts/server-setup.sh`
- `:153` — `pushd $SERVER_DIR` unquoted + exit code unchecked → on failure the download/extract/`rm -rf` all run in `$HOME`. `pushd "$SERVER_DIR" > /dev/null || print_install_results_and_exit 1`.
- `:180` — `rm -rf $SERVER_DIR/*` unquoted word-split → deletes wrong paths when the dir has a space. `rm -rf -- "${SERVER_DIR:?}"/*`.
- throughout (`:128,153,156-160,172,180,204-207,212-224,230,238`) — quote every `$SERVER_DIR`/path expansion.
- `:156-158` — `curl` fallback lacks `--fail` → 404 body saved as tarball, misleading extract error. Add `--fail`.
- `:196` — `sed -i -E` is GNU-only; BSD sed (macOS remotes) eats `-E` as backup suffix → `serverValidation: 'force'` silently no-ops. Portable: write temp file + `mv`.
- `:48-52` — lock file at fixed shared path (`/tmp/server_install.lock`) → second user's `exec {FD}<>` fails (mode 644, other owner) and aborts before any marker output; local-DoS-able. Move lock into `$SERVER_DATA_DIR`.
- `:203-205` — `ps -p $SERVER_PID` with unvalidated pidfile → garbage/empty pid → "not running" → duplicate server + token file deleted under the live one. Validate `[[ $SERVER_PID =~ ^[0-9]+$ ]]` first.

### `src/scripts/server-setup.ps1` (parity with .sh; must never break base Windows SSH)
- `:135` — server script invoked as bare token, no `&` operator/quoting → any path with a space (e.g. `C:\Users\John Doe\…`) fails "not recognized" yet reports `exitCode==0`. `& '<path>'` + quote token-file path.
- `:163-183` — no error branch when `$LISTENING_ON` never matches (the .sh has one at `:245-248`), poll only 5×500ms vs 35×500ms → `exitCode==0` with empty `listeningOn` → `authResolver.ts:322` opens a tunnel to port `0`. Add the error branch + lengthen poll.
- `:63,68,97` — failure paths `exit 1` without `printInstallResults` → no markers → generic "Failed parsing install script output" instead of the real error. `printInstallResults 1; exit 0` like the .sh.
- whole file — no install lock (concurrent connects corrupt the extract), tar exit code unchecked (`:90`), no corrupt-dir cleanup. Add `[System.Threading.Mutex]`, check `$LASTEXITCODE`, cleanup on failure.
- `:3` — `$TMP_DIR` never created (and mixed `/` separator at `serverSetup.ts:337`) → `--socket-path` into a nonexistent dir. `New-Item -ItemType Directory`.
- `:78-87` — `Invoke-RestMethod -TimeoutSec 20` bounds the whole ~50MB transfer in Windows PowerShell and errors are uncaught. Raise/remove timeout + try/catch into the marker path.

### `src/serverSetup.ts`
- `:295-321` — option strings (`customInstallPath`, URLs) spliced verbatim into double-quoted bash assignments → spaces break everything; `"`/`` ` ``/`$( )` execute remotely. Shell-escape at template time (single-quote + `'\''` escaping helper) — CLAUDE.md injection guardrail.
- `:17` — `compileTemplate` uses raw `value` as `String.replace` replacement → `$&`/`$$` corrupt output. Replacer function `() => value`.
- `:285-289` — `parseServerInstallOutput` splits on `'=='` keeping 2 fields → values containing `==` truncated; blank lines produce bogus entries. Limit-aware parse (`^(\w+)==(.*)==$`-style).

### `src/fetchRelease.ts`
- `:61-69` — response used without `response.ok` (rate-limit 403 object → `data.map` TypeError → generic log) and without pagination (>30 releases → `closest` misses → malformed fallback URL). Check `ok`, `?per_page=100`, distinguish rate-limit in log.
- `:89-92` — pinned match compares `` `${r.version}${r.build}` `` (no separator) → real pre-1.99 pins like `1.96.4.25026` never match. Compare via `splitRelease(objective)` fields.
- `:75` — `semver.valid('1.112.0-')`/leading-zero builds → legit releases filtered out of `latest`. Sort on `(version, Number(build))` comparator instead.
- `:54` — `console.info` instead of injected logger → diagnostic invisible. `logger.info`.
- `:61` — fetch with no timeout → connect hangs minutes on stalled network. `AbortSignal.timeout(...)`.

### `src/serverConfig.ts`
- `:34` — raw setting strings unvalidated (`ServerVersion` union collapses to `string`; typo'd `serverValidation` silently ≈ strict). Normalize/validate against allowed literals, log unknowns.

## Steps
1. TDD the TS pure logic: `compileTemplate` replacement-pattern hazard, `parseServerInstallOutput`, `splitRelease` + release selection (stubbed `fetch`), pinned-version match, serverConfig validation, escaping helper.
2. Fix `server-setup.sh` (quote-audit the whole file once, `shellcheck` it if available — but keep the diff reviewable).
3. Fix `server-setup.ps1` parity items.
4. `generateBashInstallScript` tests: no `%%…%%` placeholder survives; `customInstallPath` with space/`$&` round-trips escaped.

## Tests (write first — TDD)
- `compileTemplate`: plain, multi-occurrence, value containing `$&`/`$$` → verbatim output.
- `parseServerInstallOutput`: missing start/end marker → undefined; `key==value` ok; value containing `==` preserved; blank lines skipped.
- `splitRelease`: `1.96.4.25026`→`{1.96.4, 25026}`; `1.112.02593`→`{1.112.0, 2593}`; `1.112.0`→empty build; `nightly`→fallback.
- Release selection (stub fetch): non-ok → fallback + log; pinned `1.96.4.25026` → exact release found; empty-build release survives `latest`.
- Script templating: escaped install path with space/quote appears single-quoted in output; no remaining `%%KEY%%`.
- `serverConfig`: `'Skip'` → warning + strict; valid literals pass.
- Commands: `npm test`, `npm run compile:src`, `npm run lint`. Shell: `bash -n src/scripts/server-setup.sh` (+ `shellcheck` if installed).

## Verify
- Unit green; tsc/lint/bundle clean.
- F5/EDH: fresh connect installs the server (happy path unregressed); install path containing a space works end-to-end; wrong `serverDownloadUrlTemplate` → *download* error surfaced, not extract error.

## Done when
- No unquoted path expansion remains in `server-setup.sh`; .ps1 always emits markers and never reports success without a listening address; interpolated values are shell-escaped at template time; release pinning matches real release names.
