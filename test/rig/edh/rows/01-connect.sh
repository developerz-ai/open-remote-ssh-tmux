# Row 1 (v1 matrix) — fresh connect, open a terminal: exactly one code-* session on the
# remote, attached, and the pty host runs tmux (not a plain shell). The screenshot is the
# row-10 evidence (tab titled after the folder, never "tmux"; no tmux status line).
connect "${EDH_PC}" || exit 1
new_terminal "${EDH_PC}"
wait_sessions_attached 1 || true
name=$(session_names)
wait_prompt "${name}" || true
dump_remote
expect "exactly one code-* session" '[[ $(session_count) -eq 1 ]]'
expect "it has exactly one client" '[[ $(client_count "${name}") -eq 1 ]]'
expect "the pty host runs tmux, no plain shell" '[[ $(pty_tmux_count) -eq 1 && $(pty_plain_count) -eq 0 ]]'
capture "${EDH_PC}" terminal-open
