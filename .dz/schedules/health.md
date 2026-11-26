# Brief: weekly health and release judgement

Monday 07:00 UTC, read-only scout: files asks, never a change or PR. Fixes are `maintain`'s
(`.dz/schedules/maintain.md`, 08:00 UTC).

## Rows

One ask per failing row; it lists every item that row found.

- `main-green`: the push run of `ci-main.yml` on the `origin/main` tip concluded `success`
- `flaky-jobs`: no CI run in the last 7 days went green only on a re-run
- `dependabot-stuck`: no open Dependabot PR has a failed check and 7+ days since `updatedAt`
- `security-pr-waiting`: no green Dependabot `*-security` PR has waited 2+ days for a member
- `upstream-drift`: no upstream `jeanp413/open-remote-ssh` commit since our sync point
- `upstream-security`: no unported upstream commit fixes a security issue
- `shipped-deps`: what the `.vsix` ships has no advisory and no major behind
- `acceptance-fresh`: the newest acceptance results postdate released terminal-layer changes
- `release-due`: no release is owed under the Monday rule below (owed: the ask recommends it)

## Setup

```sh
REPO=developerz-ai/open-remote-ssh-tmux
TIP=$(git rev-parse origin/main)
# last STABLE release: preview.yml tags prereleases (v1.4.3-beta.0); never use those here
gh release list --repo "$REPO" --exclude-drafts --exclude-pre-releases --limit 1 --json tagName,publishedAt
TAG=<tagName>; PUBLISHED=<publishedAt>
```

Unreadable output is no verdict: retry once, then say so; never file it. Skip a row an open issue
or PR already covers. No shas, URLs or counts in titles.

## Checks

**`main-green`.** `gh run list --repo "$REPO" --workflow ci-main.yml --branch main --event push --limit 5 --json conclusion,status,headSha,url`.
Fail: the run with `headSha == $TIP` concluded `failure`, `timed_out` or `startup_failure`; name
the failed jobs (`gh run view <id> --repo "$REPO" --json jobs`). Still running: no verdict. No run
for `$TIP`: no verdict if `on.push` in `ci-main.yml` has `paths-ignore` and the tip touched only
ignored paths (`git show --stat --format= "$TIP"`); otherwise, once the tip is 2+ hours old, fail
as "no CI run for the tip of main". A red `main` is filed first and makes `release-due` not due.

**`flaky-jobs`.** All runs of the last 7 days, every page:

```sh
SINCE=$(date -u -d '7 days ago' +%F)
gh api --paginate "repos/$REPO/actions/runs?created=>=$SINCE&per_page=100" \
  --jq '.workflow_runs[] | select(.run_attempt > 1 and .conclusion == "success") | [.id, .name] | @tsv'
gh api "repos/$REPO/actions/runs/<id>/attempts/1/jobs" --jq '.jobs[] | select(.conclusion == "failure") | .name'
```

Fail: any job that failed on attempt 1 of such a run. The ask names each job with its first-attempt
log and asks for a deterministic test, never a retry or skip.

**`dependabot-stuck`, `security-pr-waiting`.**
`gh pr list --repo "$REPO" --app dependabot --state open --limit 100 --json number,headRefName,createdAt,updatedAt,statusCheckRollup`.
Stuck: a `FAILURE` in `statusCheckRollup` and `updatedAt` 7+ days ago; name the check and first error
line. Waiting: `headRefName` contains `security`, checks
green, `createdAt` 2+ days ago; for a member (`pr.auto_merge_scope: own`).

**`upstream-drift`, `upstream-security`.** The sync point is the merge base (before the first
merge, the fork point `a00e61a` in `docs/upstream-sync.md`):

```sh
git remote get-url upstream 2>/dev/null || git remote add upstream https://github.com/jeanp413/open-remote-ssh.git
git fetch --quiet upstream master
SYNC=$(git merge-base origin/main upstream/master)
git log --format='%h %s' "$SYNC"..upstream/master
git diff --stat "$SYNC" upstream/master
```

Drift fails on any commit: one tracking ask for a member with `$SYNC`, the count, the log and the
touched files marked against the fork-hunk table in `docs/upstream-sync.md`. The merge is a
member's (`docs/upstream-sync.md` → "Merging"): it needs a merge commit, and this repo allows
squash merges only, which would drop upstream's ancestry. Security fails on a commit whose message
(`git log --format=%B`) names a CVE/GHSA, host-key verification, injection, credentials or `ssh2`;
the ask lists each, to port ahead of the sync.

**`shipped-deps`.** The `.vsix` ships `package.json` `dependencies`, bundled into
`lib/extension.js`; `devDependencies` never ship.

```sh
npm audit --omit=dev --json | jq '.vulnerabilities | map_values({severity, fixAvailable,
  via: [.via[] | if type == "object" then {title, url, severity, range} else . end]})'
jq -r '.dependencies | to_entries[] | "\(.key) \(.value)"' package.json
npm view <name> version                                      # each registry dependency
gh api repos/jeanp413/simple-socks/commits/HEAD --jq .sha    # the git pin
```

Fail: any advisory (name package, advisory title, URL, severity, range), a dependency whose latest
is a new major, or `simple-socks` behind HEAD, unless `audit.yml`'s issue
(`Scheduled audit: npm audit / zizmor findings`) or an open Dependabot PR covers it. High or
critical in a shipped dependency is the one off-cycle release case (`release:` comment in
`.dz/maintainer/maintainer.yml`): say so. An `ssh2` bump also needs `scripts/patch-ssh2.js`
refreshed (steps in its header). Dev-only drift is Dependabot's and `maintain`'s.

**`acceptance-fresh`.** Newest by the date in the filename, across all plan dirs:

```sh
NEWEST=$(find docs/plans -name 'results-*.md' | awk -F'results-' '{print $NF" "$0}' | sort | tail -1 | cut -d' ' -f2)
SINCE=$(basename "$NEWEST" .md | sed 's/^results-//')
git log --format='%h %s' --since="$SINCE" "$TAG" -- src/tmux src/extension.ts src/authResolver.ts src/ssh src/serverSetup.ts
```

Fail: non-empty. Ask for an EDH run (`test/rig/edh/run.sh <vsix>`, docker; rows 06-09 at least)
and a new `results-<date>.md` beside its plan.

**`release-due`.** Owner rule: at most one release a week, judged Monday; a merge or a fix never
cuts one. The bot never cuts (`release.manager: none`): this row recommends to a member.

```sh
jq -r .version package.json
git log --format='%h %s' "$TAG"..origin/main
git log --format=%B "$TAG"..origin/main | grep -E '^[a-z]+(\([^)]*\))?!: |^BREAKING[ -]CHANGE: '
git diff --name-only "$TAG" origin/main -- src scripts/patch-ssh2.js webpack.config.js .vscodeignore
for ref in "$TAG" origin/main; do
  git show "$ref:package-lock.json" | jq -S '[.packages | to_entries[]
    | select(.key != "" and (.value.dev // false) == false) | {key: .key, value: .value.version}] | from_entries'
  git show "$ref:package.json" | jq -S '{dependencies, contributes, engines}'
done
```

Due only when all hold: (1) `main-green` passed; (2) `$PUBLISHED` is 6+ days ago; (3) `version`
equals `$TAG` minus `v`; (4) something shipped changed: a path in the `git diff` above, a non-dev
lockfile version, or `dependencies`/`contributes`/`engines`. Docs, tests, CI, dev-only: no release. If `version` is above `$TAG`, a bump is merged and only its tag is owed: the
ask gives just the tag step.

Version: the `grep` matches (a `type!:` header or `BREAKING CHANGE:` footer) → major; else any
`feat`/`enhance` subject → minor; else patch. The ask (`Release v<X.Y.Z> is due`) carries the
evidence per condition, the commits, a draft `## X.Y.Z` `CHANGELOG.md` section in its style, and
the steps: (a) PR `build(release): X.Y.Z` with `npm version X.Y.Z --no-git-tag-version` and that
section (`.github/scripts/get-changelog.js` needs the exact heading); (b) after merge,
`git tag -a vX.Y.Z -m "Release version X.Y.Z" <merge sha>` and `git push origin vX.Y.Z`;
`publish.yml` does the rest. Not due: name the failed condition.

## Reference: CI on main

`ci-pr.yml`/`ci-main.yml`, Node from `.nvmrc`: job `check` (`npm ci`, `npm run build`,
`npm run test:coverage`, `lint:package` + diff guard, `npm run lint`, commitlint), `unit-os`
(`npm test`, Windows/macOS), `package` (`npm run package`, vsix vs `.vscodeignore`), `tmux-rig`
(`npm run test:tmux -- <v>` per `matrix.tmux`). `audit.yml` daily; `publish.yml` on `v*`. Local
only: `bin/check`, the hooks (`npx --no lint-staged`; `npx --no -- commitlint --edit "$1"`), and
the EDH driver (`test/rig/edh/run.sh`; rows 13, 18 manual).
