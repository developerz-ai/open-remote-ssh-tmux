# 08 — verify

> Part of [`overview.md`](overview.md). Depends on: 01–07 complete.

## Gates (all clean)
```bash
npm test               # full vitest suite incl. new drift guards
npm run compile:src    # tsc strict
npm run lint           # eslint
npm run bundle         # webpack production
npm run package        # .vsix builds
bash -n src/scripts/server-setup.sh
```

## F5 / Extension Development Host acceptance matrix
Real SSH remote with tmux ≥ 2.6. Follow the standing matrix in
[`../101-v1-tmux-release/09-verify.md`](../101-v1-tmux-release/09-verify.md) for setup; rows below are the audit-specific additions.

| # | Scenario | Pass criteria |
|---|----------|---------------|
| 1 | First connect to unknown host | Fingerprint consent prompt; accept → connects; entry in known_hosts; reconnect → no prompt (03) |
| 2 | Tamper recorded host key, reconnect | Connection blocked, mismatch error, no bypass (03) |
| 3 | Connect, kill network, reconnect | Editing resumes AND **new terminal works** against live connection (02) |
| 4 | PC window + laptop window, same host+workspace | Second window never mirrors the first's terminal; typing isolated (01) |
| 5 | Close one terminal, reload window | Closed terminal stays closed; others restore to same sessions (01) |
| 6 | Re-open workspace repeatedly | `tmux ls` on remote: no zombies, no duplicates, session count == open terminals (01) |
| 7 | Terminal with long-running process, disconnect → reconnect | Process alive, scrollback intact, same session name (baseline regression) |
| 8 | `tmux.enabled: 'off'` / local window / remote without tmux | "Persistent Shell" never errors; plain shell fallback; no tmux wording anywhere (02) |
| 9 | `tmux.enabled: 'on'` on tmux-less remote | Clear error notification; base SSH session still usable (02) |
| 10 | `tmux.reapOnConnect: false`, `tmux.historyLimit: 1000` | Reaper skipped (log); new session has `history-limit 1000` (02) |
| 11 | `remote.SSH.serverInstallPath` containing a space | Server installs + connects; nothing written to `$HOME` root (05) |
| 12 | Bad `ProxyCommand` binary | Clean error dialog, extension host alive (04) |
| 13 | Zero-folder `.code-workspace` opened locally | Extension activates; commands + tree present (06) |
| 14 | Windows remote (if available) | Base SSH connect works; tmux features silently off; ps1 reports real errors with markers (05) |
| 15 | tmux only on login-shell PATH (e.g. `~/.local/bin`) | Terminal opens via resolved absolute path (01) |

Invisible-UX sweep during all rows: no tmux status bar, no tmux error text, no
session names leaked in UI; terminal titles look like normal shells.

## Done when
- All gates clean; matrix rows 1–13 pass (14–15 as environment allows, else noted in
  `status.yml` notes); results recorded in `status.yml` (`evidence`: commits/PR).
- This also discharges the standing empirical F5/EDH proof gap noted in `CLAUDE.md`
  (rows 3–7) — update `docs/idea/roadmap.md` if it still lists that gap as open.
