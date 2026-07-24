# 08 — Release infrastructure & v1.0.0 cut

> Part of [`overview.md`](overview.md). Depends on: 01 (test gate), 06
> (identity). Final slice before 09 verify.

## Files to change
- `.github/workflows/ci-master.yml` + `ci-pr.yml` — add `npm test` step after
  `npm run build` (both files are identical jobs; keep them in sync).
- `.husky/pre-commit` — after `lint-staged`, add `npm run compile:src &&
  npm test` (ai-first.md gap: pre-commit gate).
- `bin/setup`, `bin/dev`, `bin/check` (new, executable) — ai-first DX
  (`docs/idea/ai-first.md:57-68`): setup = `npm install`; dev =
  `npm run watch:src`; check = `compile:src && lint && test` (the "green"
  definition used everywhere).
- `.github/workflows/publish.yml` — verify it works under the new id: Open VSX
  publish gated on `PUBLISH_OPENVSX`; VS Code Marketplace block is commented
  out — leave commented unless a Marketplace publisher token exists (flag to
  owner as a decision).
- `eslint.config.mjs` is the live config (ESLint 10 flat): delete dead
  `.eslintrc.json` + `.eslintignore` (duplicated rules; poison for future
  edits). Confirm `npm run lint` output unchanged before/after.
- `package.json:5` — `version: "1.0.0"` (via `npm run release` / release-it,
  not hand-edit, if the flow allows; `.release-it.yml` tags `v${version}`).

## Steps
1. CI: add test step; confirm runtime stays reasonable (<2 min job).
2. Pre-commit gate; verify a failing unit test blocks a commit locally.
3. `bin/` scripts, chmod +x, 2-space shell style (`.editorconfig`).
4. ESLint cleanup commit (separate, `refactor:` or `build:` type — keep it
   out of feature diffs for fork hygiene).
5. Release: branch → PR → merge to master → `npm run release` → tag `v1.0.0`
   → `publish.yml` runs → GitHub Release with `.vsix` + `.sha256` (+ Open VSX
   if var set). CHANGELOG 1.0.0 (06) supplies the release notes via
   `.github/scripts/get-changelog.js`.
6. Post-release smoke: download the released `.vsix`, install into VSCodium,
   connect, one persistence check.

## Tests (write first — TDD)
- No new unit logic. Gate proof instead: intentionally break a test → assert
  pre-commit blocks and CI PR run fails; revert.
- Command: `bin/check` green = `compile:src` + `lint` + `test`.

## Verify
- CI green on the release PR incl. test step; `npm run package` produces
  `open-remote-ssh-tmux-1.0.0.vsix`; tag pipeline produces the GitHub
  Release; installed-from-release extension passes one EDH-style connect.

## Done when
- `v1.0.0` tag exists with a downloadable vsix; CI + pre-commit enforce
  build+lint+test; `bin/check` is the single "green" command.
