# 03 — Hand-off: ownership, no eviction, no 3 h block

> Part of [`overview.md`](overview.md). Depends on: 01, 02.

Two defects in the headline feature, both `[V]`:
- **Eviction.** `decideSlotAction` treats `mapped && attached` as "our own stale pty" and returns
  `restore-takeover` (`-A -D`) (`src/tmux/slotState.ts:100-104`). Premise (`:13-18`: mapping is
  client-local so nothing foreign can be in it) breaks after adoption: PC maps slot 0, laptop
  adopts slot 0 (`src/tmux/terminalProvider.ts:463-469`), PC's mapping is never cleared → PC
  reconnect evicts the laptop's live client; ping-pong on every reload. Same for two windows of
  one machine with separate `workspaceState` on the same first folder.
- **3 h block.** A closed/slept PC window keeps its pty + tmux client attached for
  `VSCODE_RECONNECTION_GRACE_TIME`; the laptop sees `unmapped && attached` → skip
  (`slotState.ts:110-114`). Acceptance row 20 passed only after a manual `tmux detach-client`
  (`docs/plans/2026/07/24/101-v1-tmux-release/results-2026-07-24.md`, row 20).

## Design (recommended; policy is an owner decision — see overview Risks)
- **Client id.** Stable per-install id: first 8 hex of sha1(`vscode.env.machineId`), plus a
  per-window nonce kept in `workspaceState`. Never the raw machineId on the remote.
- **Owner tag.** Each attach appends `set-option -t =<name>: @orst_owner <clientId>` to the argv
  chain; `list-sessions -F` gains `#{@orst_owner}`. (User options: confirm minimum tmux version
  on the rig; below it, owner = unknown.)
- **Decision input** gains `owner: 'me' | 'other' | 'unknown'` and
  `foreignClientStale: boolean`; `mapped` stops implying ownership.

| openHere | attached | owner | stale | action |
|---|---|---|---|---|
| yes | – | – | – | skip |
| no | no | any | – | restore (mapped) / adopt (unmapped) |
| no | yes | me | – | restore-takeover (own zombie pty) |
| no | yes | other/unknown | yes | handoff-takeover |
| no | yes | other/unknown | no | per `handOff` setting: `auto`→notify+offer, `ask`→offer, `never`→skip |

- **Staleness** = explicit detach marker OR client idle beyond threshold: one
  `list-clients -F '#{client_session} #{client_activity}'` in the reconcile batch (slice 02).
  Threshold constant (recommend 120 s); keystrokes/output on a live window keep it fresh — verify
  on the rig what updates `client_activity`.
- **Explicit detach on window close.** Best effort in `deactivate` / on close reason
  shutdown: `detach-client -s =<name>` for this window's slots under a short deadline. Removes the
  3 h block for clean closes; staleness covers sleep/crash.
- **Offer UI** (only for a live foreign client): one non-modal notification, no tmux wording —
  "This workspace's terminals are open on another machine." [Take over] [Not now]. Take over →
  `-A -D`. Never automatic `-D` against a fresh foreign client.
- **Mapping hygiene.** After a hand-off away from us (owner becomes other), drop the slot from our
  mapping on next reconcile so stale mappings cannot accumulate.

## Files to change
- `src/tmux/slotState.ts:28-123` — new inputs, new action `handoff-takeover` / `offer`, rewrite
  the header comment (`:1-24`) and fix `:31` ("zero windows = corpse", contradicted by `:115-121`).
- `src/tmux/tmuxSession.ts:167-259` — owner tag in argv; `:270-291` list format + `TmuxSession`
  field; `buildListClientsCommand`, `buildDetachClientCommand`, `parseListClients`.
- `src/tmux/clientIdentity.ts` (new) — pure id derivation (hash + nonce).
- `src/tmux/terminalProvider.ts:408-495` (`plan`), `:463-469` (adopt), `:717-741`
  (`handleTerminalClosed`), `:799-817` (`buildOptions`) — gather inputs, act on new actions, expose
  `detachAll()`.
- `src/extension.ts` — pass client id; `deactivate` calls `detachAll()`; notification wiring
  (thin; text + buttons only).
- `package.json` `contributes.configuration` — `remote.SSH.tmux.handOff` enum
  (`auto | ask | never`, default per owner decision); `test/package-manifest.test.ts` guard.

## Steps
1. Rig first: measure `client_activity` semantics, user-option minimum version, `-D` effect on a
   foreign client's pty (exit status VS Code sees). Record in `status.yml` notes.
2. Pure logic + tests (`slotState`, builders, parsers, `clientIdentity`).
3. Provider wiring; then `deactivate` detach; then notification.
4. Evicted side: when our client is detached by another machine, the terminal tab closes with a
   non-user reason → must not kill the session, must not auto-reattach (no ping-pong); log one
   Info line. Add a unit test on `handleTerminalClosed` for this.

## Tests (write first — TDD)
- `test/tmux/slotState.test.ts` — full table above, one case per row; explicit regression:
  `mapped, attached, owner=other, stale=false` ≠ takeover.
- `test/tmux/tmuxSession.test.ts` — owner tag in argv after `new-session`; list parse with and
  without owner field (old sessions → unknown); list-clients parse; detach builder uses `=` target.
- `test/tmux/clientIdentity.test.ts` — deterministic, raw machineId never in output.
- `test/tmux/terminalProvider.test.ts` — adoption then original owner reconnects → no `-D`;
  mapping dropped after foreign take-over; `detachAll` issues one command per open slot; evicted
  close does not kill.
- `test/extension.wiring.test.ts` — `handOff` setting read + default.
- Rig: slice-01 `it.fails` (03) flip to passing — live foreign client survives; SIGKILLed client's
  session handed off with no manual detach.
Commands: `npm run compile:src`, `npm run lint`, `npm test`, `npm run test:tmux`.

## Verify
- F5 with two clients (two EDH profiles or PC + laptop): work on A, close A's window, open B →
  same sessions within seconds; A reopened → gets offered take-over, B untouched until accepted.
- Kill A's network (no clean close) → B takes over after the staleness threshold, no prompt in
  `auto`.
- Zombie rows 6-9 re-run.

## Done when
- No code path issues `-D` against a client whose owner tag is not ours unless stale or
  user-accepted.
- Acceptance rows 3, 20, 21 pass with zero manual tmux commands.
