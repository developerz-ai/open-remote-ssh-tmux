# Brief: is a release needed?

Monday 07:00 UTC, read-only: files one ask, never a change or PR. Fixes are `maintain`'s
(`.dz/schedules/maintain.md`, 08:00 UTC). The only lane that judges a release (owner, 2026-11-26: at
most one a week). The wider health scout (flaky jobs, stuck Dependabot, upstream drift, acceptance
freshness) was retired 2026-11-28: 270 firings fleet-wide produced 8 asks and 0 merges, and a red
`main` is filed by the platform's red-main ask.

## Rows

- `main-green`: the push run of `ci-main.yml` on the `origin/main` tip concluded `success`
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
as "no CI run for the tip of main". A red `main` makes `release-due` not due.

**`release-due`.** Owner rule: at most one release a week, judged Monday; a merge or a fix never
cuts one. The bot never cuts (`release.manager: none`): this row recommends to a member.

```sh
jq -r .version package.json
git log --format='%h %s' "$TAG"..origin/main
git log --format='%h %s' "$TAG"..origin/main | grep -E '^[0-9a-f]+ [a-z]+(\([^)]*\))?!: '   # `!` in a SUBJECT
for h in $(git rev-list "$TAG"..origin/main); do   # a BODY line (%b: not the subject) that starts a footer
  git log -1 --format=%b "$h" | grep -E '^BREAKING[ -]CHANGE: ' | sed "s/^/$h /"
done
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

Version: a `type!:` subject or a body line starting `BREAKING CHANGE:` (never a quote mid-line) → major; else any
`feat`/`enhance` subject → minor; else patch. The ask (`Release v<X.Y.Z> is due`) carries the
evidence per condition, the commits, draft `docs/changelog/X.Y.Z.md` notes in their style, and
the steps: (a) PR `build(release): X.Y.Z` with `npm version X.Y.Z --no-git-tag-version`, that file
(`# X.Y.Z`, `_Released <date>_`, the notes: `.github/scripts/get-changelog.js` reads it) and its
line at the top of the `CHANGELOG.md` index; (b) after merge,
`git tag -a vX.Y.Z -m "Release version X.Y.Z" <merge sha>` and `git push origin vX.Y.Z`;
`publish.yml` does the rest. Not due: name the failed condition.
