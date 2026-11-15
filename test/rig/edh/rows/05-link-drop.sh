# Row 5 (v1 matrix) + base pass "reconnect after link drop" — the PC's network goes away for
# 30 s with no clean close (docker network disconnect: packets just stop, nothing is reset),
# then comes back. VS Code reconnects by itself and nothing is lost: same session, the same
# tmux client (the pty survived on the server), the ticker alive and still ticking, the
# marker in the scrollback, no extra session or plain shell, and typing works again.
connect "${EDH_PC}" || exit 1
new_terminal "${EDH_PC}"
wait_sessions_attached 1 || exit 1
read -r name _ created < <(sessions)
wait_prompt "${name}" || exit 1
type_line "${EDH_PC}" 'while :; do date +%s > /tmp/edh-r05.tick; sleep 1; done & echo $! > /tmp/edh-r05.pid; echo MARKER-R05'
wait_until "ticker pid recorded" 20 'rsh "test -s /tmp/edh-r05.pid"' || exit 1
pid=$(rsh 'cat /tmp/edh-r05.pid')
client=$(client_pids "${name}")

sshd_sessions() { rroot "pgrep -f '^sshd: wedh' | sort" | tr '\n' ' '; }
before_sshd=$(sshd_sessions)
note "sshd sessions before the drop: ${before_sshd}"
timeout 30 docker network disconnect --force "${EDH_NET}" "${EDH_PC}" || exit 1
sleep 30 # stimulus timing: the link is down
tick_at_return=$(rsh 'cat /tmp/edh-r05.tick')
timeout 30 docker network connect "${EDH_NET}" "${EDH_PC}" || exit 1

new_sshd() {
  local p
  for p in $(rroot "pgrep -f '^sshd: wedh'"); do
    [[ " ${before_sshd} " == *" ${p} "* ]] || return 0
  done
  return 1
}
expect "VS Code reconnected over a new SSH connection" 'wait_until "new sshd session" 180 new_sshd'
wait_stable 8 120 || true
dump_remote
expect "same session (name + creation time)" '[[ "$(sessions | awk "{print \$1, \$3}")" == "${name} ${created}" ]]'
expect "same tmux client — the terminal never went away" '[[ "$(client_pids "${name}")" == "${client}" ]]'
expect "ticker ${pid} alive" 'rsh "kill -0 ${pid}"'
expect "ticker kept ticking" '[[ $(rsh "cat /tmp/edh-r05.tick") -gt ${tick_at_return} ]]'
expect "marker in scrollback" 'pane_has "${name}" MARKER-R05'
expect "pty host: 1 tmux, 0 plain" '[[ $(pty_tmux_count) -eq 1 && $(pty_plain_count) -eq 0 ]]'
focus_terminal "${EDH_PC}"
# Showing the terminal resizes it to the panel (it was attached at a default size); let that
# redraw finish before typing — on tmux 2.6 keys typed into the redraw get scrambled.
wait_prompt "${name}" || true
type_line "${EDH_PC}" 'echo AFTER-DROP-R05'
expect "typing reaches the terminal after the reconnect" \
  'wait_until "typed after drop" 30 "pane_has_line ${name} AFTER-DROP-R05"'
capture "${EDH_PC}" after-drop
