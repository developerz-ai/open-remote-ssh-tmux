# 01 — tmux layer invariants

> Part of [`overview.md`](overview.md). Depends on: none.

## Files to change
- `src/tmux/tmuxSession.ts:177-184` — `buildHasSession`/`buildKillSession` use raw `-t <name>`; tmux falls back to *prefix* matching → `code-<hash>-1` resolves to `code-<hash>-10`. Use exact-match `-t =<name>` (≥ tmux 2.6, our floor) here and in chained `set-option -t` targets.
- `src/tmux/tmuxSession.ts:233-236` + `src/tmux/sessionReaper.ts:96-116` — `shouldReap` requires `windows === 0`, unreachable (tmux destroys a session with its last window) → reaper is a no-op; a `remain-on-exit` dead-pane session is adopted and shows "Pane is dead" (UX leak). Detect real corpse states (`#{pane_dead}` in list format) or delete the backstop honestly.
- `src/tmux/tmuxSession.ts:117-137` — `buildAttachOrCreate` (shell-string form) has no production caller; second escaping-sensitive surface. Delete (tests move to the argv builder).
- `src/tmux/terminalProvider.ts:138-147` — restore loop re-attaches mapped sessions checking existence only, not attachment → after hand-off, PC re-attaches the session the laptop holds → mirrored keystrokes. The `remote` snapshot at `:134` already carries `attached`; skip mapped slots with `attached === true`.
- `src/tmux/terminalProvider.ts:133-167,175-184,251` — `initialize()` fire-and-forget races `provideTerminalProfile`; `allocateSlot` ignores `this.mapping` → duplicate mirrored tab on slot 0. Expose an `initialized: Promise<void>`; `provideTerminalProfile` awaits it; reserve mapped slots before the first `await`.
- `src/tmux/terminalProvider.ts:176-179,251-257` — no-steal guard is TOCTOU (stale `list-sessions` snapshot). Shrink: re-probe (`refreshRemote` or `has-session`) immediately before returning the profile.
- `src/tmux/terminalProvider.ts:192-195,149-160` — user-closed terminal resurrected on every reload (mapping kept + adoption loop re-adopts). Tombstone the slot in workspaceState on explicit close; exclude tombstoned slots from restore *and* adoption; new-terminal allocation clears the tombstone.
- `src/tmux/terminalProvider.ts:286-289` — transient `list-sessions` failure clears `attachedRemoteSlots` → no-steal guard silently off. Retain last known snapshot on probe failure.
- `src/tmux/tmuxBootstrap.ts:35` + `src/tmux/terminalProvider.ts:86,270-271` — probe resolves tmux's absolute path then discards it; profile hardcodes `shellPath: 'tmux'` → non-login-PATH installs (nix, `~/.local/bin`) fail with a tmux-naming VS Code error. Capture path into `TmuxCapability`, thread through as `shellPath`.
- `src/tmux/tmuxBootstrap.ts:35` — `PROBE_COMMAND` is POSIX syntax; csh/tcsh login shells error → tmux silently off. Wrap `sh -c '…'`.

## Steps
1. TDD the builders: `-t =` exact-match in `buildHasSession`/`buildKillSession`/set-option targets; delete `buildAttachOrCreate` + its tests (port relevant escaping cases to the argv builder's tests).
2. TDD + fix `shouldReap` (or remove backstop — decide per `overview.md` risks; default: detect `pane_dead`). Keep `sessionReaper.ts` consuming the new predicate.
3. `TmuxCapability` gains `path`; `tmuxBootstrap` parses first `command -v` stdout line; probe wrapped in `sh -c`. Provider uses `capability.path` for `shellPath`.
4. Provider: `initialized` promise + mapped-slot reservation; restore skips `attached` slots; pre-return re-probe; tombstone set on close / cleared on allocate; snapshot retention on probe failure.
5. Fix the test fake: `test/tmux/terminalProvider.test.ts:69` fake exec matches `has-session` via `includes` — mimics the prefix bug. Switch to exact-name matching so the `-t =` fix is actually asserted.

## Tests (write first — TDD)
- `tmuxSession`: `buildHasSession('a-1')` → args contain `-t`,`=a-1`; same for kill + set-option; no shell-string builder exported.
- `shouldReap`: dead-pane session → reap; live 1-window attached/detached → keep; (if kept) `windows === 0` case documented as unreachable.
- `terminalProvider`: mapped slot with `attached: true` in remote snapshot → `reopen` not called for it; `provideTerminalProfile` before `initialize()` resolves → does not hand out a mapped slot; closed slot → tombstoned, not restored, not adopted; new terminal on tombstoned slot → tombstone cleared; `refreshRemote` rejection → previous `attachedRemoteSlots` retained.
- `tmuxBootstrap`: probe output with path line → `capability.path` set; csh-style failure → unavailable, no throw.
- Commands: `npm test`, `npm run compile:src`, `npm run lint`.

## Verify
- Unit green; tsc/lint/bundle clean.
- F5/EDH: two windows on same host+workspace → second never mirrors first; disconnect→reconnect→same sessions; close a terminal → reload → it stays closed; no zombies in `tmux ls` afterwards; tmux never named in any user-visible error.

## Done when
- All four provider invariant behaviors (no-steal, no init race, tombstoned close, snapshot retention) unit-asserted; `-t =` everywhere a target is built; reaper predicate reachable or removed; probe path threaded to `shellPath`.
