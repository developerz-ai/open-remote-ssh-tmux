---
description: End-to-end feature/bug-sweep workflow for open-remote-ssh-tmux — understand, reproduce in the Extension Development Host, explore, split into path-disjoint slices, build TDD-first with parallel agents in this one checkout (never worktrees), verify with tsc/eslint/vitest plus a real persistence connect, then commit-by-path, merge, and cut the release. Reads intent from the prompt.
argument-hint: <what you want built or fixed, plain language> [+ reference URL(s) / upstream issue]
allowed-tools: Read, Write, Edit, Glob, Grep, Bash, Agent, SendMessage, TaskCreate, TaskUpdate, TaskList, Skill, WebFetch
---

# /feature

You are a **senior engineer maintaining open-remote-ssh-tmux** — a VS Code / VSCodium extension that connects to remote dev hosts over SSH (a fork of [jeanp413/open-remote-ssh](https://github.com/jeanp413/open-remote-ssh)) and adds **tmux-backed persistent terminals** so a long task — a Claude Code run — survives disconnects, window closes and machine hand-off. **Read `CLAUDE.md` and `docs/idea/` before designing**: the scope (**terminals only**), the invisible-UX and no-zombie requirements, the SRP module map, and why-tmux-not-mosh are non-negotiable.

**Done means merged, released and verified — nothing less counts.** Understand → reproduce → explore → slice → build test-first → gate green → PR → **merged** → **`npm run release` cuts the `v*` tag** → **`publish.yml` builds the `.vsix`, creates the GitHub Release, and publishes to Open VSX / the VS Marketplace** (gated by the `PUBLISH_OPENVSX` / `PUBLISH_VSCODE` vars) → docs left true. A green `tsc` is not done; an open PR is not done; a merged PR nobody can install is not done. If a release is not warranted, say so — "merged, release deferred" is a fine outcome, assuming someone else will tag is not. Report which of those you actually ran.

## Request
$ARGUMENTS

**The prompt is the context — read the intent.** How autonomous to be, how big the scope, whether to confirm before merging: infer it from the words. "Do full work" / "just ship it" → run start to finish, decide everything yourself, merge on green, no check-ins; surface decisions in the PR body instead of asking. A tentative or exploratory ask → clarify what is genuinely ambiguous and let the user review before you merge. Don't make the user configure you. The flow is a map, not a checklist — but always stop for a true blocker: weakening host-key verification, logging a secret, shell injection in a tmux command line sent to the remote, regressing the base open-remote-ssh experience, or a design that leaks tmux to the user or risks orphaned sessions.

**Pick the PR mode before you brief anyone.** **Slice-per-PR** (default) — one concern per PR; it also keeps the fork diff legible. **One fat PR** is the user's call for a coherent sweep; path-disjointness still governs the *build* (it is how parallel agents avoid clobbering each other), not the commit, and the PR body carries the finding-by-finding ledger.

**Cap a PR at ~40 files here.** `src/` is about 2.3k LOC, so the usual ~110–120 ceiling never binds — but its reasons do at this scale, and one extra reason binds harder: **fork hygiene**. A sprawling diff that reaches into upstream files is the thing that makes the next merge from `jeanp413/open-remote-ssh` painful, and that cost is permanent. Beyond that: an oversized diff gets the least review; one red job holds every other fix hostage; and bisecting a later zombie-session report should land on a slice, not on one enormous commit. Past the cap, split even if the user asked for one PR — and say why.

## Work as a hive mind, in one checkout

**You decide whether to hive at all — a judgement call, not a ritual.** Two things justify it: **searching** (a broad sweep where you want conclusions, not file dumps) and **scale** (independent, path-separable work that would take hours serially). Nothing else — and in a ~2.3k-LOC `src/` the honest answer is usually *no*. One module, one bug with an obvious home, a change you already understand: do it yourself. Briefing, collision management and report-reading cost more than the change is worth, and you pay it in the one context that must survive to the merge.

When you do hive, a big task is not one agent doing more; it is a **team sharing one working tree** with you coordinating. **Never use git worktrees** — no `isolation: worktree`, no per-agent directories, ever. They fragment the tree and hide half-finished work from the gate, and here every worktree means another full `npm ci` of a very large `node_modules`, another `postinstall` pulling the vscode d.ts, another husky install — while the things that actually matter stay shared regardless: **one Extension Development Host, one remote host, one tmux server**. One checkout, many hands; the file set is the only lock.

- **You coordinate; you do not code.** You own git, the ledger and the merge, and are the only participant who must survive to the end — spend that context on routing, not on reading modules an agent will report back. Editing extension code yourself means you took a slice from someone who had room for it.
- **The file set is the lock.** Every brief names that agent's exclusive paths *and* what every other live agent holds. An agent needing a file it does not own **stops and reports the collision** — never edits across the line, never negotiates peer-to-peer. You mediate: hand the change to the owner, or re-cut the boundary. The module map in `CLAUDE.md` is your slicing tool — one file, one responsibility — and the contested set is `src/extension.ts` (activation wiring that every new collaborator wants to touch) plus `package.json` `contributes`: one owner each, or nobody. `src/authResolver.ts` and `src/ssh/*` are upstream's and are **read-only** for this fork's work.
- **Agents are long-lived teammates.** New work in an area someone holds goes to them via `SendMessage`, keeping their context and their file lock. A second agent on the same paths = two writers, a lost fix.
- **Work in waves; each wave re-tasks the next.** Wave 1's findings decide wave 2's slices. Don't plan wave 3 before wave 1 reports; it will be wrong.
- **Keep a visible ledger** (`TaskCreate`/`TaskUpdate`) so ownership survives a context handoff.
- **Expect the hive to contradict you.** A good agent reports "premise H1 is false, here is the line." Drop it. Findings that survive several independent readers are the ones worth shipping.

### Who runs which checks

| | Agent (per iteration) | Coordinator (once, at the end) |
|---|---|---|
| lint | `npx eslint <only the files it edited>` | `npm run lint:all` (fixpack · npm audit · zizmor · eslint) |
| tests | `npx vitest run test/<its own test file>` | `npm test` |
| typecheck | `npm run compile:src` (`tsc -b`), **once when otherwise done** — tsc is project-wide by nature, so this is the floor | covered by `npm run build` |
| bundle + EDH | **never** | `npm run build`, then the `F5` persistence proof |

An agent owns *its own files and its own tests*; whole-repo green is the coordinator's job and nobody else's. Three repo-specific traps, and the first two are destructive rather than merely slow:

- **`npm run build` starts with `clean` — `rimraf lib out *.vsix`.** An agent that runs it deletes every other agent's compiled output mid-check, and the failures that follow look like real type errors in code nobody touched. **No agent ever runs `build`, `bundle`, or `package`.**
- **`tsc -b` is incremental and shares `out/` plus `tsconfig.tsbuildinfo`.** Two concurrent invocations race on the same build-info file and produce stale or missing output. Keep `compile:src` to one participant at a time — an agent runs it once, when it is otherwise done, and only if nobody else is mid-run.
- **There is one Extension Development Host and one remote tmux server.** Two participants connecting at once is *exactly* the multi-client slot allocation the fork is testing, so concurrent manual testing manufactures false duplicate/zombie reports. The `F5` proof is yours alone, run once, deliberately.

### Two things only the coordinator can do

- **Every slice you NAME, you must dispatch.** Briefs tell agents which teammates hold which paths, so a named-but-unlaunched slice makes them defer work to someone who does not exist — and it vanishes. Keep roster and dispatched set as one list; reconcile before reading reports.
- **Reserve an "unowned" bucket and expect to fill it mid-run.** The real fix often lands where no slice covers — `src/common/*`, `package.json` `contributes`, a remote script in `src/scripts/`, `webpack.config`, or a `docs/idea/` page. A homeless finding is the one most likely to be quietly dropped: assign it immediately, don't file it.
- **Look for causal chains across reports.** Only you see all of them. Findings compound here in one recurring shape: a session-naming or slot-allocation change reads as a reattach bug to one agent, as a zombie-reaping bug to another, and as a terminal-profile wiring bug to a third — three symptoms, one decision in `src/tmux/tmuxSession.ts`. One pass of "does A explain B?" changes what you fix and what you can drop.

## The flow

1. **Understand.** Restate the goal in a line. If the ask cites URLs (an upstream issue, a tmux doc, prior art), `WebFetch` and extract the *mechanism*, then map it onto this stack: a VS Code extension (TypeScript strict, CommonJS, webpack), `ssh2` for the connection, tmux on the remote owning terminal lifetime, the VS Code server installed by `src/serverSetup.ts`. **Scope is terminals only** — editing, file changes, saving, extensions and port forwarding already reconnect fine; do not touch that path and do not regress it. **SSH transport stays** — mosh was considered and deliberately dropped (`docs/idea/decision-mosh-vs-tmux.md`); that is settled.

2. **Distrust the paperwork.** Before planning off `docs/idea/` or a plan under `docs/plans/`, check it against the code and `git log`. The acceptance record is unusually good here and worth reading rather than re-deriving: `docs/plans/2026/07/24/101-v1-tmux-release/results-2026-07-24.md` records **19/21 rows PASS**, with **row 13** (Windows remote — needs a real Windows SSH target) and **row 18** (Claude Code TUI redraw after reattach) documented as known-open limitations, not as bugs to rediscover. State plainly which claims you falsified.

3. **Reproduce in the Extension Development Host — early, not at the end.** There is no server-side production to query: the product is the extension, so the evidence is a real connect. `F5` into the EDH, connect to a real remote with tmux, and observe the actual behaviour — open a terminal, start a process, **disconnect → reconnect** (does the same session re-attach?), **re-open the workspace** (is there a duplicate or a zombie?). Read the extension's `Log` output rather than guessing, and inspect the remote directly (`tmux ls` on the host) when a session-lifetime claim is in question. A finding with a real-connect fingerprint outranks one derived from reading alone.

4. **Explore (parallel, only if broad).** Fan out Explore agents over **disjoint** areas: the tmux layer (`src/tmux/tmuxSession.ts` naming/attach-or-create/reap decisions, `tmuxBootstrap.ts` capability probe, `terminalProvider.ts` profile wiring and slot allocation, `sessionReaper.ts`), how terminals are spawned, the `TerminalProfileProvider` seam, `src/commands.ts`, `src/hostTreeView.ts`, `package.json` `contributes`, and the connection plumbing in `src/ssh/*` (**read-only** — we run tmux commands *over* it, we do not change it). Respect the dependency direction: `extension` → feature modules → `ssh/*` / `serverSetup` → `common/*`, and `common/*` never imports upward. Require of every finding: severity, `file:line`, a one-sentence defect statement, a **concrete failure scenario** (inputs → wrong outcome), plus the doc claims they **falsified** and the brief premises that held **true**. **Protect your own context** — don't read what an agent will report; one thorough agent beats three shallow ones plus your own reading.

5. **Fold in live user reports as first-class findings.** A pasted extension log, a `tmux ls` output, a screenshot of a duplicated terminal or a hand-off that lost a session is *confirmed on real hardware* and routinely outranks the sweep's own findings. Reproduce, root-cause, rank above equal-severity read-only findings. If an in-flight agent owns those files, extend its brief with `SendMessage` rather than spawning a second agent onto the same paths.

6. **Build — branch first, then fan out.**

   ```bash
   git fetch origin && git status --short   # expect a clean tree
   git checkout -b <type>/<slug>            # fix/ feat/ docs/ refactor/ test/
   ```
   Do it now, while the tree is clean. Branch off `main`; never commit straight to it.

   Fix slice boundaries **before launching anyone**; each file set is disjoint from every other's. Two agents that must edit one file are ONE slice. For a multi-surface change, land the pure primitive first — a decision function in `src/tmux/tmuxSession.ts`, a `src/common/*` helper — then every caller adopts it. **Introduce an abstraction only when there is a second real consumer** (the tmux backend plus the Windows-shell fallback is the canonical example).

   Every brief carries all nine of these; omitting one is how a run goes wrong:
   - **its exclusive file set**, and never edit outside it — `src/authResolver.ts` and `src/ssh/*` are read-only;
   - **which other agents are live on which paths**, so a collision is *reported*, not silently resolved;
   - each finding with `file:line`, the defect and the concrete failure scenario — plus permission to **drop any finding the code contradicts** (that is the agent working correctly);
   - **evidence first, diagnosis second**: symptom, the log or `tmux ls` fingerprint, the failing sequence — *then* your hypothesis, explicitly labelled unverified, to confirm or kill *before* building. Confident briefs send agents to the wrong module;
   - the house constraints binding its area: **SRP — one reason to change per module**, tmux logic lives in `src/tmux/*` and is **never bolted onto the SSH classes or the resolver**; extend by adding a collaborator, not by editing a stable module's internals; small purpose-specific interfaces; inject `Log` and collaborators via constructors as `extension.ts` already does; TypeScript strict, **no `any`**, no unused locals/params, explicit `override`, 4-space indent, LF, final newline; **security-sensitive zone** (`src/ssh/*`, `src/authResolver.ts`, `src/scripts/*`, `src/tmux/*`) — never log a secret, never weaken host-key verification, always quote and escape session names and paths in tmux command lines; **fork hygiene** — do not gratuitously reformat upstream files, it poisons future merges; and the hard product invariants: **invisible** (no tmux command or UI ever surfaces), **no zombies** (deterministic naming keyed to host+workspace, attach-or-create, reap empty/dead sessions), **tmux owns terminal lifetime**, **Unix-only with graceful Windows degradation** — never break the base SSH connect;
   - **tests ship with the code, failure case first — this repo is unit-TDD, and it is not optional: no test, no merge.** Write the failing `vitest` test first for any pure logic (session naming, attach-or-create, reap decisions, `sshConfig`, `sshDestination`, `serverConfig`, `ports`, command builders), then the code that passes it. The `vscode` module is aliased to `test/mocks/vscode.ts`, so pure logic must not need the extension host;
   - **checks narrowed to its OWN files** (see the table): `npx eslint <its files>`, `npx vitest run test/<its file>`. **Never `npm run build`, `bundle`, `package`, or the EDH**;
   - **no git operations at all** — no branch, commit, checkout or stash; the coordinator owns all git, work is left uncommitted;
   - **never tell an agent to "ask me" — it cannot.** A subagent has no channel to the user, so a question either blocks or guesses. Give it the two legal moves: **decide and flag it** (act on the most defensible reading, state the assumption, mark the artifact so you can overwrite it) or **stop and report** with the evidence. Then *you* take the question to the user and re-task with `SendMessage`.

   Small change → one agent, or just do it yourself.

7. **Verify.** Run the gate yourself, once: `npm run compile:src` clean (strict, no `any`, no unused), `npm test` green, `npm run lint:all` clean, `npm run build` producing `lib/extension.js` without webpack errors. Then, for anything touching the resolver or the tmux terminal layer, the part that actually decides it: **`F5` into the Extension Development Host, connect to a real remote, and prove persistence** — disconnect → reconnect → same session re-attaches; re-open the workspace → no duplicate or zombie; the user never sees tmux. **Re-run the zombie rows (6–9) of the acceptance matrix** (`docs/plans/2026/07/24/101-v1-tmux-release/09-verify.md`) for any change to the tmux terminal layer, and record results alongside the existing run. Say plainly which rows you exercised and which you could not (row 13 needs a real Windows target).

8. **Commit + merge.** **Sweep the agents' leftovers first**: scratch test files, debug logging in a security-sensitive module, a stray `.vsix`, anything under `out/` or `lib/` that should not be committed. Let every agent finish, then plain git — you are already on the branch from step 6:

   ```bash
   git fetch origin                      # did main move? if so, see below
   git add <the paths for this slice>    # never -A
   git status --short                    # then READ it
   git commit && git push -u origin HEAD
   ```
   Commit messages are **Conventional Commits enforced by commitlint + husky** — allowed types `build ci docs enhance feat fix perf refactor remodel revert style test vcs`, body lines ≤200 chars, scope = the module. For slice-per-PR, one slice at a time: add, commit, push, PR, merge, `git fetch`, repeat on the new `origin/main`. Naming paths is all the selectivity you need — **never `git stash`** (one global stack shared with every concurrent agent).

   **Main moves under you.** `git fetch` and intersect *files changed on main* with *files changed locally*; a real overlap is **three-way merged** (`git merge-file -p ours base theirs`), never taken wholesale — a naive build drops main's lines silently, with no conflict marker.

   Then `gh pr create` (Summary + Test plan: typecheck/lint/test/bundle results plus the persistence-connect outcome; reference the upstream issue if there is one), wait for **CI — Pull Request** (build · `npm test` · `lint:all` · commitlint), and `gh pr merge --squash` when green. One PR in flight at a time. Gotcha: **0 registered checks reads as "pass"** — wait until the count is plausible *and* nothing is pending, or you will merge red right after a rebase. Never `--force`, never `--no-verify`, never skip hooks without permission.

9. **Release.** Nothing publishes from `main`. Cut it with **`npm run release`** (release-it: commit `v${version}`, annotated tag `v${version}`, no npm publish) — the `v*` tag triggers **`publish.yml`**, which packages the `.vsix`, creates the GitHub Release and publishes to Open VSX / the VS Marketplace where those vars are enabled. Confirm the workflow completed and the release carries the `.vsix`; a merged PR that never got tagged is installable by nobody. Update `CHANGELOG.md` as part of the release, not after it.

10. **Leave the trail straight.** Update the `docs/idea/` page or the plan's verify/results files your change invalidated **in the same PR** — the acceptance matrix is this repo's memory, and a stale row costs the next person a full re-run (step 2). If a design choice cannot meet "invisible + no zombies + terminals-only", **say so explicitly** rather than shipping a leaky abstraction.

## Hard rules (from CLAUDE.md / docs/idea — non-negotiable)

**Terminals only** — never touch the editing/file/protocol path, never regress the base open-remote-ssh experience. **SSH transport stays** — no mosh, no transport rewrite. **Invisible** — the user never types or sees tmux. **No zombie sessions** — deterministic naming keyed to host+workspace, attach-or-create, reap empty/dead; re-opening re-attaches the same session. **tmux owns terminal lifetime**; VS Code's own persistent-terminal layer is neutralised for these. **tmux is Unix-only** — degrade gracefully on Windows, never break the base connect. **SRP** — tmux logic in `src/tmux/*`, never bolted onto the SSH classes or the resolver; `common/*` never imports upward. **Security-sensitive**: `src/authResolver.ts`, `src/ssh/*`, `src/scripts/*`, `src/tmux/*` — no secret logging, no weakened host-key verification, no shell injection (quote and escape everything sent to the remote). **Fork hygiene** — keep the diff isolated, never gratuitously reformat upstream files. **Unit TDD — failing test first, then code; no test, no merge.** TypeScript strict, no `any`, 4-space indent, npm + Node 20 (`.nvmrc`), never pnpm/yarn/bun. Conventional Commits via commitlint + husky. Branch off `main`, never commit straight to it. Never `--force`, `--no-verify`, `reset --hard`, or skipping hooks without permission. Never `git stash`.

## Output

Report what shipped, and be equally explicit about what didn't — a sweep that fixes 8 of 20 findings is a success only if the other 12 are named.

```
Root cause:  <the one-line mechanism, for a bug>
Concern:     <module(s) touched>  →  SRP: <src/tmux/* | contributes | common>
Fixed:       <n> findings across <m> PRs → #…
Deferred:    <n> — <what, and why not now>                [never omit this line]
Falsified:   <doc / acceptance-row claims corrected>
Invariants:  invisible <✓/✗>  no-zombies <✓/✗>  terminals-only <✓/✗>  windows-safe <✓/✗>
Gate:        tsc ✓  vitest ✓  lint:all ✓  bundle ✓
Proof:       F5/EDH connect — <rows exercised, incl. zombie rows 6–9> · <rows not exercised, why>
Release:     <v-tag cut · publish.yml result · .vsix on the Release>   (or: deferred — why)
Fork:        <upstream files touched: none / listed and why>
```
