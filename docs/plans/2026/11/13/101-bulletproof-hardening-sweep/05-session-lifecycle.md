# 05 — Session lifecycle: orphans, settings, identity, races, server lifetime

> Part of [`overview.md`](overview.md). Depends on: 02, 03.

## Findings
| # | Finding | Where | Ev. |
|---|---|---|---|
| a | Reaper is inert: `shouldReap` needs `paneDead`, but sessions use `remain-on-exit off` → never dead-paned. Detached live sessions no client maps are never aged out or counted (promised in `docs/idea/tmux-approach.md:159-161`). Live example: `code-7d6c49c69396-0` detached on the remote | `src/tmux/tmuxSession.ts:344-359,206`, `src/tmux/sessionReaper.ts:97-117` | V |
| b | No `onDidChangeConfiguration` for `remote.SSH.tmux.*`; settings read once. `enabled: off` + reload → existing `code-*` sessions run unseen forever. Reconnect path ignores `historyLimit`/`reapOnConnect` changes | `src/extension.ts:159,313-322` | V |
| c | Identity = SSH alias as typed + raw path: `myvps` vs IP vs `myvps.lan`, trailing slash, symlink → different hash → hand-off silently never matches; renamed folder strands sessions | `src/extension.ts:613-637`, `tmuxSession.ts:109-151` | V |
| d | Overlapping `initialize()` (reconnect inside the ~12 s revive window): second `plan()` clears `pendingRestores`, first `.finally` clears the second's `reservedSlots` → duplicate slots (the 1.0.8/1.0.9 bug class). Only sequential calls tested | `src/tmux/terminalProvider.ts:316-335,411,333`, `src/extension.ts:318` | V logic |
| e | Slot leak: `persist()` rejecting in `provideTerminalProfile` leaves the slot in `openSlots`; rejection surfaces as failed terminal open | `terminalProvider.ts:567-602` | V |
| f | Revive is timing-driven (2.5 s + 10 s / 2 s quiet); field log shows the fallback firing | `terminalProvider.ts:353-399` | V |
| g | Close reason: VS Code < 1.7x has no `exitStatus.reason` → user close never kills; log line says "session kept" on shell exit when the session is gone | `terminalProvider.ts:717-741,957-977` | V |
| h | Only `workspaceFolders[0]`, captured once; multi-root edits leave it stale; empty window gets no tmux layer | `extension.ts:187-193,636` | V (by design) |
| i | Splits: if VS Code clones parent `shellArgs` without calling the provider, `handleTerminalOpened` disposes the split as a duplicate | `terminalProvider.ts:683-704` | S |
| j | `SSH_AUTH_SOCK` (and `VSCODE_IPC_HOOK_CLI`) go stale inside long-lived sessions after reconnect | `src/common/envCollection.ts`, tmux `update-environment` | V |
| k | tmux server lives in the SSH login scope (`session-N.scope`), `Linger=no`; hosts with logind `KillUserProcesses=yes` kill every terminal on disconnect, silently | live remote state | V observed / S impact |
| l | Two machines opening a new terminal simultaneously pick the same lowest slot → mirrored | `terminalProvider.ts:584-592,762-773` | S (acknowledged in code) |

## Files to change
- `src/tmux/tmuxSession.ts` — `shouldReap`: add orphan rule (ours by name, detached, no owner
  activity for `orphanMaxAgeDays`, using `#{session_activity}`); keep "never touch attached / never
  touch foreign names". `canonicalHostKey`, `canonicalWorkspaceKey` (strip trailing `/`,
  collapse `//`; host = resolved `HostName` + user + port).
- `src/tmux/sessionReaper.ts` — report `{killed, orphansKept, orphansTotal}`; injected clock
  already present.
- `src/tmux/terminalProvider.ts` — single-flight `initialize` (generation counter: a superseded
  plan may not clear state it does not own; revive window survives a `refresh`); try/finally
  around slot claim; `reason === undefined` path; honest close log wording; `dispose()` releases
  all listeners.
- `src/tmux/settingsWatcher.ts` (new) — decides, pure: given old/new `TmuxSettings`
  (`src/extension.ts:438`), return `rewire | refresh | offer-cleanup | none`.
- `src/extension.ts` — subscribe `onDidChangeConfiguration('remote.SSH.tmux')`; on
  `enabled → off`: one notification "N background terminals from this workspace are still
  running" [Close them] [Keep] (reuses kill-workspace-sessions command); session context
  recomputed on `onDidChangeWorkspaceFolders`; reconnect path re-reads settings.
- `src/tmux/tmuxBootstrap.ts` — extend probe output with server-lifetime facts
  (`loginctl show-user -p Linger`, logind `KillUserProcesses`) → `lifetimeRisk: boolean`;
  one-time, dismissible warning with a docs link when true. No wrapper (overview Risks).
- `src/tmux/tmuxSession.ts` argv — `update-environment` additions / `set-environment` refresh for
  `SSH_AUTH_SOCK` on attach (new panes only; document that running shells keep the old value) or
  stable-symlink approach if rig shows it is clean.
- `package.json` configuration — `remote.SSH.tmux.orphanMaxAgeDays` (default 14, 0 = never);
  manifest test.
- Identity migration: on first reconcile after upgrade, also look up sessions under the legacy
  hash and adopt them into the canonical name (`rename-session`), so no upgrade strands work.

## Steps
1. (d)(e) first — pure provider races, unit-testable with deferred promises.
2. (a) orphan aging + count; reaper returns numbers; connect-time Info line
   `tmux housekeeping: K killed, O old sessions kept`.
3. (c) canonical keys + legacy migration; rig test with alias/IP/trailing-slash variants.
4. (b) settings watcher + off-mode cleanup offer.
5. (g)(h) small fixes; (f) keep heuristic but make both waits named constants and add a test for
   reconnect-during-revive; do not invent a new mechanism.
6. (i)(l) reproduce in F5/rig; fix only if reproduced ((l): atomic claim via
   `new-session -d -s` without `-A` as a lock, fall through to next slot on "duplicate session").
7. (j)(k) rig investigation → implement the minimal confirmed fix; else document.

## Tests (write first — TDD)
- `test/tmux/tmuxSession.test.ts` — `shouldReap` orphan table: attached never; foreign name
  never; detached + active within N days never; detached + idle > N → yes; `0` disables.
  Canonical keys: alias/IP resolve equal, trailing slash equal, different user/port differ.
- `test/tmux/sessionReaper.test.ts` — counts; clock injected; kill failures not counted (slice 02).
- `test/tmux/terminalProvider.test.ts` — two overlapping `initialize` calls (deferred exec):
  no slot minted twice, restore queue intact; `persist` rejection frees the slot and resolves a
  usable profile; undefined close reason treated as non-user close; legacy-hash sessions adopted
  + renamed once.
- `test/tmux/settingsWatcher.test.ts` — full decision table.
- `test/extension.wiring.test.ts` — watcher subscribed/disposed; workspace-folder change
  recomputes context.
- `test/tmux/tmuxBootstrap.test.ts` — lifetime-risk parse (yes/no/unknown/non-systemd).
- Rig: orphan aged out with faked activity time; alias vs IP attaches the same session;
  KillUserProcesses container variant detected.
Commands: `npm run compile:src`, `npm run lint`, `npm test`, `npm run test:tmux`.

## Verify
- F5: toggle `remote.SSH.tmux.enabled` off → offer appears, accepting leaves `tmux ls` clean;
  back on without reload → new terminals are tmux again.
- Reconnect storm (kill sshd child 3× inside 10 s) → tab count == session count, no duplicates.
- Zombie rows 6-9 re-run; `tmux ls` on the rig after the full matrix shows only expected sessions.

## Done when
- No code path leaves a `code-*` session that nothing will ever list, restore, adopt, or age out.
- Changing any `remote.SSH.tmux.*` setting has a defined, tested effect without reload.
- Same folder reached via different aliases resolves to the same sessions.
