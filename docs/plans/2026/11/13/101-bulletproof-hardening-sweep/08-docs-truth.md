# 08 — Docs match the code; upstream-sync procedure

> Part of [`overview.md`](overview.md). Depends on: 02-07 (documents what they shipped).

Docs-only slice. No unit tests; guard tests listed below keep it from drifting again.

## Files to change
| File | Stale / wrong `[V]` | Fix |
|---|---|---|
| `CLAUDE.md:31-32` | "`ssh2` auth (`src/authResolver.ts`, `src/ssh/*`) is unchanged" — 19 upstream files changed, `authResolver.ts` ~808 lines | State what diverged (host verifier, teardown, probe, env diff, loopback bind, deadlines) |
| `CLAUDE.md` (tmux bullet) | "Neutralise VS Code's own persistent-terminal layer" — code is deliberately non-transient (`src/tmux/terminalProvider.ts:808-815`) | Describe the real model: VS Code restores tabs, tmux owns process lifetime |
| `CLAUDE.md` Git section | allowed types omit `chore` though `commitlint.config.js` allows it | Align one way (prefer removing `chore` from config; add policy test) |
| `CLAUDE.md` arch table | new modules from this plan (`common/deadline`, `tmux/remoteExec`, `tmux/clientIdentity`, `tmux/settingsWatcher`) | Add rows |
| `docs/idea/ai-first.md:18,50,58-69,118-126` | "140+ tests", "377/377", EDH "cannot be run", `/plan` command, CI "partial", publish "manual" | Rewrite to current state; point at the rig |
| `docs/idea/persistence-model.md:47,99-104` | "Shipped" vs "implemented-but-unproven" | One truthful status; add: remote reboot = sessions gone (tmux has no resurrection); `KillUserProcesses` caveat; hand-off semantics from slice 03 |
| `docs/idea/tmux-approach.md:159-161,188-189` | promises age-prune + count (now real, slice 05); server-wide writes | Update; list exactly which server-scope options/bindings we touch and when |
| `docs/plans/2026/07/24/101-v1-tmux-release/results-2026-07-24.md` row 9, 10, 20 | cites `isTransient: true`; predates mouse/clipboard/keys; manual detach | Do not rewrite history — add a dated "superseded by `results-<new>.md`" banner |
| `docs/plans/2026/07/24/102-bug-audit-fixes/status.yml` | `complete/100` with `edh_matrix_rows: partial` | Note pointing at this plan's 09 |
| `README.md:37,360` | "only releases v1.0.0 and v1.1.0"; Open VSX statement | Correct; add Requirements (tmux ≥ floor, Unix remote), Known limitations, Security section (loopback listeners, what is logged, unverified server download) |
| `.claude/commands/feature.md:11,20,24` | "~2.3k LOC", "publishes to VS Marketplace" | Correct; add `npm run test:tmux` to its verify step |
| `.claude/commands/planx.md` | Verify step lacks the rig | Add |
| `CONTRIBUTING.md:43`, `.github/workflows/issue-triage` refs | link to upstream jeanp413 issues | Point at this repo |
| `CHANGELOG.md` | — | Entries per slice; slice 06 (a) under **Security** |

- `docs/upstream-sync.md` (new) — procedure: add `upstream` remote
  (`jeanp413/open-remote-ssh`), fork point `a00e61a`, list of upstream-owned files and our hunks
  in each (generated: `git diff a00e61a --stat -- src ':!src/tmux' ':!src/clipboard'`), merge
  cadence, how to re-run `scripts/patch-ssh2.js` checks, never use GitHub "sync fork → discard"
  (incident noted at `.github/workflows/ci-main.yml:46-52`).
- `docs/troubleshooting.md` (new) — reading the `Remote - SSH` output channel: the
  `tmux slot N: … -> action (reason)` line, housekeeping line, hand-off notification, how to list
  and kill sessions by hand, where logs live (`~/.local/state/VSCodium/…`, `~/.config/Code/logs/…`).

## Steps
1. Apply table top to bottom; every claim checked against code at time of writing.
2. Generate the upstream-diff inventory; commit as part of `upstream-sync.md`.
3. Add guard tests.

## Tests (write first — TDD)
- `test/docs.test.ts` (new) — every `src/...` path mentioned in the CLAUDE.md architecture table
  exists, and every `src/**/*.ts` module appears in it; README's stated tmux floor equals the
  constant in `src/tmux/tmuxBootstrap.ts`; README's settings list equals `package.json`
  `contributes.configuration` keys for `remote.SSH.tmux.*`.
- `test/commitlint-policy.test.ts` — allowed types equal the list in CLAUDE.md.
Commands: `npm test`, `npm run lint`.

## Verify
- `grep -rn "isTransient: true\|377/377\|140+ tests\|cannot be run" docs CLAUDE.md README.md`
  returns only the superseded results file.
- A fresh agent given only CLAUDE.md + `docs/idea` describes hand-off, reaping, and upstream
  divergence correctly (spot-check with one subagent).

## Done when
- No doc statement contradicts code; drift guarded by `test/docs.test.ts`.
- Upstream merges have a written, repeatable procedure.
