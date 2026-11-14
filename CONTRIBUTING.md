# Contributing

:+1::tada: First off, thanks for taking the time to contribute! :tada::+1:

This document is intended for anyone considering opening an **issue**, **discussion** or **pull request**.

#### Table Of Contents

- [Code of Conduct](#code-of-conduct)
- [Use of AI](#use-of-ai)
- [I have a bug! / Something isn't working](#i-have-a-bug--something-isnt-working)
- [I have an idea for a feature](#i-have-an-idea-for-a-feature)
- [I want to make changes](#i-want-to-make-changes)
- [Development](#development)
- [Spread the word](#spread-the-word)

## Code of Conduct

This project and everyone participating in it is governed by the [Code of Conduct](CODE_OF_CONDUCT.md). By participating, you are expected to uphold this code.

## Use of AI

We welcome use of AI tools to help draft discussions, issues, or code, but please follow these rules:

- Use AI tools responsibly and disclose their use.
- Ensure all content passes a human review for authenticity and quality.
- Be concise. Do not write verbose discussions, issues or PR.

Discussions, issues or PR that consist solely of unvetted AI outputs may be closed at the maintainer's discretion.

## I have a bug! / Something isn't working

First, search the issue tracker for similar issues.<br />
Tip: also search for [closed issues]; your issue might have already been fixed!

> [!NOTE]
>
> If there is an _open_ issue that matches your problem, **please do not comment on it unless you have valuable insight to add**.
>
> Use the emoji reactions on issues, which are a visible yet non-disruptive way to show your support.

If your issue hasn't been reported already, open a new issue and make sure to fill in the template **completely**. They are vital for maintainers to figure out important details about your setup.

[closed issues]: https://github.com/developerz-ai/open-remote-ssh-tmux/issues?q=is%3Aissue%20state%3Aclosed

## I have an idea for a feature

Like bug reports, first search through issues and try to find if your feature has already been requested. Otherwise, open a new issue.

## I want to make changes

Small and trivial improvements can be submitted without any issues.

**For non-trivial changes**, pull requests should be associated with a **previously accepted issue**.<br />
It's always better to ask for prior approval and discuss what you want to do before doing it.

Discussing that you want to do something doesn't put any obligations on you. If you don't want to start the discussion just because you're afraid that you won't do it. Don't be afraid!

> [!NOTE]
>
> **Pull requests are NOT a place to discuss feature design.** Please do not open a WIP pull request to discuss a feature. Instead, use an issue and link to your branch.

### Code hygiene

When implementing features and bug fixes, please stick to the structure of the codebase as much as possible and do not take this as an opportunity to do some "refactoring along the way".

Similarly:
- **Make your changes** following our code standards
- **Test your changes** thoroughly
- **Update documentation** if needed
- **Commit your changes** with clear, descriptive commit messages

### Version

Do not bump the version number.

### CHANGELOG.md

Do not add an entry to the `CHANGELOG.md` file; maintainers write it at release time.

For a vulnerability, do not open an issue — follow [SECURITY.md](SECURITY.md).

## Development

Start with [`CLAUDE.md`](CLAUDE.md) (stack, module map, commands, house rules) and
[`docs/idea/`](docs/idea/README.md) (why the fork exists and how persistence works).
Merging upstream `jeanp413/open-remote-ssh` follows
[`docs/upstream-sync.md`](docs/upstream-sync.md).

```sh
npm install            # Node 20.20.2 (.nvmrc), npm only
npm run compile:src    # type-check src/ and test/
npm run lint           # eslint
npm test               # unit tests (vitest), seconds
npm run test:tmux      # real tmux over real SSH in docker, every supported tmux version
npm run test:tmux:one  # the same, tmux 3.4 only
```

`npm run test:tmux` needs docker with the compose plugin; without it the run is
skipped locally and fails in CI. Any change to the terminal layer (`src/tmux/*`)
needs it green, plus a real connect from the Extension Development Host (`F5`):
disconnect, reconnect, same terminal; reopen the workspace, no duplicate.

### Building and installing a local VSIX

```bash
npm run package          # produces open-remote-ssh-tmux-<version>.vsix
```

> **Bump the version before reinstalling.** Installing a `.vsix` whose version
> matches the already-installed one is frequently a silent no-op — you keep
> running the old code while believing you upgraded. Either bump `version` in
> `package.json`, or uninstall the extension first.

### Local checks

On Linux or macOS, use Node **20.20.2** (`.nvmrc`) and npm, plus a
supported Python 3 and **pipx** for workflow linting. These are local developer
prerequisites, not requirements for using the extension. npm does **not**
install Python or pipx. Install pipx with your OS package manager (for example,
`brew install pipx` on macOS, or `sudo apt install pipx python3-venv` on
Debian/Ubuntu), then:

```sh
pipx ensurepath
# Open a new shell so the PATH update takes effect, then:
python3 --version
pipx --version
npm install
pipx run zizmor --version
npm run ci:lint
```

See [pipx installation](https://pipx.pypa.io/stable/installation/) for other
Unix distributions. Ensure `pipx` is on the PATH inherited by your editor's
Git hooks, not just an interactive shell. `pipx run zizmor` acquires zizmor in
an isolated cached environment; no global `zizmor` executable is needed.
First use (and cache refresh) requires network access to the Python package
index and writable pipx/cache directories. An offline empty cache cannot run
this check; acquisition errors fail the hook rather than skipping it.

### Maintenance tools (Linux/macOS)

These tools maintain this repository; they are not extension requirements.
Complete maintenance setup requires **both** steps:

1. From the repository root, run `npm install` (also run by `bin/setup`) to
   install the pinned **project-local artifact** CLI, including devDependencies.
2. Install official **pinact**, a separate Go binary, not an npm dependency.
   With Homebrew on Linux/macOS, run `brew install pinact`. Alternatively,
   download the Linux/macOS release binary for your architecture and verify it
   using the upstream
   [installation and verification instructions](https://github.com/suzuki-shunsuke/pinact/blob/main/INSTALL.md).
   Place the verified executable in a directory on the **PATH inherited by npm**,
   not only behind an interactive shell alias. For example, if installed in
   `$HOME/.local/bin`, run `export PATH="$HOME/.local/bin:$PATH"` before invoking
   npm, and persist that PATH in the environment used by your editor or hooks.
   For Homebrew, ensure its binary directory is likewise on npm's PATH.

`npm install` (or `bin/setup`) alone does **not** install pinact; it completes
only step 1. After both steps, check installation from the repository root
without updating maintenance files:

```sh
./node_modules/.bin/artifact --help
npm run update:artifacts -- --help
pinact --version
pinact run --help
npm run update:ci -- --help
```

When deliberately refreshing maintenance files, run:

```sh
npm run update:artifacts
npm run update:ci
```

Installation and real updates require network access. Unlike the help/version
checks, real updates **modify repository files**: artifact refreshes files
managed by `.artifactrc.yml`, and pinact updates GitHub Actions pins in workflow
files. Review the resulting diff before committing. `update:ci` preserves
`PINACT_MIN_AGE=7 pinact run --update`: the seven-day release cooldown remains
in force. Neither update target runs automatically during installation.

### What the hook checks

[`.lintstagedrc.yml`](.lintstagedrc.yml) runs fixpack on a staged `package.json`,
ESLint on staged `*.ts`, and `pipx run zizmor` on staged workflow YAML, with
lint-staged appending the matched paths. `npm run ci:lint` checks
all workflows via `pipx run zizmor .`; `npm run ci:lint:fix` uses the same
command with `--fix=all` (and can modify workflows).
[The pre-commit hook](.husky/pre-commit) runs lint-staged, then compilation and
tests. Husky invokes it with `sh -e`: a failed staged check stops the hook.

**The TypeScript glob is not root-only.** Installed lint-staged **16.4.0**
enables `matchBase: !pattern.includes('/')` in
[`lib/matchFiles.js:10–21`](https://github.com/lint-staged/lint-staged/blob/v16.4.0/lib/matchFiles.js#L10-L21).
[`lib/generateTasks.js:22–40`](https://github.com/lint-staged/lint-staged/blob/v16.4.0/lib/generateTasks.js#L22-L40)
matches relative paths and returns absolute task paths by default. Keep
`"*.ts": eslint`: it already includes nested TypeScript files.

### Reproduce the evidence

```sh
npm test -- test/lint-staged.test.ts --maxWorkers=2
```

Observed by editor[bot] in the focused run (`npm test -- test/lint-staged.test.ts
--maxWorkers=2`, Vitest **4.1.10**, Node **v24.21.0**): **8 passed, 1 skipped,
0 failed (9 total)**, command exit **0** — on this box, which has no `pipx`.
Real ESLint **10.5.0**, invoked through installed lint-staged's task runner on
temporary nested TypeScript files, returned **0** for valid code and **1** for
`@typescript-eslint/no-explicit-any`; the task runner propagated that failure.
This is file-based execution, not stdin-only evidence. Matcher tests loaded the
actual YAML and installed lint-staged internals through native ESM: root and
nested TS reach ESLint, unrelated files do not, and workflow paths are retained.
The matcher anchors above disprove the root-only premise; no glob correction was
needed. On a box where `pipx` and `python3` are on PATH and PyPI is reachable,
the same command runs all nine tests — the gated acquisition test executes for
real instead of skipping.

**Stub evidence, not real zizmor:** the regression test executes lint-staged's
actual task runner with a temporary pipx stub, checks its exact appended
arguments, and observes success/failure for stub exits **0/17**. Temporary
npx/npm stubs run the real pre-commit script under `sh -e`: exits **0/23**
propagate, and failure prevents compilation/tests from being invoked. No Git
operations or real compilation are performed by these stub tests.

**Real zizmor integration is gated, not blocked:** where `pipx` and `python3`
are on the parent PATH and `https://pypi.org/simple/` answers within its short
timeout, the integration test acquires real zizmor through `pipx run` with a
cold cache and requires an actual `template-injection` finding naming the unsafe
workflow plus a propagated nonzero exit — there, a failed acquisition fails the
test. Where a prerequisite is missing, Vitest reports the test as **skipped**
with the reason logged (this run: `Skipped real zizmor acquisition —
environment lacks: pipx on PATH`), so it is visible in the summary and never
counts as passed. The previous hard-fail-on-missing-prerequisite behaviour made
`npm test` require pipx and PyPI network access everywhere, contradicting
[the prerequisite list above](#local-checks) that positions pipx as
optional.

The real-acquisition path requires Unix, executable `pipx` and `python3` on the
parent PATH, Python venv support, network access to the Python package index,
and a writable temporary directory. It deliberately starts with fresh pipx home,
application, man, XDG cache and pip cache directories on every run, so a warm
user cache is insufficient for offline execution. Its child PATH exposes only
the real pipx and Python prerequisites, not any global zizmor. The test logs
Node/Python/pipx and acquired zizmor versions, checks real valid and unsafe
workflow fixtures through lint-staged, and requires a `template-injection`
finding naming the unsafe file plus a propagated nonzero exit. Acquisition and
task subprocesses have bounded timeouts; temporary fixtures and caches are
removed in `finally`. Missing pipx, python3, or PyPI reachability produce a
logged skip, never a silent pass; where the prerequisites exist, a failed
acquisition fails the test. The negative case that must never be skipped has
its own unconditional test: it hands the staged workflow task a PATH containing
only an empty `bin/` directory — no `pipx` anywhere — and requires the task to
fail loudly (`Task failed to spawn`, nonzero exit; measured `exitCode=-2` in
this run), so the hook can never silently pass the workflow check on a
pipx-less box.

**Harness-only evidence:** end-to-end staged Git/Husky execution on valid and
invalid representative TS/workflows, standalone workflow lint, and the full
repository gate were not run by the editor. Stub hook tests do not prove any
of those checks. The harness must record their real statuses separately.
Fixpack, ESLint and zizmor remain enabled and enforced in the hook. `npm audit`
audits the whole resolved dependency tree, not the staged `package.json`, so it
deliberately does not gate per-file commits. It is not silenced — `npm run
lint:all` still runs it locally (`package.json` script `lint:all`), the daily
`audit.yml` workflow runs it together with zizmor and opens a tracking issue
on findings, and `npm run audit:fix` is the remediation path. Pull-request and
`main` CI run `lint:package` and `lint` instead, so a newly published advisory
cannot red a change that touched nothing.

**Measured audit result (2026-11-12, 23:55 UTC, `date -u`):** `npm audit`
(the exact command in `lint:all`) against the current tree exited `0` and
printed `found 0 vulnerabilities`. `npm audit --json` agrees: 0 advisories in
total (info 0, low 0, moderate 0, high 0, critical 0), so there are no advisory
ids to list, across 939 resolved dependencies (27 prod, 910 dev, 68 optional,
1 peer). At this measurement the audit step neither refuses a commit nor reds
CI. `package.json`, `package-lock.json`, the overrides and any audit
configuration were not changed to get this result; the count is a point-in-time
reading and moves as new advisories are published.

## Spread the word

Do you like the project?

* Spread the word in social networks!
* Talk about it to your colleagues and friends
* Write a blogpost
* Record a YouTube video
