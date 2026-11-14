# edh: machines=2
# Row 21 (v1 matrix) — hand-off = adoption. The PC fills a terminal's scrollback (200 numbered
# lines) and closes its window; the laptop opens the workspace and the PC's session appears as
# the laptop's terminal on its own: adopted or taken over (logged), never offered, no new slot,
# one session, the laptop's client the only one, the whole scrollback in it, and the laptop's
# typing reaches it.
A=${EDH_PC} B=${EDH_LAPTOP}
connect "${A}" || exit 1
new_terminal "${A}"
wait_sessions_attached 1 || exit 1
read -r name _ created < <(sessions)
wait_prompt "${name}" || exit 1
type_line "${A}" 'for i in $(seq 1 200); do echo "R21-LINE-$i"; done'
wait_until "scrollback filled" 20 'pane_has "${name}" R21-LINE-200' || exit 1
pc_client=$(client_pids "${name}")
close_window "${A}"
wait_until "PC VSCodium exited" 30 '! codium_running "${A}"' || true

connect "${B}" || exit 1
expect "the laptop holds the PC's session" \
  'wait_until "laptop attached" 40 "[[ \$(client_count ${name}) -eq 1 && \$(client_pids ${name}) != ${pc_client} ]]"'
wait_stable 5 40 || true
dump_remote
expect "same session (name + creation time), and only it" '[[ "$(sessions | awk "{print \$1, \$3}")" == "${name} ${created}" ]]'
expect "laptop log: adopt or hand-off take-over, never an offer, no new slot" \
  '[[ $(log_count "${B}" "-> (adopt|handoff-takeover)") -ge 1 && $(log_count "${B}" "-> offer") -eq 0 && $(log_count "${B}" "new slot") -eq 0 ]]'
expect "the whole scrollback came along (first and last line)" 'pane_has "${name}" R21-LINE-1 && pane_has "${name}" R21-LINE-200'
expect "pty host: 1 tmux, 0 plain" '[[ $(pty_tmux_count) -eq 1 && $(pty_plain_count) -eq 0 ]]'
focus_terminal "${B}"
# Showing the terminal resizes it to the panel (it was attached at a default size); let that
# redraw finish before typing — on tmux 2.6 keys typed into the redraw get scrambled.
wait_prompt "${name}" || true
type_line "${B}" 'echo LAPTOP-TYPED-R21'
expect "the laptop's input reaches the adopted terminal" 'wait_until "laptop typed" 20 "pane_has_line ${name} LAPTOP-TYPED-R21"'
capture "${B}" laptop-adopted
