# 07 — CI and release gates

> Part of [`overview.md`](overview.md). Depends on: 01 (rig job exists).

## Findings (all `[V]` unless marked)
| # | Finding | Where |
|---|---|---|
| a | Lint cannot fail on house rules: all custom rules `warn`, `"lint": "eslint"` without `--max-warnings 0`; no type-aware rules (`no-floating-promises`, `no-misused-promises`) despite fire-and-forget calls (`src/authResolver.ts:743`, `src/commands.ts:45,49,87`); `**/*.js` ignored | `eslint.config.mjs:31-80`, `package.json:28` |
| b | `useUnknownInCatchVariables: false` → catch vars are `any` | `tsconfig.json` |
| c | PR CI never packages; vsce needs Node ≥ 22.13 while CI runs Node 20; breakage surfaces at release | `.github/workflows/ci-pr.yml`, `publish.yml:63-69`, `.github/scripts/check-packaging-node.js` |
| d | Publish runs only `npm ci` + `npm run package` — no test/lint on the tag; version taken from newest tag, not the triggering tag, never compared with `package.json` | `publish.yml:26-36,85-97`, `preview.yml:17-27` |
| e | `.release-it.yml`: no test hook, `requireCleanWorkingDir: false` | `.release-it.yml` |
| f | `preview.yml:71` unpinned `npx bumpp … \|\| true` in a `contents: write` job; on failure may retag stable `[S]`; download link uses `env.VERSION` but assets go to `RELEASE_TAG` | `preview.yml:71,100` |
| g | `engines.vscode ^1.70.2` not credible: bundled deps need Node ≥ 18/20; `exitStatus.reason` missing there (slice 05 g); nothing tests any VS Code version | `package.json:14-16`, `package-lock.json` |
| h | No coverage config/thresholds | `vitest.config.ts` |
| i | CI only ubuntu + Node 20; Windows-specific code (ProxyCommand split, PowerShell install) never executed | workflows |
| j | `lint:all` runs `npm audit` + unpinned `pipx run zizmor` on every PR → red `main` without code change; `fixpack \|\| true` (`package.json:31`); zizmor ignores by line number (`.github/zizmor.yml`); stale-PR workflow lacks `pull-requests: write`; `.tazerc.json` excludes `commitlint/cli` (typo for `@commitlint/cli`); no `license` field; commitlint allows `chore` but CLAUDE.md omits it | as listed |
| k | No `SECURITY.md` | repo root, `.github/` |
| l | Dependabot PRs auto-merge (`.dz/maintainer/maintainer.yml:34-38`) while gates above are weak | — |
| m | README (37 KB, contributor/harness detail at `:76-243`) ships in the `.vsix` as the marketplace page | `.vscodeignore`, `README.md` |

## Files to change
- `eslint.config.mjs` — house rules → `error`; add typed linting for `src/**` with
  `no-floating-promises`, `no-misused-promises`, `switch-exhaustiveness-check`; lint the repo's
  own `.js` (`scripts/`, `.github/scripts/`, `webpack.config.js`) with a light config.
  Fix or explicitly `void` each resulting violation; no blanket disables.
- `package.json` — `"lint": "eslint --max-warnings 0"`; `test:coverage`; `license`; remove
  `|| true` from fixpack or drop the step; `engines.vscode` raised to the lowest version actually
  smoke-tested (decide from (g): lowest VS Code with Node ≥ 20 in the extension host);
  `test/package-manifest.test.ts` + `test/publish-node-engines.test.ts` updated.
- `tsconfig.json` — `useUnknownInCatchVariables: true`; fix catch sites (narrow, no `any`).
  Upstream files: minimal narrowing only.
- `vitest.config.ts` — v8 coverage; thresholds on `src/tmux/**`, `src/clipboard/**`,
  `src/common/**` set at measured baseline − 0 (ratchet up, never down); upstream files reported,
  not gated.
- `.github/workflows/ci-pr.yml`, `ci-main.yml` — add `package` job (Node 22.x, `npm run package`,
  assert vsix file list against `.vscodeignore` whitelist); `windows-latest` + `macos-latest`
  unit-test jobs; move `npm audit` + zizmor to a scheduled workflow (pinned zizmor version) that
  opens an issue instead of failing PRs.
- `.github/workflows/publish.yml` — gate: `npm run build && npm test && npm run lint` before
  package; version = `GITHUB_REF_NAME`; fail if ≠ `package.json` version.
- `.github/workflows/preview.yml` — pin `bumpp` as a devDependency (lockfile), remove `|| true`,
  fix the download link variable, refuse to run when the computed tag already exists.
- `.release-it.yml` — `requireCleanWorkingDir: true`; `hooks.before:init` runs `bin/check`.
- `.github/zizmor.yml` — ignore by rule + inline comment, not line number.
- `.github/workflows/mod-stale-issue-pr.yml` — add `pull-requests: write`.
- `.tazerc.json` — `@commitlint/cli`.
- `SECURITY.md` (new) — supported versions, private reporting channel (GitHub advisories),
  scope (credentials, remote exec, tmux command lines), what is logged.
- `README.md` → user-facing only; move contributor/harness sections to `CONTRIBUTING.md`.
- `test/extension.activate.test.ts` (new) — smoke: `activate()` with the vscode mock registers
  every command/profile declared in `package.json` `contributes`.

## Steps
1. (a)(b) lint/tsc tightening — separate PR; expect a batch of real floating-promise fixes; each
   gets `.catch` with a logged error or an explicit `void` + comment (never swallow).
2. (c)(d)(e)(f) pipeline; dry-run publish/preview on a fork tag or `workflow_dispatch` with
   publish steps disabled.
3. (g) engines decision + test; (h) coverage baseline; (i) OS matrix (fix what Windows/macOS
   runs reveal — path/quoting bugs are findings, not flakes).
4. (j)(k)(l)(m) hygiene. (l): keep auto-merge only for patch-level devDependencies once gates are
   hard; runtime deps (`ssh2`, socks) always need review.

## Tests (write first — TDD)
- `test/package-manifest.test.ts` — `lint` script contains `--max-warnings 0`; `license` present;
  engines floor equals the documented constant.
- `test/workflows.test.ts` (new, same style as `test/publish-node-engines.test.ts`) — publish
  workflow contains test + lint before package; no `|| true` in workflows/scripts; every `uses:`
  pinned to a SHA; preview has no unpinned `npx`.
- `test/extension.activate.test.ts` — as above.
- ESLint: add one fixture file with a floating promise under `test/fixtures/lint/` and a test
  asserting `eslint` exits non-zero on it.
Commands: `npm run compile:src`, `npm run lint`, `npm test`, `npm run package` (Node 22).

## Verify
- A PR introducing a warning, a floating promise, a broken `.vscodeignore`, or a version/tag
  mismatch fails CI (prove each once on a throwaway branch; link runs in `status.yml` evidence).
- `npm run test:coverage` prints thresholds and passes.

## Done when
- Nothing can be published that did not pass build + lint + unit + rig + package.
- Lint and tsc enforce the rules CLAUDE.md states.
