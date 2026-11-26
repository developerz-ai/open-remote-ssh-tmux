# Brief: weekly maintenance

Fired every Monday at 08:00 UTC by `schedules: maintain` (`mode: devops`, `outcome: pr`): one task
with a shell that delivers **at most one pull request**, or a stated reason none was owed.
Reporting-only signals (red `main`, flaky jobs, Dependabot, upstream drift, shipped dependencies,
acceptance freshness, the release judgement) belong to `health` (`.dz/schedules/health.md`, 07:00 UTC);
do not repeat them here.

`CLAUDE.md` binds every change; `triage.non_goals` in `.dz/maintainer/maintainer.yml` are off limits.

## Rows

One per task below; the PR body (or the no-PR reason) gives each row's verdict.

- `gate`: `bin/check` passes on fresh `main`
- `tmux-release`: the newest tmux release is in the rig matrix
- `tool-pins`: zizmor and the EDH VSCodium pin are current
- `docs-truth`: `CLAUDE.md`, `README.md`, `docs/upstream-sync.md` and `.dz/` match the files

## Start

```sh
git fetch origin && git checkout -B chore/weekly-maintenance-$(date -u +%F) origin/main
gh run list --workflow ci-main.yml --branch main --event push --limit 1 --json conclusion,headSha
npm ci
```

If the newest push run of `ci-main.yml` on the `origin/main` tip did not conclude `success`, stop:
no PR is owed, `health` files a red `main`. If an open pull request titled
`chore(maintain): weekly maintenance …` exists, stop: last week's run is still in review.

## Tasks, in order

Do each task whose check fails. Each fix is its own commit (Conventional Commits, body lines
≤ 200 characters); all of them go on the one branch above.

### 1. `gate`: the local gate on fresh `main`

```sh
bin/check
```

- **Pass:** exit 0.
- **Fail:** fix the root cause (a test that fails on `main` first, then the code), never a retry, a
  skip or a weakened assertion. If the fix is bigger than this run, stop: no PR is owed; name the
  failure in the reason so `health`'s next run or a member can pick it up.

### 2. `tmux-release`: a new tmux release not in the rig

```sh
gh api repos/tmux/tmux/releases --jq '.[] | select(.prerelease | not) | .tag_name' | head -5
grep -E '^  tmux-' test/rig/compose.yml          # the matrix: one service per version
```

- **Pass:** the newest non-prerelease tag is a `tmux-<tag>` service in `test/rig/compose.yml`.
- **Fail:** add it. A letter release of a version already in the matrix (`3.8a` after `3.8`) replaces
  that version in place and keeps its reason; a new minor or major is added beside the others, with
  a one-line reason in the comment block at the top of `compose.yml` (the previous "latest stable"
  line becomes "previous latest stable"). Never drop a version otherwise: removals are a member's call.
  1. `test/rig/compose.yml`: a service `tmux-<V>` like the others, `TMUX_VERSION: "<V>"` and
     `TMUX_SHA256` from the release asset, checked twice:
     `gh api repos/tmux/tmux/releases/tags/<V> --jq '.assets[] | select(.name == "tmux-<V>.tar.gz") | .digest'`
     and `curl -fsSL https://github.com/tmux/tmux/releases/download/<V>/tmux-<V>.tar.gz | sha256sum`.
     They must match; if the asset has no digest, the download's hash alone is used and the PR says so.
  2. `matrix.tmux` of the `tmux-rig` job in **both** `.github/workflows/ci-pr.yml` and
     `.github/workflows/ci-main.yml`, kept identical.
  3. Every prose list of rig versions: `git grep -n -F '3.5a, 3.8' -- CLAUDE.md README.md docs/idea`
     (substitute the current last two versions) and the README `tmux-… tested` badge.
  4. Read the release's `CHANGES` (`https://github.com/tmux/tmux/blob/<V>/CHANGES`). If it fixes a
     limitation the README states for an older version (today: Esc held ~0.5 s on 3.8), update that
     README paragraph to name the fixed version.
  - Gate: `npm run test:tmux -- <V>` when `docker compose version` works; otherwise the PR's
    `tmux rig (<V>)` CI job is the gate and the PR says it was not run locally. A new version that
    fails the rig is a finding, not something to hide: keep the PR to the matrix change, describe the
    failure, and do not change `src/tmux/*` in this run.

### 3. `tool-pins`: pins Dependabot cannot see

Dependabot covers npm, GitHub Actions and the rig's Docker base image weekly. These pins it does not:

- **zizmor:** `git grep -n -E 'zizmor==|ZIZMOR_VERSION' -- ':!*.md'` lists every pin (the `package.json`
  scripts, `.lintstagedrc.yml`, `.github/workflows/audit.yml` and the tests that hold them equal;
  `CONTRIBUTING.md` quotes the version in prose). Latest:
  `gh api repos/zizmorcore/zizmor/releases/latest --jq '.tag_name, .published_at'`. Behind by a release at least
  7 days old (the repo's cooldown, `update:ci`): bump every pin and the prose in one commit, then run
  `npm run ci:lint`. New findings on our workflows are fixed in the same PR (`npm run ci:lint:fix`
  only as a starting point); if they need a member's judgement, leave the pin and say why.
- **VSCodium for the EDH driver:** `VSCODIUM_VERSION` in `test/rig/edh/run.sh` against
  `gh api repos/VSCodium/vscodium/releases/latest --jq .tag_name`. Bump it (and both sha256 pins in
  that file, from the release's own `.sha256` assets) only if docker is available and the bumped
  driver passes `01-connect` and the zombie rows `06-exit-closes 07-churn 08-reopen-3x 09-revive-no-dup`
  (`npm run package`, then `test/rig/edh/run.sh <vsix> <rows…>`). No CI job runs this driver, so an
  unrun bump is never shipped; say "not verified" in the reason instead.
- **Not here:** `engines.vscode` (`^1.90.0`) and `update:dts` (`1.90.0`) are a deliberate floor
  (VS Code 1.90 is the first Node 20 extension host; tests pin it). A newer VS Code is not drift.
  Raising the floor is a member's call. Any change to `dependencies` is also out: runtime dependencies
  need a member's review and this PR merges on green (`pr.auto_merge_scope: own`).

### 4. `docs-truth`: written claims against the files

Each check prints nothing when it passes. Fix what it prints in the doc, never the code to match a doc.

```sh
# CLAUDE.md module map: every source file named, every named path real
git ls-files src | grep -v '^src/scripts/' | while read -r f; do grep -qF "$(basename "$f")" CLAUDE.md || echo "unmapped: $f"; done
grep -oE 'src/[A-Za-z0-9_/.-]+\.(ts|sh|ps1)' CLAUDE.md | sort -u | while read -r p; do test -e "$p" || echo "missing: $p"; done
# CLAUDE.md "roughly Nk lines" claims, rounded to the nearest thousand (src) and hundred (scripts)
git ls-files 'src/*.ts' | xargs cat | wc -l; git ls-files 'src/scripts/*' | xargs cat | wc -l
# every `npm run <script>` in CLAUDE.md, README.md, CONTRIBUTING.md and .dz/ exists
grep -rhoE 'npm run [a-z:]+' CLAUDE.md README.md CONTRIBUTING.md .dz | sort -u | while read -r _ _ s; do
  jq -e --arg s "$s" '.scripts[$s]' package.json >/dev/null || echo "no script: $s"; done
# every CI job id is described in CLAUDE.md "CI gates"; `pr.required_checks` names a real job
grep -E '^  [a-z0-9_-]+:$' .github/workflows/ci-pr.yml .github/workflows/ci-main.yml
grep -qE '^  check:$' .github/workflows/ci-pr.yml || echo "required check 'check' is not a ci-pr.yml job"
# docs/upstream-sync.md "Fork point" names the current sync point
git remote get-url upstream 2>/dev/null || git remote add upstream https://github.com/jeanp413/open-remote-ssh.git
git fetch --quiet upstream master && git merge-base origin/main upstream/master
# path:line citations in the .dz briefs still point at what they describe
grep -noE '`[A-Za-z0-9_./-]+:[0-9]+(-[0-9]+)?`' .dz/schedules/*.md
```

- The module map rounds and the job list need reading, not just running: a job the CI section does
  not describe, a file whose responsibility changed, or a line count off by a thousand is drift.
- The upstream sync point only differs from `docs/upstream-sync.md` after a member merged upstream;
  update the "Fork point" section (sha, subject, date) and leave the hunk table to that member's PR.
- For each `path:line` the last command prints, open the cited line; if it no longer holds what the
  sentence says, correct the number.
- One `docs:` commit per document.

## Ship

- Nothing changed: open no PR. End with the reason: each task's verdict (pass, fixed, or why not).
- Otherwise one pull request from the branch above, titled
  `chore(maintain): weekly maintenance <YYYY-MM-DD>` (the squash subject on `main`; commitlint judges it).
  Body: one section per task that changed something, with the command and its output before and
  after; lines ≤ 200 characters. `bin/check` is green on the final head before it is opened.
- Never in this PR: a version bump, `CHANGELOG.md`, `.github/workflows/publish.yml`, `.release-it.yml`,
  `dependencies`, the upstream merge, or any change under `src/` other than the `gate` fix.
- One PR per run (`docs/standards/pr-batching.md`): no second PR for a task, no PR for a lone typo.
