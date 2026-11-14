# Brief: is the project healthy?

Weekly (Monday) checkup fired by `schedules: health`: the failures no issue or PR announces.

## Signals

| Signal | Command | Healthy |
|---|---|---|
| `main` is green | `gh run list --workflow ci-main.yml --branch main --event push --limit 1 --json conclusion,headSha,url`, then `git rev-parse origin/main` | `success` on the `origin/main` tip; a null conclusion or another sha is no verdict |
| Dependabot is not stuck | `gh pr list --app dependabot --state open --limit 100 --json number,updatedAt,statusCheckRollup` | no PR with failed checks and more than 7 days since `updatedAt` |

A null run is not always a red: both workflows ignore markdown-only diffs
(`.github/workflows/ci-pr.yml:7-8`, `.github/workflows/ci-main.yml:7-8`), so a
docs-only push to `main` starts no run at all. Confirm what the tip touched before
reading a missing run as a failure.

## What to file

For each unhealthy signal, one ask, unless an open issue already carries its exact title
(`gh issue list --state open --search "<title> in:title" --json number,title`, then compare byte for byte).
Titles are stable: nothing that changes run to run (sha, run URL) goes in one; that goes in the body,
with the command and its output. Unreadable evidence is no verdict: re-run it, never file it as a defect.
A red `main` comes first.

## Checks that exist on main

Declared rows, not an enforced gate: nothing parses this file — the schedule hands it to
an agent (`.dz/maintainer/maintainer.yml:59-62`, `.dz/README.md:8`). One row per check that
exists here; each cell after the first names what it runs and the `path:line` that proves it.

| Check | What it runs | Where it lives |
|---|---|---|
| CI `check`, on a pull request to `main` | `npm ci` → `npm run build` → `npm test` → `npm run lint:package` + `git diff --exit-code -- package.json` → `npm run lint` → commitlint over the PR range | `.github/workflows/ci-pr.yml:13` — steps at `:30`, `:34`, `:38`, `:46-47`, `:51`, `:53-78` |
| CI `check`, on a push to `main` | the same six steps, lockstep with `ci-pr.yml` | `.github/workflows/ci-main.yml:13` — steps at `:30`, `:34`, `:38`, `:46-47`, `:51`, `:53-87` |
| CI `package`, on a pull request and a push to `main` | Node 22 → `npm ci` → packaging-Node guard → `npm run package` → vsix contents held to the `.vscodeignore` whitelist | `.github/workflows/ci-pr.yml:80`, `.github/workflows/ci-main.yml:89`; `.github/scripts/check-vsix-contents.js` |
| Scheduled audit, daily | `npm audit` and zizmor 1.31.1 over the workflows; a finding opens or comments on one tracking issue, a clean run closes it | `.github/workflows/audit.yml:9-10`, steps at `:44`, `:46` |
| `bin/check` | `npm run compile:src && npm run lint && npm test` — the local gate; the pre-commit hook runs the same minus `eslint` (`.husky/pre-commit:4`), so a green hook is weaker than this | `bin/check:4` |
| `bin/setup` | `npm install` — dependencies, then the manifest's own hooks: `postinstall` patches `ssh2` and fetches the VS Code dts, and `prepare` runs `husky` and `lint:package` (`fixpack`, which rewrites `package.json` in place) | `bin/setup:4`, `package.json:34-35` |
| `bin/dev` | `npm run watch:src` — `tsc-watch` plus a dev bundle | `bin/dev:4`, `package.json:46` |
| `npm run compile:src` | `tsc -b` into `out/` (src only: `tsconfig.json` excludes `test` and `vitest.config.ts`, `tsconfig.json:46-51`), then `npm run compile:test` — the typecheck | `package.json:27` |
| `npm run compile:test` | `tsc -p tsconfig.test.json` — `noEmit` typecheck of `test/`, `vitest.config.ts` and the vscode `.d.ts` files; reached from `build` via `compile:src` | `package.json:28`, `tsconfig.test.json` |
| `npm run lint` | `eslint` | `package.json:29` |
| `npm run lint:all` | `lint:package`, `npm audit`, `ci:lint`, `lint` — the full local gate; CI runs only `lint:package` and `lint`, the audits are scheduled | `package.json:30` |
| `npm test` | `vitest run` | `package.json:37` |
| `npm run build` | `clean` → `compile:src` → `bundle` (webpack production) | `package.json:21`, `package.json:22` |
| `npm run ci:lint` | `pipx run zizmor .` over the workflows (latest zizmor; the scheduled audit pins its own) | `package.json:24` |
| pre-commit hook | `npx lint-staged` — `fixpack` **rewriting** a staged `package.json`, `zizmor` over staged workflows, `eslint` over staged `*.ts` — then `npm run compile:src && npm test` | `.husky/pre-commit:3-4`; staged set `.lintstagedrc.yml:1-2` (`fixpack`), `:3` (`zizmor`), `:4` (`eslint`) |
| commit-msg hook | `npx commitlint --edit "$1"` | `.husky/commit-msg:3` |
| F5/EDH matrix | **manual, one-off**: 21 rows on a real Unix remote; last run 19/21 PASS | `docs/plans/2026/07/24/101-v1-tmux-release/09-verify.md:16-38`, results `results-2026-07-24.md:95` |

`check` is the required merge check (`.dz/maintainer/maintainer.yml:34-35`).

## Gaps — claims that cannot fail or cannot run

| Gap | Why it is not a green row |
|---|---|
| the F5/EDH matrix | cannot run in an agent environment — no VS Code desktop binary or display (`docs/idea/ai-first.md:62-67`) — and its last run left rows open: row 13, no real Windows remote (`results-2026-07-24.md:85`), row 18, Claude Code TUI (`results-2026-07-24.md:90`) |
| `bin/check` under CI | no workflow invokes it (repo-wide grep): CI runs `npm run build`, `npm test` and `npm run lint` as separate steps (`.github/workflows/ci-pr.yml:34`, `:38`, `:51`), so `bin/check` green is a local/pre-commit signal only |
| a missing `check` run | `paths-ignore: **/*.md` (`.github/workflows/ci-pr.yml:7-8`, `.github/workflows/ci-main.yml:7-8`) means a markdown-only diff never starts the job: a skipped check, never a pass — do not file it and do not weaken the workflow |
