# 04 — Terminal provider, restore mapping, reaping

> Part of [`overview.md`](overview.md). Depends on: 02, 03. The user-facing
> slice — both invariants (invisible, no zombies) live or die here.

## Files to change
- `src/tmux/terminalProvider.ts` (new) — VS Code terminal wiring: profile
  provider, slot allocation, restore-time re-attach, dedupe.
- `src/tmux/sessionReaper.ts` (new) — connect-time housekeeping over
  `SSHConnection#exec` using 02's builders/parsers.
- `src/extension.ts:8-30` — construct + register the tmux collaborators
  (wiring only, follow existing pattern).
- `test/tmux/terminalProvider.test.ts`, `test/tmux/sessionReaper.test.ts`.

## Steps
0. **SPIKE FIRST (½ day, throwaway)**: in the EDH, register a minimal
   `window.registerTerminalProfileProvider` returning
   `{options: {shellPath: 'tmux', shellArgs: ['new-session','-A','-s','spike']}}`
   while a remote window is open. Confirm the process spawns **on the remote**
   (the extension is `extensionKind: ["ui"]`, `package.json:436` — this is the
   plan's biggest assumption). If it spawns locally, switch to Route B below
   and record the decision in `docs/idea/tmux-approach.md`.
   - Route A (preferred): profile provider, `contributes.terminal.profiles`
     (05) — works with profile UX, no settings mutation.
   - Route B (fallback): write `terminal.integrated.defaultProfile.linux` +
     `profiles.linux` into **remote machine settings** on the resolved host
     (invisible: our profile named "bash"-like, not "tmux"), via the
     server-side Machine settings file. More invasive — only if A fails.
1. **Slot allocation — remote-aware** (`terminalProvider.ts`): a *new*
   terminal takes the lowest slot that is (a) not open in this window and
   (b) not a **live session on the remote** (from the connect-time
   `list-sessions` snapshot, refreshed on create). This is what stops a second
   client (laptop while PC is attached) from `-A`-attaching into the PC's
   slot-0 session — it lands on a fresh slot instead. Session =
   `sessionName(hostKey, workspaceKey, slot)` (02). Profile returns shellPath
   `tmux`, shellArgs from `buildAttachOrCreate` args (argv form — no shell
   string, no injection surface). cwd = workspace folder.
2. **Restore mapping — per client** (`tmux-approach.md:60-63`): persist
   `slot → sessionName` in `context.workspaceState` (pattern:
   `src/remoteLocationHistory.ts`; workspaceState is client-local, which is
   exactly the semantics wanted). On window reload: each mapped slot whose
   session still exists (`buildHasSession` via exec) re-attaches by name via
   `-A`; dead mappings pruned.
2b. **Adoption (multi-client / hand-off)**: after re-attaching mapped slots,
   list this workspace's `code-<hash>-*` sessions; any session that is live,
   **detached** (`session_attached == 0`), and unmapped is *adopted* — open a
   terminal attached to it and add it to the mapping. Sessions attached by
   another client are left untouched (no stealing, no mirror-attach in v1).
   Covers both: hand-off (PC closed → laptop adopts PC's sessions) and
   reconciliation (PC reconnects → its mapped ones + the laptop's orphan).
   Adoption count > 0 → nothing louder than a log line (invisible UX).
3. **Single persistence owner** (`tmux-approach.md:43-48`): VS Code's own
   revive would restore a *plain* shell copy of each terminal alongside our
   tmux one. Dedupe strategy, in order of preference — settle in the spike:
   (a) our profile terminals opt out of VS Code revive if the API allows
   (check `TerminalOptions.isTransient`, stable since 1.66 — expected
   sufficient); (b) else document `terminal.integrated.enablePersistentSessions
   : false` as a recommended remote setting in README + log hint. Do not
   silently mutate user settings.
4. **Terminal close** = detach/exit only. Never `kill-session` on close —
   close-PC/open-laptop is the core use case (`docs/idea/why.md`). Session
   death is the process exiting (`remain-on-exit off`, 02).
5. **Reaper** (`sessionReaper.ts`): on successful resolve (and on manual
   refresh), `list-sessions` → `parseListSessions` → `shouldReap` (02) →
   `kill-session` each. Log a one-line count when >0 reaped. Runs only when
   bootstrap said available. This closes the "empty session left when a
   terminal died mid-disconnect" hole.
6. **Wiring** (`extension.ts`): construct `TmuxTerminalProvider` +
   `SessionReaper` with injected `Log` + exec + clock; push disposables.
   Registration gated on the 03 capability + 05 setting. Zero logic in
   `extension.ts`.

## Tests (write first — TDD)
- Slot allocation: fresh window → slot 0; three terminals → 0,1,2; close 1,
  open new → reuses 1 (lowest free); slots stable across provider instances
  given same workspaceState; remote has live {0,1} and mapping empty (second
  client) → new terminal gets slot 2, never 0/1.
- Restore: workspaceState has slots {0,2}; `has-session` true for 0, false
  for 2 → slot 0 re-attaches (same name), slot 2 mapping pruned.
- Adoption: mapping {0}; remote sessions {0: detached, 1: detached,
  2: attached} → slot 0 re-attached, slot 1 adopted (terminal opened, mapping
  gains 1), slot 2 untouched; reaper never targets any of them (all live).
- Provider output: shellArgs exactly match 02 builder args; `isTransient`
  set; cwd = workspace path.
- Reaper: given list output with [ours-empty-detached, ours-attached,
  foreign], kills exactly ours-empty-detached; exec failure → logged, no
  throw, no kill storm.
- Use the `vscode` mock alias from 01 for `workspaceState`/window APIs.
- Command: `npm test`, `npm run compile:src`, `npm run lint`.

## Verify
- Unit green; tsc/lint/bundle clean.
- F5 EDH against a real Unix remote, full matrix:
  1. New terminal → prompt appears; `tmux ls` on remote shows one `code-*`.
  2. `sleep 999` → close window → reopen workspace → same terminal content,
     sleep still running, `tmux ls` still shows exactly one session.
  3. Kill vscode-server on remote → reconnect → terminal re-attaches.
  4. Open second terminal → second session; close it (exit shell) → session
     gone from `tmux ls` (no zombie).
  5. Repeat open/close ×5 → session count equals open-terminal count.
  6. Nothing tmux-branded visible: no status bar, terminal tab named like a
     shell, no tmux text in UI.

## Done when
- Full matrix above passes; upstream behaviour intact when feature off;
  no tmux string concat outside 02.
