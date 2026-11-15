# edh: machines=2
# Row 23 (hardening sweep) — the PC's network is cut (no clean close, no detach), then the
# laptop opens the workspace. Once the PC's client has been idle past the staleness
# threshold (STALE_CLIENT_SECONDS = 120 s, slotState.ts) the laptop takes the session over
# by itself: `-> handoff-takeover`, its client is the only one, process + scrollback intact,
# no manual `tmux detach-client`.
A=${EDH_PC} B=${EDH_LAPTOP}
readonly stale_after=120
connect "${A}" || exit 1
new_terminal "${A}"
wait_sessions_attached 1 || exit 1
name=$(session_names)
wait_prompt "${name}" || exit 1
type_line "${A}" 'sleep 9999 & echo $! > /tmp/edh-r23.pid; echo MARKER-R23'
wait_until "sleep pid recorded" 20 'rsh "test -s /tmp/edh-r23.pid"' || exit 1
pid=$(rsh 'cat /tmp/edh-r23.pid')
pc_client=$(client_pids "${name}")

# The cut: pull the PC off the network first (nothing gets out — no FIN, no detach), then
# kill it. ensure_client brings a fresh PC back for the next row.
timeout 30 docker network disconnect --force "${EDH_NET}" "${A}" || true
timeout 30 docker kill "${A}" >/dev/null || true
expect "PC's stale client still attached right after the cut" '[[ "$(client_pids "${name}")" == "${pc_client}" ]]'

idle() { rsh "echo \$(( \$(date +%s) - \$(tmux list-clients -t '=${name}' -F '#{client_activity}' | sort -n | tail -1) ))"; }
note "waiting for the PC's client to be idle >= ${stale_after}s (now $(idle)s)"
wait_until "PC client idle past the threshold" $((stale_after + 60)) '[[ $(idle) -ge $((stale_after + 5)) ]]' || exit 1

connect "${B}" || exit 1
wait_until "laptop client on the session" 40 '[[ -n "$(client_pids "${name}")" && "$(client_pids "${name}")" != "${pc_client}" ]]' || true
wait_stable 5 40 || true
dump_remote
expect "laptop log shows the hand-off take-over" '[[ $(log_count "${B}" "-> handoff-takeover") -ge 1 ]]'
expect "exactly one client, and it is not the PC's" '[[ $(client_count "${name}") -eq 1 && "$(client_pids "${name}")" != "${pc_client}" ]]'
expect "still one session" '[[ $(session_count) -eq 1 ]]'
expect "sleep ${pid} still alive" 'rsh "kill -0 ${pid}"'
expect "scrollback came with it" 'pane_has "${name}" MARKER-R23'
capture "${B}" laptop-took-over
