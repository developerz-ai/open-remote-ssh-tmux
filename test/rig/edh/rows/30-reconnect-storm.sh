# Row 30 (hardening sweep) — reconnect storm: with 2 terminals open, kill the remote sshd
# session serving the window 3× within ~10 s. After VS Code reconnects: the same 2 sessions,
# one client each, the pty host runs exactly 2 tmux terminals (tabs == sessions), no plain
# doubles, no new slots.
connect "${EDH_PC}" || exit 1
new_terminal "${EDH_PC}"
wait_sessions_attached 1 || exit 1
new_terminal "${EDH_PC}"
wait_sessions_attached 2 || exit 1
before=$(sessions | sort)
for i in 1 2 3; do
  note "kill ${i}: $(rroot "pgrep -fa '^sshd: wedh' | tr '\n' ';'")"
  rroot "pkill -KILL -f '^sshd: wedh'" || true
  [[ ${i} -lt 3 ]] && sleep 4   # stimulus timing: 3 kills inside ~10 s
done
wait_until "a new sshd session (reconnected)" 120 'rroot "pgrep -f \"^sshd: wedh\""' || true
wait_stable 15 180 || true
dump_remote
expect "same 2 sessions" '[[ "$(sessions | sort)" == "${before}" ]]'
expect "one client each" '[[ $(all_clients | grep -c .) -eq 2 && $(all_clients | awk "{print \$1}" | sort -u | grep -c .) -eq 2 ]]'
expect "pty host: 2 tmux, 0 plain" '[[ $(pty_tmux_count) -eq 2 && $(pty_plain_count) -eq 0 ]]'
note "reconnect-related log lines: $(remote_log "${EDH_PC}" | grep -ciE 'reconnect|resolv' || true)"
capture "${EDH_PC}" after-storm
