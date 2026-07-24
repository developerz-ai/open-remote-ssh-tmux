# Design principles

These follow directly from [`why.md`](why.md). They guide every feature; when a
change conflicts with one, flag it.

## 1. The remote terminals are durable; the client is disposable

The source of truth is the VPS. The machine in front of you is a viewport. No
feature may assume "one client, one connection, forever." Closing a window,
switching machines, or dropping a link must never take remote terminals down.

## 2. Long-running work must outlive the client

If a process is running on the remote (a build, a test suite, **a long Claude
Code task**), the client's connection state is irrelevant to it. Disconnect or
hand off to another machine — the job keeps running to completion. This is the
headline feature, not a nice-to-have.

## 3. Invisible — it feels exactly like open-remote-ssh

Same connect flow, same commands, same host tree, same terminals as the upstream
extension. The user never types a tmux command and never sees that tmux is
involved — it's a pure under-the-hood upgrade. On reconnect (or after a reboot),
VS Code's restored terminals **auto-re-attach** to their sessions with no user
action. If using it requires knowing tmux is there, we've failed this principle.

## 4. tmux owns terminal lifetime — one owner, not two

Terminal persistence lives in the tmux server, not the VS Code window and not the
vscode-server. VS Code's own persistent-terminal layer must not double up on
tmux's — pick tmux as the single owner so re-attach is predictable.

## 5. No zombie sessions

Persistence is not an excuse to hoard. Re-opening the same host+workspace must
re-attach the **same** session (deterministic naming + attach-or-create), never
spawn a duplicate. Sessions whose processes have all exited get reaped;
long-lived intentional ones (the Claude Code task) are kept. The user should
never find a graveyard of orphaned sessions. See [`tmux-approach.md`](tmux-approach.md).

## 6. Keep the SSH transport; add, don't rip out

We are open-remote-ssh + tmux, not a transport rewrite. Everything upstream does
(SSH auth, server install, host tree, config) stays. tmux is an *additive* layer.
This keeps the fork small and mergeable.

## 7. Honesty over completeness

tmux gives persistence + hand-off, not seamless roaming
([`decision-mosh-vs-tmux.md`](decision-mosh-vs-tmux.md)). When the tool can't do
something (seamless reconnect, Windows remotes), **say so and degrade
gracefully** — never fake it. A truthful "reconnect and re-attach" beats a vague
"it just stays connected."

## 8. Security is not traded for persistence

This extension handles keys, credentials, and runs remote commands. Adding tmux
must never weaken host-key verification, leak secrets to logs, or open
shell-injection paths in the commands/scripts we send to the remote.

## 9. Stay a clean fork

We track upstream `jeanp413/open-remote-ssh`. tmux changes stay isolated and
well-labelled, and the tmux integration lives in its own module(s) (not bolted
onto the SSH classes) so upstream fixes keep merging — which is also just good
SRP (see `CLAUDE.md`).

## 10. Keep it small

The codebase is ~2.3k LOC and readable. Prefer deleting to abstracting;
introduce an abstraction only when there's a second real consumer. One
responsibility per module.
