# 04 — tmux command-line hardening (argv chain, probe, invisibility)

> Part of [`overview.md`](overview.md). Depends on: 01, 02.

## Findings
| # | Finding | Where | Ev. |
|---|---|---|---|
| a | `historyLimit` unclamped → non-integer/negative/huge aborts the `;` chain before `new-session`; every terminal dies, likely showing tmux argv | `src/extension.ts:438`, `src/tmux/tmuxSession.ts:199`, manifest has only `minimum: 0` | V |
| b | `set-option -gu history-limit` resets to tmux built-in default (2000), not the user's own global; comment at `tmuxSession.ts:205` is wrong. If `new-session` fails, our `-g` value stays | `tmuxSession.ts:199-205` | V |
| c | `set-clipboard on` and root `PPage`/`NPage` bindings overwrite server-wide user config on every attach | `tmuxSession.ts:232,254-257` | V (accepted; make it non-destructive) |
| d | Prefix key live: Ctrl-B swallowed (Claude Code uses it); `escape-time` default 500 ms before tmux 3.5 delays Esc | absent from argv | V absent / S effect |
| e | No `TMUX` unset in pty env → nested-session refusal if server env has `$TMUX`; `TERM_PROGRAM=tmux` inside pane may break IDE detection; truecolor may degrade | `src/tmux/terminalProvider.ts:799-817` | S |
| f | `new-session -c <cwd>` format expansion (`#{…}`, `#(cmd)`, `#S`) and trailing-`;` argv parsing | `tmuxSession.ts:181-184` | S — security if true |
| g | `parsePath` reads only stdout line 1 → rc-file banner drops the absolute path → bare `tmux` (breaks nix / `~/.local/bin`) | `src/tmux/tmuxBootstrap.ts:113` (cf. tolerant `parseVersionToken` `:104`) | V |
| h | Exec-side commands use bare `tmux`, pty uses probed absolute path → may address different servers when `TMUX_TMPDIR`/PrivateTmp differ | `tmuxSession.ts:271,285,290` | S |
| i | Floor 2.6 claimed (`tmuxBootstrap.ts:49-50`) but chain only ever run on 3.4: `#{m:…}`, `copy-mode -e -u`, `=name:` target, `-A -D`, user options | — | V untested |
| j | VS Code shell integration (decorations, cwd tracking) absent because `shellPath` is tmux | `terminalProvider.ts:799-817` | S |

## Files to change
- `src/tmux/tmuxSession.ts` — builders only (the one place tmux command lines live):
  - `clampHistoryLimit(n)`: integer, range `[0, 1_000_000]`, NaN/non-finite → default.
  - history-limit without touching the user's global: preferred = create with
    `new-session -d` then set session option and `respawn`/first-pane approach **only if** the rig
    proves a version-portable way; fallback = read user's value in the same chain
    (`set-option -gF`/`#{history-limit}` save into a user option, restore from it) — pick on the
    rig, document the choice in the builder comment, delete the wrong comment.
  - chain order: anything that can fail goes after the session exists and after any restore;
    non-essential options issued with `set-option -q` so one unknown option on an old tmux cannot
    abort the chain.
  - session-scoped `prefix None`, `prefix2 None`; session/server `escape-time 0`…`10` (server
    option → only set if user's value is the built-in default; else leave).
  - `set-clipboard`, `PPage`/`NPage`: apply only when the user has not configured them (format
    test / `show-options` in the reconcile batch); otherwise leave theirs.
  - cwd: escape `#` → `##` if (f) reproduces; reject/normalise a trailing `;` element.
  - all exec-side builders take the probed absolute tmux path (quoted via `escapeShellArg`).
- `src/tmux/tmuxBootstrap.ts:104-113` — `parsePath`: last absolute-path line, tolerate banners;
  record version → feature table `tmuxFeatures(version)` (pure) used by the builder to drop
  unsupported flags instead of failing.
- `src/tmux/terminalProvider.ts:799-817` — `env: { TMUX: null, TMUX_PANE: null }` in the profile
  options if (e) reproduces; truecolor: `terminal-overrides`/`terminal-features` per feature table.
- `src/extension.ts:438` — read through `clampHistoryLimit`.
- `package.json` configuration — `historyLimit`: `type: integer`, `maximum`; manifest test.

## Steps
1. Flip slice-01 rig specs for (a)(b)(d)(f)(g) from `it.fails` — they define done.
2. Run the whole chain on every matrix version; fill `tmuxFeatures`; decide the floor (raise in
   `tmuxBootstrap.ts:49-50` + docs if 2.6 cannot be supported — degrade to plain shell below).
3. Implement builder changes one finding at a time, unit test first.
4. (e)(h)(j): reproduce on rig / F5; fix only what reproduces; log the rest as not-reproduced.
5. (j) if confirmed: evaluate `allow-passthrough`/OSC 633 feasibility; if not cheaply solvable,
   document as a known difference vs. stock open-remote-ssh (do not hack).

## Tests (write first — TDD)
- `test/tmux/tmuxSession.test.ts` — `clampHistoryLimit` table (1.5, -1, 1e10, NaN, '50', 0);
  argv never contains `-gu history-limit`; restore step precedes every fallible option; prefix
  and escape-time elements present and session-targeted with `=name:`; `#` in cwd escaped; exec
  builders embed the quoted absolute path; `tmuxFeatures` gates each version-dependent flag.
- `test/tmux/tmuxBootstrap.test.ts` — banner lines before path; path with spaces; multiple
  candidates → last absolute.
- `test/tmux/terminalProvider.test.ts` — options carry the env unsets (if adopted).
- `test/extension.wiring.test.ts` — out-of-range setting clamps.
- Rig (all versions): user `set -g history-limit 100000` + own `PPage` binding + `set-clipboard
  external` unchanged after attach; Ctrl-B byte reaches `cat -v`; Esc latency; hostile cwd
  creates no file; banner-printing rc still yields a working terminal.
Commands: `npm run compile:src`, `npm run lint`, `npm test`, `npm run test:tmux`.

## Verify
- Rig green on every supported version. F5: Claude Code inside the terminal — Ctrl-B backgrounds
  on first press, Esc immediate, colours correct, PageUp/wheel scroll still work (rows 10, 18).
- `tmux show-options -g` / `-s` / `list-keys -T root` diff before vs. after our attach on a server
  with a custom `~/.tmux.conf`: empty except documented items.

## Done when
- No setting value can stop a terminal from opening.
- User's server-wide tmux state is not modified where they configured it.
- Every flag in the chain is covered by `tmuxFeatures` and a rig run at the floor version.
