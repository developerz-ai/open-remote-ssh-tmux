# 05 — package.json contributes & settings

> Part of [`overview.md`](overview.md). Depends on: 04 (route A/B decision).

## Files to change
- `package.json:89-186` — new configuration keys.
- `package.json:198-257` — new commands (minimal set).
- `package.json` contributes — `terminal.profiles` block (Route A only).

## Steps
1. Settings (add to the existing `remote.SSH.*` block — UX parity, keys stay
   in the upstream namespace):
   | Key | Type | Default | Purpose |
   |-----|------|---------|---------|
   | `remote.SSH.tmux.enabled` | `"auto" \| "on" \| "off"` enum | `"auto"` | auto = on when Unix+tmux found (03); off = pure upstream behaviour |
   | `remote.SSH.tmux.reapOnConnect` | boolean | `true` | run the 04 reaper at resolve time |
   | `remote.SSH.tmux.historyLimit` | number | `50000` | per-session scrollback (02 options) |
   Scope `application` like siblings (`package.json:92-186`). No setting that
   exposes raw tmux config — invisible UX; power users have their own tmux.
2. Commands (palette, `openremotessh.*` namespace):
   - `openremotessh.tmux.killWorkspaceSessions` — "Remote-SSH: Kill Persistent
     Terminal Sessions (this workspace)" — manual zombie escape hatch
     (`tmux-approach.md:70-73`). Confirmation dialog; delegates to reaper with
     force-this-workspace.
   - No other commands in v1 — the session-manager tree view
     (`tmux-approach.md:34-38`) is post-1.0; note in 07 docs as roadmap.
3. Route A: `contributes.terminal.profiles` entry titled like a normal shell
   (e.g. "Persistent Shell" — no "tmux" in the user-visible title) + provider
   id matching 04's registration. Check whether `contribTerminalProfiles`
   needs adding to `enabledApiProposals` (`package.json:432-435`) — stable API
   expected, verify against the engines version `^1.70.0` (`package.json`).
4. `commands.ts` — thin handler for the kill command, delegate to
   `sessionReaper` (pattern: `src/commands.ts:8-66`).
5. When-clauses: kill command enabled only when `remoteName == ssh-remote`
   (mirror existing menus, `package.json:270-416`).

## Tests (write first — TDD)
- `test/package-manifest.test.ts` — load package.json, assert: tmux settings
  present with the exact defaults above; kill command declared and registered
  name matches the constant used in `commands.ts` (import the constant);
  every `contributes.commands` id has a corresponding `registerCommand` string
  in src (cheap drift guard, grep-style over `src/`).
- Reap-command handler: given a faked reaper, invokes with force flag after
  confirmation accepted; does nothing on cancel.
- Command: `npm test`, `npm run compile:src`, `npm run lint`.

## Verify
- Unit green; `npm run lint` includes `lint:package` (fixpack) — package.json
  key order preserved; `npm run bundle`; EDH: settings visible in Settings UI
  under Remote-SSH, enum works, `"off"` restores stock terminals.

## Done when
- Feature togglable end-to-end via `remote.SSH.tmux.enabled`; kill command
  works and is the only tmux-adjacent UI text (and doesn't say "tmux").
