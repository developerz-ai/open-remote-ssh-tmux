# Row 28 (hardening sweep) — `remote.SSH.tmux.enabled` off then back on, no reload:
#   off -> a new terminal is a plain shell, the existing tmux terminal stays on screen (no
#          session goes unseen); a cleanup offer is a notification -> screenshot (eyes);
#   on  -> a new terminal is a tmux one again.
connect "${EDH_PC}" || exit 1
new_terminal "${EDH_PC}"
wait_sessions_attached 1 || exit 1
name=$(session_names)

set_tmux_enabled "${EDH_PC}" off
sleep 3   # stimulus timing: let the file watcher deliver the change
plain_before=$(pty_plain_count)
tmux_before=$(pty_tmux_count)
new_terminal "${EDH_PC}"
wait_until "a second terminal" 30 '[[ $(pty_children | grep -c .) -ge 2 ]]' || true
wait_stable 3 30 || true
dump_remote
expect "off: new terminal is a plain shell" '[[ $(pty_plain_count) -eq $((plain_before + 1)) ]]'
expect "off: no new session" '[[ "$(session_names)" == "${name}" ]]'
expect "off: the existing tmux terminal is still open (attached)" '[[ $(client_count "${name}") -eq 1 ]]'
capture "${EDH_PC}" after-off
note "log lines mentioning the setting: $(remote_log "${EDH_PC}" | grep -ciE 'tmux.enabled|turned off|disabled' || true)"

set_tmux_enabled "${EDH_PC}" auto
sleep 3
new_terminal "${EDH_PC}"
wait_until "a third terminal" 30 '[[ $(pty_children | grep -c .) -ge 3 ]]' || true
wait_stable 3 30 || true
dump_remote
expect "on: new terminal is tmux again" '[[ $(pty_tmux_count) -eq $((tmux_before + 1)) ]]'
expect "on: sessions == tmux terminals" '[[ $(session_count) -eq $(pty_tmux_count) ]]'
capture "${EDH_PC}" after-on
