# Roadmap — deferred, not dropped

The v1 release ([`tmux-approach.md`](tmux-approach.md)) ships the terminals-only
scope: tmux-backed terminal profile, deterministic naming/attach-or-create,
connect-time reaping, and multi-client no-steal semantics. The items below were
considered and explicitly deferred — recorded here so they aren't re-litigated
or silently forgotten, per the "honesty over completeness" principle
([`principles.md`](principles.md)).

## Session-manager tree view

A tree view (mirroring `src/hostTreeView.ts`'s `sshHosts` view) listing tmux
sessions on the connected host, with attach / create / rename / kill commands.

**Why deferred:** the v1 release's attach-or-create + connect-time reap already
satisfy "no zombies" without any UI — a tree view is a discoverability/power-user
affordance, not a correctness requirement. Building it now would add UI surface
before the underlying session model has a release's worth of real usage behind
it. Candidate for a follow-up once the pure-logic layer (`src/tmux/tmuxSession.ts`)
has proven itself.

## Claude Code first-class attach

A dedicated command/UI to attach to "my long Claude Code task" by intent,
rather than by knowing the deterministic session name.

**Why deferred:** v1 resolves this narrowly — `code-<hash>-0` (slot 0, the first
terminal opened in a workspace) is a findable, deterministic name a long task
naturally lands on, and `tmux attach -t code-<hash>-0` works from any client that
knows the host+workspace. That is enough for the headline scenario in
[`why.md`](why.md) without new UI. A first-class "my task" concept (naming by
intent, e.g. tagging a session as *the* long-running one) is real, but depends on
usage patterns not yet observed — revisit alongside the session-manager tree view
above, since the two would likely share affordances.

## Mosh-over-tmux

Layering mosh's roaming transport underneath tmux-backed terminals, so a
network change reconnects invisibly instead of requiring VS Code's own SSH
reconnect-and-reattach.

**Why deferred:** [`decision-mosh-vs-tmux.md`](decision-mosh-vs-tmux.md) already
ruled mosh out as *this release's* transport — it solves live-connection roaming,
not machine hand-off, and hand-off is the headline problem. tmux alone accepts
"reconnect (fast), re-attach" as the honest cost of a dropped network
([`persistence-model.md`](persistence-model.md)). Running mosh underneath the
existing SSH-based server/protocol channel (not replacing it — the protocol
channel is out of scope, see [`CLAUDE.md`](../../CLAUDE.md)) to smooth *just* the
terminal reconnect is a real idea, but it reintroduces a second transport
dependency for a UX polish gain, not a persistence gain. Worth a fresh look only
if seamless roaming becomes an explicit ask, not a nice-to-have.
