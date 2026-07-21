# open-remote-mosh

A VS Code / VSCodium extension (repo name notwithstanding, the project calls itself **open-remote-ssh-tmux**) that connects to a remote dev machine over SSH. It is a fork of `jeanp413/open-remote-ssh` and is deliberately identical in look and feel, with exactly one under-the-hood upgrade: remote terminals are backed by **tmux** so they persist and can be re-attached from any machine. The motivating use case is machine hand-off — close the PC, open the laptop, and re-attach to the same live terminals with a long-running task (e.g. a Claude Code run) still going. Mosh was evaluated for seamless roaming and deliberately dropped because it cannot do machine hand-off.

- **Stack:** TypeScript, bundled with webpack, compiled via `tsc -b`. `ssh2` for the SSH transport (unchanged from upstream). ESLint + husky + lint-staged + commitlint, `release-it` for releases. Ships as a `.vsix` VS Code extension package. tmux is Unix-only; the extension degrades gracefully on Windows remotes.
- **Key commands:**
  - `npm run build` — clean + `compile:src` + webpack production bundle
  - `npm run watch:src` — tsc-watch with a dev bundle on success
  - `npm run lint` / `npm run lint:fix` / `npm run lint:all` — ESLint, plus fixpack, npm audit, zizmor
  - `npm run package` — build the `.vsix`
  - `npm run release` — release-it
- **Layout:** (~2.3k LOC, one responsibility per module)
  - `src/extension.ts` — activation wiring only; no logic
  - `src/authResolver.ts` — resolve the remote authority (upstream core; left alone, scope is terminals only)
  - `src/tmux/` — the fork's addition: tmux session lifecycle (deterministic naming, attach-or-create, restore mapping, reaping) and VS Code terminal-profile wiring
  - `src/serverSetup.ts`, `src/serverConfig.ts`, `src/fetchRelease.ts` — install/locate the VS Code server on the remote
  - `src/ssh/`, `src/common/`, `src/commands.ts`, `src/hostTreeView.ts` — SSH plumbing, shared utilities, command palette entries, host tree UI
  - `docs/idea/` — the "why": persistence model, tmux approach, the mosh-vs-tmux decision, the AI-first stance
- **Hard requirements from CLAUDE.md:** scope is terminals only (do not touch or regress editing/saving/extensions/port-forwarding); the SSH transport stays; tmux must be invisible to the user; no zombie sessions.
- **State as of 2026-07-21:** on branch `master`; working tree was clean when this note was written.
