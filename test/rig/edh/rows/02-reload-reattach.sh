# Rows 2/4-lite (v1 matrix) — a long process survives a window reload: start `sleep` plus a
# marker in the terminal, Developer: Reload Window, and the SAME session (name + creation
# time) is back on screen with the process alive, the marker in its scrollback, and no
# second terminal for it.
connect "${EDH_PC}" || exit 1
new_terminal "${EDH_PC}"
wait_sessions_attached 1 || exit 1
read -r name _ created < <(sessions)
wait_prompt "${name}" || exit 1
type_line "${EDH_PC}" 'sleep 9999 & echo $! > /tmp/edh-r02.pid; echo MARKER-R02'
wait_until "sleep pid recorded" 20 'rsh "test -s /tmp/edh-r02.pid"' || exit 1
pid=$(rsh 'cat /tmp/edh-r02.pid')

reload_window "${EDH_PC}"
wait_wired "${EDH_PC}" 2 || exit 1
wait_sessions_attached 1 60 || true
wait_stable 5 60 || true
dump_remote
expect "same session after reload" '[[ "$(sessions | awk "{print \$1, \$3}")" == "${name} ${created}" ]]'
expect "one client on it" '[[ $(client_count "${name}") -eq 1 ]]'
expect "sleep ${pid} still alive" 'rsh "kill -0 ${pid}"'
expect "marker in scrollback" 'pane_has "${name}" MARKER-R02'
expect "pty host: 1 tmux, 0 plain" '[[ $(pty_tmux_count) -eq 1 && $(pty_plain_count) -eq 0 ]]'
capture "${EDH_PC}" after-reload
