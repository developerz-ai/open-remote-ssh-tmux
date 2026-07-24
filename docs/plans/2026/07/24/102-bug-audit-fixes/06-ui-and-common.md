# 06 — UI, common utilities, manifest hygiene

> Part of [`overview.md`](overview.md). Depends on: none (upstream + fork files; small diffs).

## Files to change
- `src/remoteLocationHistory.ts:47` — `workspaceFolders?.[0].uri` throws on an **empty** folder array (optional chain doesn't guard `[0]`) → `activate()` dies → zero commands registered ("command not found" everywhere). `?.[0]?.uri`.
- `src/remoteLocationHistory.ts:12,19-36` — state loaded once, written whole → two windows clobber each other; unbounded growth; malformed stored value → `element.locations.map` throws, tree breaks. Re-read `globalState` before mutating; validate/normalize shape; cap length (e.g. 20/host).
- `src/remoteLocationHistory.ts:41,48` — `startsWith('ssh-remote')` also matches `ssh-remote2+…`; `split('+')` breaks on `+` in payload. Match `REMOTE_SSH_AUTHORITY + '+'`; split on first `'+'` only.
- `src/common/logger.ts:33-38` — `now()` mixes UTC hours with **local** minutes (wrong in +5:30 zones) and doesn't pad ms. All-UTC getters + `padLeft(ms, 3, '0')`.
- `src/common/files.ts:15-17` — `untildify` uses `homeDir` as replacement string → `$` sequences corrupt (Windows usernames with `$`). Replacer fn: `path.replace(/^~(?=$|\/|\\)/, () => homeDir)`.
- `src/common/ports.ts:23-118` — `findFreePort`/`findFreePortFaster` are dead code (only `findRandomPort` used — `authResolver.ts:314,378`) and both buggy (timeout doesn't stop probing; `removeAllListeners` before `close` → queued `'error'` crashes host). **Delete both** ("delete before you abstract"); handle `findRandomPort`'s inherent TOCTOU by handling the tunnel `listen` failure at the call sites (04 covers the socket error handlers).
- `src/commands.ts:17` (+ `src/hostTreeView.ts:97,102`) — prompt accepts `[user@]hostname[:port]` but passes the raw string to `new SSHDestination(host)` (never parsed). Use `SSHDestination.parse(host)` at the input boundary + validate.
- `src/commands.ts:127-128` — `killWorkspaceSessions` unhandled rejection after a destructive confirm → generic error, unknown outcome. try/catch + specific message (no tmux jargon).
- `package.json:18` — `"browser"` field points the web-extension entry at the Node-only bundle. Drop it.
- `package.json:83-90,252` — `onCommand:openremotessh.tmux.killWorkspaceSessions` missing from `activationEvents` while `engines.vscode ^1.70.2` predates implicit events → palette invocation fails pre-1.74. Add it (or bump engine — align with the 02 decision on `onTerminalProfile`).

## Steps
1. TDD `remoteLocationHistory` (fake-Memento pattern from `test/tmux/terminalProvider.test.ts`): dedupe + MRU order, removal, malformed state normalized, cap, foreign-authority ignored.
2. TDD `logger.now` (fixed `Date`), `files.untildify`, boundary parse in `commands`.
3. Delete dead port finders + their imports; keep `findRandomPort` tests.
4. Manifest edits (`browser`, activation events) — extend `test/package-manifest.test.ts` guards accordingly.

## Tests (write first — TDD)
- `remoteLocationHistory`: add existing → moved to front, no dup; malformed `{host: 'notarray'}` → normalized empty; >cap entries → trimmed; authority `ssh-remote2+x` → not recorded.
- `logger.now`: `Date(…T23:59:59.007Z)` in a +5:30 zone-mocked env → `23:59:59.007`.
- `untildify`: home containing `$&` → literal; `~/x`, `~`, `~user/x` (unchanged) cases.
- `commands`: input `user@host:2222` → destination `{user, hostname, port}` parsed.
- Manifest: every contributed command has an activation event (guard, see 07); no `browser` key.
- Commands: `npm test`, `npm run compile:src`, `npm run lint`.

## Verify
- Unit green; tsc/lint/bundle clean.
- F5/EDH: open a zero-folder `.code-workspace` → extension activates, commands present, SSH Targets tree renders.

## Done when
- Activation can't throw from history parsing; dead port code gone; all palette commands activate on ^1.70.2; history state survives two concurrent windows without data loss (re-read-before-write in place).
