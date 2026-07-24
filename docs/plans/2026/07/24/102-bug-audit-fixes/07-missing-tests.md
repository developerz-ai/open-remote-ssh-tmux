# 07 — missing tests & drift guards

> Part of [`overview.md`](overview.md). Depends on: 01–06 (tests pin *fixed* behavior).
> Slices 01–06 already carry TDD tests for the code they change; this slice covers
> coverage gaps **not** tied to a fix, drift guards, and repairing weak existing tests.

Baseline: 153 tests / 13 files, all green. Placeholder `test/extension.wiring.test.ts`
is replaced in slice 02.

## New drift guards (pattern: `test/package-manifest.test.ts:192` command-id guard)
- **Settings-read guard** — every `remote.SSH.*` key under `contributes.configuration.properties` appears in a `get(...)` call somewhere in `src/` (grep-based, like `registeredCommandIds()`). Would have caught the two dead tmux settings shipped in 1.0.0; after slice 02 it passes.
- **Enum-handled guard** — every declared `tmux.enabled` enum value (`auto|off|on`) appears in `src/extension.ts` handling.
- **Profile-title guard** — `TMUX_PROFILE_TITLE` (`src/extension.ts:170`) === `contributes.terminal.profiles[].title` (id guard exists at `package-manifest.test.ts:175`; title is what the default-profile write selects by).
- **Reverse docs guard** — every manifest `remote.SSH.tmux.*` key is mentioned in docs (forward guard exists at `package-manifest.test.ts:126`).
- **Activation-event guard** — every contributed command has a matching `activationEvents` entry (pins the 06 fix).

## Coverage gaps (target → cases)
- `src/serverSetup.ts:27-74` `findServerInstallPath`/`matchHostnamePattern` (exported, no tests): exact beats `*.example.com` beats `*`; regex metachars (`host.name` ≠ `hostXname`); no match → undefined. (Templating/parse tests live in slice 05.)
- `src/fetchRelease.ts:14` `splitRelease` — covered in slice 05; ensure the four schemes are all present.
- `src/ssh/identityFiles.ts:38` `gatherIdentityFiles` (tmp-dir fixtures, no agent): `.pub` suffix stripped; empty input → 7 defaults; unreadable dropped; agent∩file promoted with `agentSupport: true`; `identitiesOnly` excludes agent-only.
- `src/ssh/sshConfig.ts` gaps beyond slice-04 fixes: `Include` glob (`config.d/*`), `~` expansion, relative-to-`~/.ssh`; comma-vs-space Include args (characterise `:85`); multi-`IdentityFile` → `string[]`.
- `src/tmux/terminalProvider.ts` defensive helpers: `readMapping:328` malformed state (`{'x':n}`, `{'-1':n}`, `{'1.5':n}`, `{'0':42}` → skipped, valid kept); `sessionExists:309` — `no server running` / `error connecting` variants of `MISSING_SESSION_RE:90`, rejecting exec → prune; `folderName:342` trailing slash / `'/'` / `''`; `slotFromCreationOptions:236` `-s` last element → undefined, no throw.
- `src/tmux/tmuxBootstrap.ts` parse edges: `tmux 3.0a`, `tmux 10.0` (double-digit major → numeric compare pinned), version line after stderr noise, `next-3.4`.
- `src/common/files.ts` — covered in slice 06; keep `normalizeToSlash` case.
- `src/common/ports.ts` — post-06 (dead code deleted): `findRandomPort` happy path retained.
- `src/authResolver.ts:74` `splitProxyCommand` extras: unterminated quote, trailing backslash, tabs.
- `src/remoteLocationHistory.ts` — covered in slice 06.

## Weak-test repairs
- `test/serverConfig.test.ts:38` — "-insider strip" never exercises the strip (mock version `1.70.2`, `test/mocks/vscode.ts:6`). Use `vi.resetModules()` + a `1.70.2-insider` mock so the strip and the `serverValidation: 'force'` / missing-`serverDownloadUrlTemplate` branches become reachable (module-level product.json cache is the blocker — bust it per test).
- `test/tmux/terminalProvider.test.ts:69` — fake exec `has-session` matched via `includes` (mimics the prefix bug) — fixed in slice 01; assert here that the fake now requires exact `=name` targets.

## Steps
1. Write drift guards first (they're pure grep/JSON, no code changes needed post-02/06).
2. Fill coverage gaps top-down in the order above.
3. Repair the two weak tests.

## Tests (write first — TDD)
This whole slice *is* tests. Command: `npm test`; keep `npm run compile:src` + `npm run lint` green (test code obeys the same lint rules).

## Verify
- Full suite green; no `.skip`/placeholder assertions anywhere (`grep -rn "toBe(true)" test/` clean); guards fail when seeded with a deliberate drift (spot-check one by temporarily editing package.json, then revert).

## Done when
- Five drift guards in place and green; every listed gap has cases; the two weak tests actually exercise their claims; suite deterministic (no network, no real `~/.ssh`).
