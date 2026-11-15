# edh: machines=2
# Row 19 (v1 matrix) — two live clients on one workspace, no stealing. The PC has 2 tmux
# terminals and is in use (input in the last minute); the laptop opens the same workspace and
# a New Terminal. The laptop gets a FRESH session (a new slot), the PC's two terminals keep
# their own tmux clients (never detached or taken over), and the remote has 3 sessions with
# one client each. Row 20 continues from here.
A=${EDH_PC} B=${EDH_LAPTOP}
connect "${A}" || exit 1
new_terminal "${A}"
wait_sessions_attached 1 || exit 1
new_terminal "${A}"
wait_sessions_attached 2 || exit 1
pc_sessions=$(session_names | sort)
pc_clients=$(all_clients | sort)
note "PC: ${pc_clients//$'\n'/; }"
# The PC is live: a keystroke through one of its clients (the other is seconds old anyway).
focus_terminal "${A}"
last=$(sessions | awk '{print $1}' | tail -1)
wait_prompt "${last}" || true
type_line "${A}" 'echo PC-LIVE-R19'

connect "${B}" || exit 1
wait_stable 5 40 || true
expect "laptop's connect left the PC's clients alone" '[[ "$(all_clients | sort)" == "${pc_clients}" ]]'
new_terminal "${B}"
wait_sessions_attached 3 60 || true
wait_stable 5 40 || true
dump_remote
laptop_session=$(comm -13 <(printf '%s\n' "${pc_sessions}") <(session_names | sort))
note "laptop's session: ${laptop_session:-none}"
expect "3 sessions, each with exactly one client" \
  '[[ $(session_count) -eq 3 && $(sessions | awk "\$2 != 1" | grep -c .) -eq 0 ]]'
expect "the laptop's terminal is a new session (not one of the PC's)" '[[ -n "${laptop_session}" && $(grep -c . <<<"${laptop_session}") -eq 1 ]]'
expect "PC's two terminals: same sessions, same tmux clients (undisturbed)" \
  '[[ "$(all_clients | grep -v "^${laptop_session} " | sort)" == "${pc_clients}" ]]'
expect "laptop took nothing over" '[[ $(log_count "${B}" "-> (handoff-takeover|restore-takeover|adopt)") -eq 0 ]]'
expect "pty host: 3 tmux, 0 plain" '[[ $(pty_tmux_count) -eq 3 && $(pty_plain_count) -eq 0 ]]'
note "laptop offers logged: $(log_count "${B}" "-> offer")"
capture "${B}" laptop-fresh-terminal
capture "${A}" pc-undisturbed
