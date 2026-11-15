# Row 11 (v1 matrix) — the user's own tmux is left alone. The remote user has a ~/.tmux.conf
# with distinctive settings and two sessions of their own (`dev`, started the way a user
# does, and `edh-user-11`), running on the same default tmux server our sessions use. Then a
# full workout of the terminal layer: terminals opened, one killed, one exited, a window
# reload (revive + reconcile), a close + reopen (connect-time reaper). Afterwards: the user's
# sessions still exist with their creation times, their processes alive; the user's options
# and key binding read back unchanged; and the extension's log never names a user session.
rsh_in 'cat > ~/.tmux.conf' <<'CONF'
set -g history-limit 4242
set -g @edh_user_marker user-conf-11
set -g status-style bg=colour52
set -g prefix C-a
set -sg escape-time 77
bind-key -n F12 display-message user-binding-11
CONF
rsh 'tmux new-session -d -s dev "sleep 99999" && tmux new-session -d -s edh-user-11'
user_options() {
  rsh "tmux show-options -gv history-limit; tmux show-options -gv @edh_user_marker; \
    tmux show-options -gv status-style; tmux show-options -gv prefix; tmux show-options -sv escape-time; \
    tmux list-keys -T root F12 2>/dev/null"
}
user_sessions() {
  rsh "tmux ls -F '#{session_name} #{session_created}' | grep -v '^code-' | sort"
}
options_before=$(user_options)
sessions_before=$(user_sessions)
dev_pid=$(rsh "tmux list-panes -t '=dev:' -F '#{pane_pid}'")
note "user options before:"$'\n'"${options_before}"
note "user sessions before: ${sessions_before//$'\n'/; }"
[[ ${options_before} == *4242* && ${options_before} == *user-binding-11* ]] || { note "~/.tmux.conf was not applied"; exit 1; }

connect "${EDH_PC}" || exit 1
for n in 1 2 3; do
  new_terminal "${EDH_PC}"
  wait_sessions_attached "${n}" || exit 1
done
kill_terminal "${EDH_PC}"
wait_until "two code sessions" 20 '[[ $(session_count) -eq 2 ]]' || true
reload_window "${EDH_PC}"
wait_wired "${EDH_PC}" 2 || exit 1
wait_stable 5 60 || true
close_window "${EDH_PC}"
wait_until "VSCodium exited" 30 '! codium_running "${EDH_PC}"' || true
connect "${EDH_PC}" 3 || exit 1
wait_sessions_attached 2 60 || true
wait_stable 5 60 || true
last=$(sessions | awk '{print $1}' | tail -1)
wait_prompt "${last}" || true
focus_terminal "${EDH_PC}"
type_line "${EDH_PC}" 'exit'
wait_until "one code session left" 20 '[[ $(session_count) -eq 1 ]]' || true
wait_stable 5 40 || true
dump_remote

options_after=$(user_options)
sessions_after=$(user_sessions)
note "user options after:"$'\n'"${options_after}"
note "user sessions after: ${sessions_after//$'\n'/; }"
expect "the workout ran (1 code session left, attached)" '[[ $(session_count) -eq 1 ]]'
expect "user sessions dev and edh-user-11 unchanged (names + creation times)" '[[ "${sessions_after}" == "${sessions_before}" ]]'
expect "the user's process in dev is alive" 'rsh "kill -0 ${dev_pid}"'
expect "user options and binding unchanged (history-limit, @marker, status-style, prefix, escape-time, F12)" \
  '[[ "${options_after}" == "${options_before}" ]]'
expect "the extension's log never names a user session" \
  '[[ $(remote_log "${EDH_PC}" | grep -cE "(^|[^/a-z])dev([^a-z]|$)|edh-user-11") -eq 0 ]]'
