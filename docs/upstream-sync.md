# Syncing with upstream open-remote-ssh

This repository is a fork of
[jeanp413/open-remote-ssh](https://github.com/jeanp413/open-remote-ssh). The fork's
own work lives in `src/tmux/*`, `src/clipboard/*` and a few new `src/common/*`
leaves, but the upstream files are **not** untouched: security and correctness
fixes landed in them too. This page records where we forked, which upstream files
carry our hunks, and how to merge upstream without losing either side.

## Fork point

`a00e61a` — "build(deps): bump softprops/action-gh-release from 3.0.1 to 3.0.2
(#313)", upstream `master` on 2026-07-20. Verified 2026-11-14:

```bash
git cat-file -t a00e61a                         # commit (present in our history)
git merge-base --is-ancestor a00e61a HEAD       # exit 0
gh api repos/jeanp413/open-remote-ssh/compare/a00e61ad5e8d64d2a63bf2abf60449ba919dabdf...master \
  --jq '.status, .ahead_by, .behind_by'         # ahead, 79, 0 — upstream master descends from it
```

No upstream commit after `a00e61a` has been merged yet. Upstream has moved far
since: 79 commits as of 2026-11-14, including a native-`ssh` connection mode
(`src/native/*`), a `src/server-config/` split, and reworked `src/ssh/*`. The
first merge will be a real one, not a fast-forward.

After a merge, the fork point becomes the merge base:
`git merge-base HEAD upstream/master`. Update this section when that happens.

## Setup

```bash
git remote add upstream https://github.com/jeanp413/open-remote-ssh.git
git fetch upstream
git log --oneline "$(git merge-base HEAD upstream/master)"..upstream/master   # what is new upstream
```

## Upstream-owned files and our hunks

Generated from the working tree on top of `f184425` (2026-11-14), against the fork
point. Regenerate before every merge — the counts move with every PR:

```bash
git diff a00e61a --stat -- src ':!src/tmux' ':!src/clipboard'
```

| File | +/- vs. fork point | Our hunks (search for `Fork:` comments) |
|---|---|---|
| `src/authResolver.ts` | 940 changed | tmux capability probe after connect; terminal env written through `common/envCollection.ts` (diffed); re-resolve teardown of the previous connection, proxy child and tunnels; ProxyCommand stderr drained, `none` honoured, Windows backslashes kept, `.bat`/`.cmd` metacharacter refusal, argument redaction; keepalive from `ServerAliveInterval`/`ServerAliveCountMax`; ProxyJump `forwardOut` bounded by `connectTimeout`; SOCKS and forwarding servers on `127.0.0.1`; host verifier with known-hosts options and `@revoked`; token redaction; explicit `void` on fire-and-forget thenables and two wrapped async callbacks (typed lint) |
| `src/extension.ts` | 1110 changed | the whole tmux layer's wiring (`TmuxLayerController`, `watchTmuxLayerInputs`, the per-connection close watch, housekeeping, notifications, identity), clipboard command, env-collection prep. Upstream's activation body is a few lines; expect to re-apply its changes by hand |
| `src/commands.ts` | 140 changed | kill-workspace-sessions command; explicit `void`s (typed lint) |
| `src/serverSetup.ts` | 219 changed | settings shell/PowerShell-quoted into the install scripts; `uname` (30 s) and install (30 min) deadlines; install script logged once then as a sha256; `listeningOn` parse; launch flags as arrays |
| `src/scripts/server-setup.sh` | 122 changed | quoted variables and launch-flag arrays; release resolution fixes |
| `src/scripts/server-setup.ps1` | 216 changed | single-quoted (escaped) assignments; parity with the bash script |
| `src/serverConfig.ts` | 22 changed | version/quality resolution fixes |
| `src/fetchRelease.ts` | 50 changed | release lookup fixes |
| `src/ssh/sshConnection.ts` | 116 changed | `exec` rejects on stream error; tunnel sockets tracked and destroyed; `close()` bounded to 2 s; listeners on `127.0.0.1`; `execPartial` stops buffering once answered |
| `src/ssh/hostfile.ts` | 336 changed | marker lines (`@revoked`, `@cert-authority` ignored), trailing-newline-safe append, `UserKnownHostsFile` / `GlobalKnownHostsFile` file sets, `HostKeyAlias` lookup name |
| `src/ssh/sshConfig.ts` | 123 changed | `Match` blocks, whitespace-separated `Include`, five more directive names normalised |
| `src/ssh/identityFiles.ts` | 44 changed | agent lookup bounded to 10 s, then key files |
| `src/ssh/sshDestination.ts` | 58 changed | bracketed IPv6 literals (`[::1]:2222`) and port parsing |
| `src/remoteLocationHistory.ts` | 170 changed | read-through `globalState`, empty-host guard, failures never reject activation |
| `src/hostTreeView.ts` | 38 changed | root nodes include hosts known only from folder history |
| `src/common/logger.ts` | 13 changed | Trace lines gated on VS Code's log level |
| `src/common/disposable.ts` | 29 changed | `disposeAll` releases everything, then reports |
| `src/common/files.ts` | 6 changed | small fixes |
| `src/common/ports.ts` | 114 removed | unused helpers dropped; `findRandomPort` binds `127.0.0.1` |
| `src/common/platform.ts` | unchanged | — |

Ours alone (no upstream counterpart): `src/tmux/*`, `src/clipboard/*`,
`src/common/deadline.ts`, `src/common/envCollection.ts`, `src/common/shellQuote.ts`.

Outside `src/`, `package.json` (name, publisher, `contributes`, scripts, pinned
dependencies), `README.md`, `CHANGELOG.md`, the workflows and the lint/test
configuration all diverge; see `git diff a00e61a --stat -- . ':!src' ':!docs' ':!test'`.
For these, keep ours and port upstream's intent by hand.

## Merging

1. Branch: `git checkout -b vcs/upstream-sync-<date> main`.
2. `git fetch upstream && git merge upstream/master` (a merge commit, never a
   rebase — the history of both sides must stay reachable).
3. Resolve conflicts file by file against the table above: keep every `Fork:` hunk
   unless upstream fixed the same thing, and say which in the merge commit body.
   For `src/extension.ts`, take ours and re-apply upstream's activation changes.
   Upstream files that are new to us (`src/native/*`, …) come in as they are; if
   they open a terminal or connection path that bypasses the tmux layer, note it
   and decide in a follow-up, not in the merge.
4. If upstream changed the `ssh2` dependency, follow the refresh steps at the top
   of `scripts/patch-ssh2.js` — it is fail-closed and exits 1 on any version or
   anchor mismatch. Then run
   `npx vitest run test/patch-ssh2.test.ts test/package-ssh2.test.ts test/ssh/ssh2.security.test.ts`.
5. Gate: `npm install` (runs the ssh2 patch), `npm run compile:src`, `npm run lint`,
   `npm test`, `npm run test:tmux`, `npm run build`, then an F5 connect (the zombie
   rows of the acceptance matrix) — upstream changes to the resolver can break the
   terminal layer without touching `src/tmux/*`.
6. Regenerate the table above and update the fork point section in the same PR.

**Cadence:** check upstream monthly (`git log` command under Setup), and
immediately when upstream ships a security fix. Prefer several small merges to one
large one.

## Never use GitHub's "Sync fork" → "Discard commits"

That button resets this repository's `main` onto upstream, dropping every fork
commit. It has happened once: `main` had to be restored by hand, and the commit
lint in `.github/workflows/ci-main.yml` still carries the workaround for the
broken `before` SHA it left behind. Always merge through a branch and a PR as
above.
