# 07 — Docs update (idea → implemented reality)

> Part of [`overview.md`](overview.md). Depends on: 04, 05 (needs the actual
> decisions: route A/B, dedupe mechanism, settings).

docs/idea/ is the *why* and stays; it must stop reading as pure future tense
once the feature exists, and every open question must be closed with the
decision actually taken.

## Files to change
- `docs/idea/tmux-approach.md` — close the open questions (`:78-89`): chosen
  injection route (A profile-provider / B settings-injection + why, from 04's
  spike), final naming scheme + hash function (02), resize/reflow stance,
  Claude Code attach story (v1 answer: deterministic names make
  `code-<hash>-0` findable; first-class command = roadmap), Windows answer
  (feature off, log line). Mark the three "candidate mechanisms" list with
  what shipped vs deferred (session tree view → roadmap).
- `docs/idea/persistence-model.md` — flip "tmux fixes" (`:34-46`) from future
  to present tense; verify the "NOT fixed" list (`:49-56`) is still accurate
  post-implementation; acceptance north star (`:59-67`) cross-linked to
  `09-verify.md` matrix results; add the **multi-client model** (rules from
  `04-terminal-profile.md` steps 1/2/2b: no stealing attached sessions,
  per-client mapping, adoption of detached orphans — PC + laptop scenario).
- `docs/idea/ai-first.md` — update the current-state table (`:44-54`): test
  suite ✅ (01), tmux built test-first ✅; leave genuinely-open gaps honest
  (CodeGraph, bin/ scripts if 08 defers them).
- `docs/idea/principles.md:27-47` — fix the duplicated section numbering
  (two "4"s, two "5"s) while touching the file.
- `docs/idea/README.md` + `docs/idea/why.md` — skim pass: fix stale claims,
  keep the narrative.
- `CLAUDE.md` — "no test suite wired up yet" claims (Build & verify + AI-first
  sections) become "vitest, `npm test`"; SRP table row for `src/tmux/*` lists
  the real files (`tmuxSession.ts`, `tmuxBootstrap.ts`, `terminalProvider.ts`,
  `sessionReaper.ts`).

## Steps
1. After 04/05 merge, sweep each file above; change decisions-recorded, not
   history — the *why* docs keep their reasoning, add "Decision (v1.0.0):"
   lines rather than rewriting arguments.
2. Every settings key / command / behaviour named in docs must match the
   shipped `package.json` — grep docs for `remote.SSH.tmux` and verify against
   05's table.
3. Add a short `docs/idea/roadmap.md` (or a Roadmap section in README.md of
   docs/idea) for the consciously deferred items: session-manager tree view,
   Claude Code first-class attach command, mosh-over-tmux transport
   (`decision-mosh-vs-tmux.md:39-42`).

## Tests (write first — TDD)
- No unit tests (prose). Drift guard: extend `test/package-manifest.test.ts`
  with a check that every `remote.SSH.tmux.*` string mentioned under `docs/`
  exists in package.json configuration (cheap fs+regex scan).
- Command: `npm test`, `npm run lint`.

## Verify
- Read-through: a newcomer reading CLAUDE.md + docs/idea gets the shipped
  design, not a stale plan; no future-tense promises for shipped behaviour;
  no doc references a setting/command that doesn't exist.

## Done when
- All open questions in tmux-approach.md carry a recorded decision; ai-first
  table truthful; CLAUDE.md matches reality; drift-guard test green.
