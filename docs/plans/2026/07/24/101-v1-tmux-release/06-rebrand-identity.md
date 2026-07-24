# 06 — Rebrand to open-remote-ssh-tmux

> Part of [`overview.md`](overview.md). Depends on: none (parallel-safe with
> 01-05; must land before 08 release).

Everything is still upstream identity; the extension id
`jeanp413.open-remote-ssh` collides with the published upstream — v1.0.0
cannot ship without this.

## Files to change
- `package.json:2-12` — `name: "open-remote-ssh-tmux"`, `displayName: "Open
  Remote - SSH (tmux)"`, `publisher`: fork's publisher (suggested
  `developerz-ai` — **confirm the real Open VSX/Marketplace account first**),
  `repository.url` + `bugs.url` → `github.com/developerz-ai/open-remote-mosh`
  (or the renamed repo, see step 4), `version` left for 08.
- `README.md:1-99` — full rewrite (it is upstream's verbatim).
- `CHANGELOG.md:1` — add `## 1.0.0` section on top.
- `LICENSE.txt` — keep MIT; add fork copyright line alongside the 2022 one.

## Steps
1. package.json identity fields as above. **Do NOT rename** command ids
   (`openremotessh.*`), view id (`sshHosts`), config keys (`remote.SSH.*`),
   authority (`ssh-remote`), `resourceLabelFormatters`, `activationEvents`
   (`package.json:80-87`) — UX/config parity with upstream is deliberate and
   keeps upstream merges clean.
2. README rewrite, structure:
   - What it is: open-remote-ssh + persistent tmux-backed terminals; one
     paragraph on the PC/laptop hand-off story (crib from `docs/idea/why.md`).
   - Requirements: tmux ≥ 2.6 on Unix remotes; Windows remotes = stock
     behaviour.
   - Setup: same as upstream (keep the product-quality/argv.json instructions,
     **replace `jeanp413.open-remote-ssh` at `README.md:38` with the new id**
     in the `extensionsGallery`/allowlist snippet).
   - Settings table: the three `remote.SSH.tmux.*` keys from 05.
   - Honesty section: what persists / what doesn't (link
     `docs/idea/persistence-model.md`), incl. the `enablePersistentSessions`
     note if 04 chose fallback (b).
   - Credit + link upstream jeanp413/open-remote-ssh prominently (MIT
     etiquette + fork hygiene).
3. CHANGELOG `## 1.0.0`: tmux terminals, settings, kill command, test suite.
   Format must stay parseable by `.github/scripts/get-changelog.js`
   (publish.yml uses it for release notes) — mirror the existing `0.2.0`
   heading style exactly.
4. Repo rename `open-remote-mosh` → `open-remote-ssh-tmux` (GitHub redirects
   old remotes): a human/GitHub-admin step — flag to the owner, don't block
   the plan on it; package.json URLs may point at the final name ahead of the
   rename.
5. `resources/icon.png` — optional differentiation from upstream icon;
  Marketplace does not require it. Skip unless an asset is provided.

## Tests (write first — TDD)
- Extend `test/package-manifest.test.ts` (05): `name === "open-remote-ssh-tmux"`,
  publisher non-`jeanp413`, repository URL contains the fork org; README
  contains the new extension id and NOT `jeanp413.open-remote-ssh` in the
  allowlist snippet; CHANGELOG's first version heading parses via
  `.github/scripts/get-changelog.js` logic.
- Command: `npm test`, `npm run lint` (`lint:package` guards package.json).

## Verify
- `npm run package` → vsix named `open-remote-ssh-tmux-<ver>.vsix`; install it
  into VSCodium side-by-side check: does not clash with upstream id.

## Done when
- No `jeanp413` remains in package.json/README except the credit link;
  CHANGELOG 1.0.0 section present and machine-parseable.
