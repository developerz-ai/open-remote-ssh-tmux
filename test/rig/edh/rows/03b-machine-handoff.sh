# edh: machines=2
# Row 3 (v1 matrix) — machine hand-off with a task that keeps running: the PC starts a ticker
# (a loop stamping the time into a file every second) in a terminal and closes its window; the
# laptop opens the same workspace and gets that very terminal — same session (name + creation
# time), the ticker alive and still ticking across the hand-off, the scrollback with it, and
# the laptop's typing reaches it. No second session, one client, no plain shell.
A=${EDH_PC} B=${EDH_LAPTOP}
connect "${A}" || exit 1
new_terminal "${A}"
wait_sessions_attached 1 || exit 1
read -r name _ created < <(sessions)
wait_prompt "${name}" || exit 1
type_line "${A}" 'while :; do date +%s > /tmp/edh-r03b.tick; sleep 1; done & echo $! > /tmp/edh-r03b.pid; echo MARKER-R03B'
wait_until "ticker pid recorded" 20 'rsh "test -s /tmp/edh-r03b.pid"' || exit 1
pid=$(rsh 'cat /tmp/edh-r03b.pid')
pc_client=$(client_pids "${name}")

close_window "${A}"
wait_until "PC VSCodium exited" 30 '! codium_running "${A}"' || true
tick_at_close=$(rsh 'cat /tmp/edh-r03b.tick')

connect "${B}" || exit 1
expect "laptop holds the session (its own client, not the PC's leftover)" \
  'wait_until "laptop attached" 40 "[[ \$(client_count ${name}) -eq 1 && \$(client_pids ${name}) != ${pc_client} ]]"'
wait_stable 5 40 || true
dump_remote
expect "same session (name + creation time)" '[[ "$(sessions | awk "{print \$1, \$3}")" == "${name} ${created}" ]]'
expect "ticker ${pid} alive" 'rsh "kill -0 ${pid}"'
expect "ticker kept ticking through the hand-off" '[[ $(rsh "cat /tmp/edh-r03b.tick") -gt ${tick_at_close} ]]'
expect "marker in scrollback" 'pane_has "${name}" MARKER-R03B'
expect "pty host: 1 tmux, 0 plain" '[[ $(pty_tmux_count) -eq 1 && $(pty_plain_count) -eq 0 ]]'
focus_terminal "${B}"
# Showing the terminal resizes it to the panel (it was attached at a default size); let that
# redraw finish before typing — on tmux 2.6 keys typed into the redraw get scrambled.
wait_prompt "${name}" || true
type_line "${B}" 'echo LAPTOP-TYPED-R03B'
expect "the laptop's input reaches the handed-off terminal" \
  'wait_until "laptop typed" 20 "pane_has_line ${name} LAPTOP-TYPED-R03B"'
capture "${B}" laptop-has-terminal
