# Bug sweep: terminals, connection, tooling (2026-11-26)

## Goal
Find and fix the subtle bugs a full hardening sweep left behind, make the tooling current, and
make the weekly maintenance real. Owner asks during the run: "great dev exp, cicd", "latest libs
deps", "60 days stale, dz is the owner", "great dz integration for maintenance weekly", release.

## How
- Wave 1: eight read-only reviewers on disjoint areas (terminalProvider; tmuxSession/bootstrap/
  remoteExec; reaper/slot/identity; extension+commands; authResolver+ssh+common; serverSetup+
  scripts; clipboard; UI+manifest), each finding with file:line and a concrete failure scenario.
- Wave 2-3: the reviewer that found a bug fixed it, test-first, on its own file set; a DX/CI
  owner, a dz owner and a dependency pass were added on the owner's asks.
- The developerz.ai PR review ran on every push; each real finding was fixed the same way.
- Proof: unit suite, the real-tmux rig on 2.6/3.0a/3.4/3.5a/3.8, and the real-VSCodium EDH
  driver on the exact shipping `.vsix` (see `results-2026-11-26.md`).

## PRs
| PR | Scope |
|---|---|
| #86 | toolchain on Node 24, latest deps, CI/DX fixes, dz weekly briefs, actions/stale removed |
| #87 | tmux terminal layer: revive/kill races, wiring races, TUI rendering (row 18), reaper |
| #88 | connection and security: known_hosts patterns, ProxyCommand vetting, server-setup injection, deps |

Split under the ~40-file cap (`docs/standards/pr-batching.md`) for review and fork hygiene.
