# Row 6 (v1 matrix, zombie) — `exit` in the shell closes the terminal and its session
# disappears from `tmux ls`.
connect "${EDH_PC}" || exit 1
new_terminal "${EDH_PC}"
wait_sessions_attached 1 || exit 1
name=$(session_names)
wait_prompt "${name}" || exit 1
type_line "${EDH_PC}" 'exit'
expect "session gone after exit" 'wait_until "session gone" 20 "[[ \$(session_count) -eq 0 ]]"'
expect "no terminal left in the pty host" 'wait_until "pty gone" 20 "[[ -z \$(pty_children) ]]"'
dump_remote
