# Brief: weekly health and release judgement

Fired every Monday at 07:00 UTC by `schedules: health` (a read-only scout). It reads signals and
**files asks**; it changes no file and opens no pull request. Fixes that fit a weekly pull request
belong to `maintain` (`.dz/schedules/maintain.md`, 08:00 UTC), which reads none of the rows below.

Work from a fresh clone of `main`. Set once:

```sh
REPO=developerz-ai/open-remote-ssh-tmux
TIP=$(git rev-parse origin/main)
TAG=$(git tag --list 'v*' --sort=-v:refname | head -1)   # last release tag
```

## Rows

Each row is a pass/fail verdict. A command that errors, times out or returns unreadable output is
**no verdict**: run it once more, and if it still cannot be read, say so in the run's summary. Never
file a defect from evidence you could not read.

### `main-green`

```sh
gh run list --repo "$REPO" --workflow ci-main.yml --branch main --event push --limit 5 \
  --json conclusion,status,headSha,url,createdAt
```

- **Pass:** the newest run whose `headSha` equals `$TIP` has `conclusion: success`.
- **Fail:** that run concluded `failure`, `timed_out` or `startup_failure`. Name the failed job:
  `gh run view <id> --repo "$REPO" --json jobs --jq '.jobs[] | select(.conclusion != "success") | .name'`.
- **No verdict:** the run is still `in_progress`/`queued`, or no run carries `$TIP` yet. If
  `.github/workflows/ci-main.yml` has a `paths-ignore` under `on.push`, a tip that touched only
  ignored paths starts no run at all (`git show --stat --format= "$TIP"`): no verdict, never a red.
  With no `paths-ignore` and no run for a tip older than 2 hours, file `main-green` as "no CI run
  for the tip of main".

A red `main` is filed first and blocks `release-due` below.

### `flaky-jobs`

```sh
gh run list --repo "$REPO" --workflow ci-main.yml --limit 50 --json databaseId,attempt,conclusion,createdAt,url
gh run list --repo "$REPO" --workflow ci-pr.yml   --limit 50 --json databaseId,attempt,conclusion,createdAt,url
```

- **Fail:** a run in the last 7 days has `attempt > 1` and `conclusion: success` (it went green only
  on a re-run). For each such run, name the job that failed on the first attempt:
  `gh api repos/$REPO/actions/runs/<id>/attempts/1/jobs --jq '.jobs[] | select(.conclusion == "failure") | .name'`.
  One ask per job name (`check`, `unit tests (<os>)`, `package`, `tmux rig (<version>)`), asking
  for the test to be made deterministic, never retried or skipped.
- Skip a job that an open issue or pull request already names as flaky (the platform's `care`
  lane files these too): `gh issue list --repo "$REPO" --state open --search "flaky <job> in:title"`.

### `dependabot-stuck`

```sh
gh pr list --repo "$REPO" --app dependabot --state open --limit 100 \
  --json number,title,headRefName,createdAt,updatedAt,statusCheckRollup
```

- **Fail (stuck):** an open Dependabot PR with a failed check (`statusCheckRollup[].conclusion` is
  `FAILURE`) and more than 7 days since `updatedAt`. The ask names the failing check and the first
  error line from its log; the fix is code, not a re-run.
- **Fail (security waiting):** an open Dependabot PR from a `*-security` group (`headRefName`
  contains `security`) with green checks, open more than 2 days. Dependency PRs wait for a member
  (`pr.auto_merge_scope: own`), so this ask is addressed to a member.

### `upstream-drift`

The sync point is the merge base of our `main` and upstream `master` (before the first merge it is
the fork point `a00e61a` recorded in `docs/upstream-sync.md` → "Fork point"):

```sh
git remote get-url upstream 2>/dev/null || git remote add upstream https://github.com/jeanp413/open-remote-ssh.git
git fetch --quiet upstream master
SYNC=$(git merge-base origin/main upstream/master)
git log --oneline "$SYNC"..upstream/master          # what is new upstream
```

- **Pass:** the log is empty.
- **Fail:** one tracking ask titled exactly `Upstream sync: merge new jeanp413/open-remote-ssh commits`,
  addressed to a member. Body: `$SYNC`, the commit count, the log, and the files it touches
  (`git diff --stat "$SYNC" upstream/master`) marked against the fork-hunk table in
  `docs/upstream-sync.md` → "Upstream-owned files and our hunks". The merge itself follows
  `docs/upstream-sync.md` → "Merging". It is a member's job, not the bot's: that procedure needs a
  merge commit and this repository allows squash merges only (a squash drops upstream's ancestry and
  the merge base never moves).
- **Also fail, separately:** each new upstream commit that fixes a security issue (subject or body
  names a CVE/GHSA, host-key verification, injection, credentials, or `ssh2`): one ask per commit
  titled `Upstream security fix to port: <upstream subject>`. These are not batched behind the sync.
- **Doc check:** if `$SYNC` is not the fork point / last merge recorded in `docs/upstream-sync.md`,
  that section is stale; `maintain` corrects it, do not file it here.

### `shipped-deps`

What the `.vsix` ships is `package.json` `dependencies`, bundled into `lib/extension.js` by webpack
(`.vscodeignore` whitelists the files; the CI `package` job checks them). `devDependencies` never ship.

```sh
npm audit --omit=dev --json | jq .metadata.vulnerabilities
jq -r '.dependencies | to_entries[] | "\(.key) \(.value)"' package.json
npm view <name> version                       # for each registry dependency
gh api repos/jeanp413/simple-socks/commits/HEAD --jq .sha   # `simple-socks` is a git pin
```

- **Fail (advisory):** `npm audit --omit=dev` reports any vulnerability. One ask per package, unless
  the daily audit's tracking issue (`Scheduled audit: npm audit / zizmor findings`, from
  `.github/workflows/audit.yml`) or an open Dependabot `npm-security` PR already covers it. A high or
  critical one in a shipped dependency is also the one case for an off-cycle release (see
  `release.manager` comment in `.dz/maintainer/maintainer.yml`): say so in the ask.
- **Fail (major behind):** a shipped dependency whose latest version is a new major, or a
  `simple-socks` pin behind its upstream HEAD, with no open Dependabot PR for it. One ask per
  package for a member; runtime dependency changes always get a member's review. An `ssh2` bump also
  needs `scripts/patch-ssh2.js` refreshed (its header lists the steps).
- Dev-only drift is not filed here: Dependabot opens it weekly, and `maintain` bumps the pins
  Dependabot cannot see.

### `acceptance-fresh`

```sh
NEWEST=$(find docs/plans -name 'results-*.md' | sort | tail -1)   # results-YYYY-MM-DD.md
SINCE=$(basename "$NEWEST" .md | sed 's/^results-//')
git log --oneline --since="$SINCE" origin/main -- src/tmux src/extension.ts src/authResolver.ts src/ssh src/serverSetup.ts
```

- **Pass:** no commit since that date touched the terminal layer or the connect path.
- **Fail:** commits did, and a release tag (`$TAG`) already contains them
  (`git merge-base --is-ancestor <commit> "$TAG"`). One ask titled
  `Acceptance run due: terminal-layer changes since <SINCE>`, listing the commits and asking for the
  EDH driver (`test/rig/edh/run.sh <vsix>`, needs docker; the zombie rows 06-09 at minimum) and a new
  `results-<date>.md` beside the plan it verifies.

### `release-due`

Owner rule (`release:` comment in `.dz/maintainer/maintainer.yml`): at most one release a week,
judged on a Monday; a merge, a fix or a fix count never cuts one. The bot never cuts a release
(`release.manager: none`, `channels: []`): this row only recommends one to a member.

```sh
gh release list --repo "$REPO" --limit 1 --json tagName,publishedAt
jq -r .version package.json
git log --format='%h %s' "$TAG"..origin/main
git diff --name-only "$TAG" origin/main -- src webpack.config.js .vscodeignore
for ref in "$TAG" origin/main; do
  git show "$ref:package-lock.json" | jq -S '[.packages | to_entries[]
    | select(.key != "" and (.value.dev // false) == false) | {key: .key, value: .value.version}] | from_entries'
done   # diff the two: a changed shipped (non-dev) package version
for ref in "$TAG" origin/main; do git show "$ref:package.json" | jq -S '{dependencies, contributes, engines}'; done
```

A release is **due** only when every condition holds:

1. `main-green` passed this run.
2. The latest GitHub release was published more than 6 days ago.
3. `package.json` `version` equals `$TAG` without the `v`. If it is higher, a bump is already
   merged and waits for its tag: propose no other version; file `Release v<that version> is due`
   with only the tagging step below, unless an open issue starting `Release v` exists.
4. Something shipped changed since `$TAG`: a file under `src/`, `webpack.config.js` or
   `.vscodeignore`; a shipped package version in the lockfile; or `dependencies`, `contributes` or
   `engines` in `package.json`. Docs, tests, CI and dev-only dependency changes alone are not a release.

Version: a `!` or `BREAKING CHANGE` in the commits since `$TAG` → major; any `feat`/`enhance` →
minor; otherwise patch.

When due, file one ask titled `Release v<X.Y.Z> is due`, addressed to a member, unless an open issue
starting `Release v` exists (then nothing new is filed). Body: the conditions with their evidence,
the commits since `$TAG`, and a draft `## X.Y.Z` section for `CHANGELOG.md` in the existing style
(one line per change, `fix:` / `feat:` / `docs:` prefixes). How a member cuts it:

1. A pull request `build(release): X.Y.Z`: `npm version X.Y.Z --no-git-tag-version` (sets
   `package.json` and `package-lock.json`) and the `## X.Y.Z` section in `CHANGELOG.md`
   (`.github/scripts/get-changelog.js` needs that exact heading, or `publish.yml` fails).
2. After it merges, tag the merge commit: `git tag -a vX.Y.Z -m "Release version X.Y.Z" <sha>` and
   `git push origin vX.Y.Z`. `publish.yml` refuses a tag that is not `v` + the `package.json`
   version, re-runs build, test and lint, and creates the GitHub Release.
   (`npm run release` runs `bin/check`, then bumps, commits, tags and pushes in one step, but its
   push to `main` needs whatever the `main` ruleset requires of a direct push.)

Not due: say which condition failed in the run's summary. File nothing.

## Filing rules

- One ask per failing row (per item where a row says so). A red `main` comes first.
- Before filing, look for an open issue with the exact title:
  `gh issue list --repo "$REPO" --state open --search "<title> in:title" --json number,title`,
  then compare byte for byte. If one exists, file nothing new.
- Titles are stable: nothing that changes run to run (sha, run URL, count) goes in a title. That goes
  in the body, with the command and its output.

## Checks that exist on main

Reference for the rows above. Nothing parses this table; cells cite the file and job or step.

| Check | What it runs | Where it lives |
|---|---|---|
| CI `check` (pull request and push to `main`) | `npm ci` → `npm run build` → `npm test` → `npm run lint:package` + `git diff --exit-code -- package.json` → `npm run lint` → commitlint over the range | `ci-pr.yml` and `ci-main.yml`, job `check` |
| CI `unit tests (<os>)` | `npm test` on Windows and macOS | job `unit-os` |
| CI `package` | Node 22 → `npm ci` → packaging-Node guard → `npm run package` → vsix contents held to `.vscodeignore` | job `package`; `.github/scripts/check-vsix-contents.js` |
| CI `tmux rig (<version>)` | `npm run test:tmux -- <version>`, one job per version in `matrix.tmux` | job `tmux-rig`; versions pinned in `test/rig/compose.yml` |
| Scheduled audit, daily | `npm audit` and pinned zizmor over the workflows; one tracking issue | `.github/workflows/audit.yml` |
| Publish | on a `v*` tag only: tag must equal `v` + `package.json` version; build, test, lint, package, GitHub Release | `.github/workflows/publish.yml` |
| `bin/check` | `npm run compile:src && npm run lint && npm test` (`--full` adds `npm run test:tmux`) — the local gate | `bin/check:9` |
| pre-commit hook | `npx --no lint-staged`, then `npm run compile:src && npm test` (no full `eslint`: weaker than `bin/check`) | `.husky/pre-commit:5-6`; staged set `.lintstagedrc.yml` |
| commit-msg hook | `npx --no commitlint --edit "$1"` | `.husky/commit-msg:4` |
| EDH acceptance driver | real VSCodium in docker against the rig, the acceptance matrix rows by script; not run by CI | `test/rig/edh/run.sh`, `test/rig/edh/README.md` |

`check` is the CI job named in `pr.required_checks` (`.dz/maintainer/maintainer.yml`).

## Gaps: claims that cannot fail here

| Gap | Why it is not a green row |
|---|---|
| EDH acceptance matrix | CI never runs it; it needs docker and a built `.vsix`. Rows 13 (real Windows remote) and 18 (Claude Code TUI) are not automated. `acceptance-fresh` only asks for a run. |
| `bin/check` under CI | no workflow invokes it; CI runs the same steps separately, so a green `bin/check` is a local signal only. |
