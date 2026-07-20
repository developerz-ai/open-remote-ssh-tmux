# Decision: tmux, not mosh

Recorded so nobody re-litigates it. The project started as "SSH → mosh"; we
pivoted to "SSH + tmux" after separating the layers.

## They solve different layers

| | **tmux** (session multiplexer) | **mosh** (mobile-shell transport) |
|---|---|---|
| Persistent process on the VPS | ✅ session survives client death | ⚠️ `mosh-server` survives briefly, then times out |
| **Close PC → open laptop → same session** | ✅ `tmux attach` from any machine | ❌ one client per server, no detach/re-attach |
| Long task survives client disconnect | ✅ decoupled from the client | ❌ dies with the server timeout |
| Roaming / IP change / sleep-wake / seamless reconnect | ❌ SSH drops → manual reconnect | ✅ mosh's whole point |
| Low-latency local echo | ❌ | ✅ |
| Multiple clients on one session | ✅ | ❌ |

One line: **tmux = persistence + machine hand-off. mosh = resilient transport.**

## Why tmux wins for *our* goals

The three headline needs from [`why.md`](why.md):

1. Close PC → open laptop → same terminals → **only tmux does this; mosh cannot.**
2. Long Claude Code task survives disconnect → **tmux** (session persists on the server).
3. Reconnect after a network drop → **tmux** survives it (reconnect is manual but fast); mosh would make it seamless.

Two of three are tmux-only, and the third is *nice-to-have*, not load-bearing.
Meanwhile mosh was the far harder, higher-risk build (no port forwarding, a
custom SSP client, crypto) delivering the piece we needed least.

## What we gave up (accepted)

- **Seamless roaming.** With tmux + SSH, a network change drops the SSH link and
  you reconnect (the session is intact on the server). Not invisible, but the
  work never dies — acceptable.
- **Local echo / latency smoothing.** tmux doesn't provide it. Not a stated need.

## Door left open

mosh and tmux compose (`mosh → tmux`). If seamless roaming ever becomes a real
pain, mosh can be added later as an *optional transport* under the same
tmux-backed persistence — without redoing this work. Not now.
