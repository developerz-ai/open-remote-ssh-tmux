# docs/idea — why open-remote-ssh-tmux exists

The vision and design philosophy behind this fork. Read these before designing a
feature; `/feature` and `/planx` reference them.

The one-line pitch: **your remote terminals should outlive your client.** Close
the lid, switch from PC to laptop, drop the network — the terminals (and the long
Claude Code task inside them) keep running on the VPS, and you re-attach where you
left off. Delivered by backing remote terminals with **tmux**, on top of
open-remote-ssh's existing SSH transport.

## Docs

- [`why.md`](why.md) — the origin story and the concrete scenarios this is built for.
- [`decision-mosh-vs-tmux.md`](decision-mosh-vs-tmux.md) — why tmux, not mosh
  (they solve different layers; tmux is the one we need). Recorded so it isn't
  re-litigated.
- [`tmux-approach.md`](tmux-approach.md) — how tmux integrates into the extension:
  candidate mechanisms, ownership, open questions.
- [`persistence-model.md`](persistence-model.md) — the honest technical picture:
  what gets killed today, what should survive, how tmux fixes it, and what it
  deliberately doesn't (roaming).
- [`principles.md`](principles.md) — the design principles that follow from the why.
- [`ai-first.md`](ai-first.md) — how this repo is set up for AI agents; current
  state vs. target, and the gaps to close.

## The gap in one sentence

`open-remote-ssh` ties your terminals to the client/session — leave and you lose
them; **tmux keeps the terminals (and their processes) alive on the VPS and
re-attachable from any machine**, so open-remote-ssh-tmux brings durable,
hand-off-able sessions to VS Code remote development.
