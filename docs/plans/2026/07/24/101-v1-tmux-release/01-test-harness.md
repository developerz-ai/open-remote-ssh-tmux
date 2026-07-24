# 01 — Test harness + backfill unit tests

> Part of [`overview.md`](overview.md). Depends on: none. Blocks everything
> (TDD rule: no test, no merge — `CLAUDE.md`, `docs/idea/ai-first.md:31-33`).

## Files to change
- `package.json:19-42` — add `"test": "vitest run"`, `"test:watch": "vitest"`;
  devDeps `vitest` (no jsdom needed — node env).
- `vitest.config.ts` (new, repo root) — `test.include: ['test/**/*.test.ts']`,
  environment `node`. Keep out of webpack/`tsc -b` build (`tsconfig.json:37`
  excludes pattern — add `test` + `vitest.config.ts` to excludes, or give
  `test/` its own tsconfig ref).
- `test/` (new dir) — unit tests, mirrored by module name.
- `.lintstagedrc.yml` — leave as-is; pre-commit test gate handled in 08.

## Steps
1. `npm i -D vitest`; add scripts + `vitest.config.ts`. Vitest chosen: fast
   (<10s target, ai-first.md:57-60), TS-native, no compile step, ESM/CJS agnostic.
2. Ensure `npm run compile:src` still passes (tests must not enter `out/` or
   the webpack bundle; check `webpack.config.js` entry untouched).
3. Backfill tests for the existing pure modules (the ai-first.md:57-60 list).
   These document upstream behaviour before the fork changes anything:
   - `test/ssh/sshDestination.test.ts` — parse/format round-trips of
     `user@host:port`, defaults, IPv6 if supported (`src/ssh/sshDestination.ts`).
   - `test/ssh/sshConfig.test.ts` — host matching, include handling, wildcard
     precedence (`src/ssh/sshConfig.ts`).
   - `test/serverConfig.test.ts` — version/quality/commit policy + validation
     enum (`src/serverConfig.ts`).
   - `test/common/ports.test.ts` — port-pick logic (`src/common/ports.ts`).
   - `test/authResolver.splitProxyCommand.test.ts` — quoting cases from the
     upstream-issue comment (`src/authResolver.ts`, `splitProxyCommand`).
     Export the function if it's module-private — export-only change, no logic.
4. Mock nothing network/ssh — these modules are pure or near-pure; if a module
   drags in `vscode`, stub via `vitest.config.ts` `alias` (`vscode` → a tiny
   `test/mocks/vscode.ts`) — pattern reused by later slices.

## Tests (write first — TDD)
- This slice IS the tests. Each file above starts failing only if it exposes a
  real behaviour gap — expected here is green-on-write (characterisation
  tests). Assert current behaviour, not wished behaviour.

## Verify
- `npm test` green, wall-clock <10s. `npm run compile:src`, `npm run lint`,
  `npm run bundle` all clean (tests excluded from bundle — check
  `lib/extension.js` size unchanged ±1%).

## Done when
- `npm test` exists and is green; ≥5 pure modules covered; `vscode` mock
  pattern established for later slices.
