# edh: machines=2
# Row 22 (hardening sweep) — clean hand-off between two machines, then the first comes back:
#   laptop opens a terminal (marker + sleep) and closes its window cleanly — the remote marks
#   the laptop's sessions closed when its connection drops;
#   PC opens the workspace and takes that session over at once, with no offer and without
#   waiting out the idle threshold (scrollback intact, no second session: bug C);
#   laptop reopens: PC's client must stay attached (no eviction) and the laptop is offered
#   a take-over (handOff=auto, PC is live) — logged as `-> offer`, notification on screen.
A=${EDH_PC} B=${EDH_LAPTOP}
connect "${B}" || exit 1
new_terminal "${B}"
wait_sessions_attached 1 || exit 1
name=$(session_names)
wait_prompt "${name}" || exit 1
type_line "${B}" 'sleep 9999 & echo $! > /tmp/edh-r22.pid; echo MARKER-R22'
wait_until "sleep pid recorded" 20 'rsh "test -s /tmp/edh-r22.pid"' || exit 1
pid=$(rsh 'cat /tmp/edh-r22.pid')
laptop_client=$(client_pids "${name}")
close_window "${B}"
wait_until "laptop VSCodium exited" 30 '! codium_running "${B}"' || true
expect "laptop's close marked its session closed (or the pty host dropped its client)" \
  'wait_until "closed marker" 20 "[[ \$(closed_marker ${name}) =~ ^[0-9a-f-]+:[0-9]+\$ || \$(client_count ${name}) -eq 0 ]]"'

t_pc=$SECONDS
connect "${A}" || exit 1
expect "PC took the session over (its own client, not the laptop's leftover)" \
  'wait_until "taken over" 40 "[[ \$(client_count ${name}) -eq 1 && \$(client_pids ${name}) != ${laptop_client} ]]"'
note "PC holds the session $((SECONDS - t_pc))s after opening"
wait_stable 5 40 || true
pc_client=$(client_pids "${name}")
note "PC client pid: ${pc_client}"
expect "PC log shows an adopt or a take-over, never an offer" \
  '[[ $(log_count "${A}" "-> (adopt|handoff-takeover)") -ge 1 && $(log_count "${A}" "-> offer") -eq 0 ]]'
expect "PC: one session, one tab — VS Code's relaunch of the laptop's terminal got it (bug C)" \
  '[[ $(session_count) -eq 1 && $(log_count "${A}" "new slot") -eq 0 ]]'
expect "scrollback came with it" 'pane_has "${name}" MARKER-R22'
# Keystroke on the PC so its client is unmistakably live (client_activity moves on input).
focus_terminal "${A}"
type_line "${A}" 'echo PC-IS-LIVE'
wait_until "PC typed" 20 'pane_has "${name}" PC-IS-LIVE' || true

connect "${B}" 2 || exit 1
wait_stable 8 60 || true
dump_remote
expect "PC's client still attached (not evicted)" '[[ "$(client_pids "${name}")" == "${pc_client}" ]]'
expect "still one session" '[[ $(session_count) -eq 1 ]]'
expect "sleep ${pid} still alive" 'rsh "kill -0 ${pid}"'
expect "laptop log shows the offer decision" '[[ $(log_count "${B}" "-> offer") -ge 1 ]]'
capture "${B}" laptop-offer
capture "${A}" pc-still-attached
