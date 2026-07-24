# 02 — wiring & settings

> Part of [`overview.md`](overview.md). Depends on: [`01-tmux-invariants.md`](01-tmux-invariants.md) (provider API: `initialized`, `capability.path`).

## Files to change
- `src/extension.ts:22,86-93,119` — reconnect re-fires `onResolveSuccess` → second `TmuxTerminalProvider` constructed, `registerTerminalProfileProvider` throws "already registered" (swallowed at `:162`), surviving provider's `exec` closure captures the **dead** pre-reconnect `SSHConnection` → every new terminal fails post-reconnect. Make `exec` resolve the connection lazily (`resolver.getSSHConnection()` at call time) and wiring idempotent: wire once; on re-resolve refresh provider state + re-run reaper only.
- `src/extension.ts:106` + `package.json:205-211` — `remote.SSH.tmux.historyLimit` declared, never read (literal `// historyLimit: read from settings if available (PR5)` comment). Read it in `wireTmuxTerminalLayer`, pass to provider.
- `src/extension.ts:141-151` + `package.json:212-217` — `remote.SSH.tmux.reapOnConnect` declared, never read; reaper runs unconditionally. Gate `reaper.reap()` on it.
- `src/extension.ts:58-72` + `package.json:189-204` — `tmux.enabled: 'on'` ("fail if unavailable") unimplemented: capability gate returns before the setting is read. Read setting first; on `'on'` + unavailable → user-visible error notification (generic wording, no tmux internals beyond naming the requirement).
- `src/extension.ts:181-193` — `setDefaultTerminalProfileIfUnset` checks only `workspaceValue` → clobbers a User/Remote-scope default; written setting never cleaned up when tmux is off/unavailable → default points at an unregistered profile. Inspect `globalValue` + remote value too; remove/skip the workspace write when the tmux layer isn't wired.
- `src/extension.ts:202-207` — `currentTmuxSessionContext` uses `vscode.env.remoteName` (always `'ssh-remote'`) as `hostKey` → session identity keyed to workspace only, not host+workspace as `tmuxSession.ts` design intends; `|| '/home/user'` cwd fallback is a fabricated path. Derive host from the resolved authority (parse `SSHDestination` from it); use remote home (available from connection env) as cwd fallback.
- `package.json:307-314,83-90` — `tmux` terminal profile contributed unconditionally but provider only registered after successful resolve → "Persistent Shell" errors in local windows / tmux-less remotes / `'off'` (visible leak). Plus no `onTerminalProfile:tmux` activation event while `engines.vscode: ^1.70.2` predates implicit events. Add the activation event, and register a graceful fallback provider (plain default shell, no tmux) whenever the tmux path is unavailable in a remote window; document local-window behavior.

## Steps
1. Replace the placeholder `test/extension.wiring.test.ts` (currently `expect(true).toBe(true)`) with real tests below — extend `test/mocks/vscode.ts` with `inspect`/`update` recorders on config.
2. Refactor `wireTmuxTerminalLayer` for idempotency + lazy connection; keep DI style (`extension.ts` constructs collaborators, no logic beyond wiring).
3. Wire the three settings (`historyLimit`, `reapOnConnect`, `enabled: 'on'`).
4. Fix `setDefaultTerminalProfileIfUnset` scope inspection + cleanup path.
5. Fix `currentTmuxSessionContext` host/cwd derivation.
6. Manifest: activation event + fallback provider registration path.

## Tests (write first — TDD)
- Wiring: capability `{available:false}` → no `registerTerminalProfileProvider`; `enabled:'off'` + available → not wired; `'on'` + unavailable → error surfaced; second resolve-success → no second registration, provider refreshed (spy on refresh, not constructor).
- Lazy exec: swap the resolver's connection between two exec calls → second call uses the new connection.
- Settings: `historyLimit: 1000` → provider receives 1000; `reapOnConnect: false` → `reap()` not called.
- Default-profile: `workspaceValue` set → no update; `globalValue` set → no update; nothing set → one workspace-scope update to `'Persistent Shell'`; tmux unavailable → no write (and stale write removed).
- Context: authority `ssh-remote+<hex>` → hostKey = parsed hostname, not `'ssh-remote'`.
- Commands: `npm test`, `npm run compile:src`, `npm run lint`.

## Verify
- Unit green; tsc/lint/bundle clean.
- F5/EDH: connect → kill network → reconnect → **new terminal works** (the #3 headline bug); local window: pick "Persistent Shell" → no error; remote without tmux: profile falls back to plain shell silently.

## Done when
- Post-reconnect terminal creation proven in EDH; all three settings observably effective; drift guard from `07` will pass for every `remote.SSH.tmux.*` key; no scope-clobbering of user defaults.
