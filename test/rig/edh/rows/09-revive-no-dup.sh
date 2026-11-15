# Row 9 (v1 matrix, zombie) — Reload Window with 2 terminals: still 2 sessions, each with
# exactly one client, and the pty host runs exactly 2 tmux clients and no plain-shell double
# from VS Code's own revive.
connect "${EDH_PC}" || exit 1
new_terminal "${EDH_PC}"
wait_sessions_attached 1 || exit 1
new_terminal "${EDH_PC}"
wait_sessions_attached 2 || exit 1
before=$(sessions | sort)
reload_window "${EDH_PC}"
wait_wired "${EDH_PC}" 2 || exit 1
wait_stable 8 90 || true
dump_remote
expect "same 2 sessions" '[[ "$(sessions | sort)" == "${before}" ]]'
expect "each has one client" '[[ $(all_clients | grep -c .) -eq 2 && $(all_clients | awk "{print \$1}" | sort -u | grep -c .) -eq 2 ]]'
expect "pty host: 2 tmux, 0 plain" '[[ $(pty_tmux_count) -eq 2 && $(pty_plain_count) -eq 0 ]]'
note "duplicate-discard log lines: $(log_count "${EDH_PC}" 'already on screen')"
capture "${EDH_PC}" after-reload
