# Row 15 (v1 matrix) — "Kill Persistent Terminal Sessions (this workspace)" from the Command
# Palette, with two workspace terminals open and the user's own `dev` session on the same tmux
# server:
#   cancel (Esc on the confirm modal)  -> nothing changes;
#   confirm (Enter = "Kill Sessions")  -> both workspace sessions gone, their terminals close,
#                                         the user's `dev` session and its process untouched.
rsh 'tmux new-session -d -s dev "sleep 99999"'
dev_pid=$(rsh "tmux list-panes -t '=dev:' -F '#{pane_pid}'")
connect "${EDH_PC}" || exit 1
new_terminal "${EDH_PC}"
wait_sessions_attached 1 || exit 1
new_terminal "${EDH_PC}"
wait_sessions_attached 2 || exit 1
before=$(sessions | sort)
wait_stable 3 30 || true

palette "${EDH_PC}" 'Kill Persistent Terminal Sessions'
sleep 2 # stimulus timing: the confirm modal renders
capture "${EDH_PC}" confirm-modal
key "${EDH_PC}" Escape
sleep 4 # a kill, had one been issued, lands well within this
dump_remote
expect "cancel: both workspace sessions untouched" '[[ "$(sessions | sort)" == "${before}" ]]'
expect "cancel: pty host still 2 tmux" '[[ $(pty_tmux_count) -eq 2 ]]'

palette "${EDH_PC}" 'Kill Persistent Terminal Sessions'
sleep 2
capture "${EDH_PC}" confirm-modal-2
key "${EDH_PC}" Return
expect "confirm: every workspace session gone" 'wait_until "sessions gone" 30 "[[ \$(session_count) -eq 0 ]]"'
expect "confirm: their terminals closed (no tmux client left in the pty host)" \
  'wait_until "tmux ptys gone" 30 "[[ \$(pty_tmux_count) -eq 0 ]]"'
wait_stable 3 30 || true
dump_remote
expect "the user's dev session survives" 'rsh "tmux has-session -t =dev"'
expect "its process is alive" 'rsh "kill -0 ${dev_pid}"'
expect "no session was recreated afterwards" '[[ $(session_count) -eq 0 ]]'
capture "${EDH_PC}" after-kill
