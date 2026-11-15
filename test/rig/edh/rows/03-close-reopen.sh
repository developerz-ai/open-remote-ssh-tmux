# Row 2 (v1 matrix) — a long process survives closing the WINDOW: close it (the remote marks
# the window's sessions closed when its connection drops — the client itself lingers in the
# pty host, which a closing window cannot stop), reopen the folder, and the same session comes
# back with the process alive and the marker in its scrollback — no duplicate session.
connect "${EDH_PC}" || exit 1
new_terminal "${EDH_PC}"
wait_sessions_attached 1 || exit 1
read -r name _ created < <(sessions)
wait_prompt "${name}" || exit 1
type_line "${EDH_PC}" 'sleep 9999 & echo $! > /tmp/edh-r03.pid; echo MARKER-R03'
wait_until "sleep pid recorded" 20 'rsh "test -s /tmp/edh-r03.pid"' || exit 1
pid=$(rsh 'cat /tmp/edh-r03.pid')

close_window "${EDH_PC}"
wait_until "VSCodium exited" 30 '! codium_running "${EDH_PC}"' || true
expect "closing marked the session closed (or the pty host dropped its client)" \
  'wait_until "closed marker" 20 "[[ \$(closed_marker ${name}) =~ ^[0-9a-f-]+:[0-9]+\$ || \$(client_count ${name}) -eq 0 ]]"'
expect "session kept while the window is closed" '[[ $(session_count) -eq 1 ]]'

connect "${EDH_PC}" 2 || exit 1
wait_sessions_attached 1 60 || true
wait_stable 5 60 || true
dump_remote
expect "same session after reopen" '[[ "$(sessions | awk "{print \$1, \$3}")" == "${name} ${created}" ]]'
expect "one client on it" '[[ $(client_count "${name}") -eq 1 ]]'
expect "sleep ${pid} still alive" 'rsh "kill -0 ${pid}"'
expect "marker in scrollback" 'pane_has "${name}" MARKER-R03'
expect "pty host: 1 tmux, 0 plain" '[[ $(pty_tmux_count) -eq 1 && $(pty_plain_count) -eq 0 ]]'
expect "the reopened window withdrew the close marker" 'wait_until "marker withdrawn" 20 "[[ \$(closed_marker ${name}) != *:* ]]"'
capture "${EDH_PC}" after-reopen
