# Row 16 (v1 matrix; 27 end to end) — a workspace folder whose name carries a quote, spaces,
# `$HOME`, a tmux `#(…)` format job, a `;` and a backquoted command. Opened as the remote
# folder, the terminal is a tmux one whose cwd is exactly that folder (the pane process's cwd and
# what `pwd` prints), and nothing in the name was executed or expanded.
EDH_CONNECT_WS="/home/wedh/hostile-it's a \$HOME #(touch /tmp/edh-pwned-16a) ; \`touch /tmp/edh-pwned-16b\` dir"
timeout 30 docker exec -u wedh -e P="${EDH_CONNECT_WS}" "${EDH_REMOTE}" sh -c 'mkdir -p "$P"' || exit 1
note "workspace: ${EDH_CONNECT_WS}"
connect "${EDH_PC}" || exit 1
new_terminal "${EDH_PC}"
wait_sessions_attached 1 || exit 1
name=$(session_names)
wait_prompt "${name}" || exit 1
# The pane's real cwd from /proc: tmux's own `#{pane_current_path}` prints `$` as `\$` (a
# display quirk of tmux formats, verified on 3.4), which would compare unequal for no reason.
cwd=$(rsh "readlink /proc/\$(tmux list-panes -t '=${name}:' -F '#{pane_pid}')/cwd")
note "pane cwd: ${cwd}"
type_line "${EDH_PC}" 'pwd > /tmp/edh-r16.pwd'
wait_until "pwd written" 20 'rsh "test -s /tmp/edh-r16.pwd"' || true
dump_remote
expect "the pane's process runs in the folder" '[[ "${cwd}" == "${EDH_CONNECT_WS}" ]]'
expect "the shell's pwd is the folder" '[[ "$(rsh "cat /tmp/edh-r16.pwd")" == "${EDH_CONNECT_WS}" ]]'
expect "nothing in the name was executed" '! rsh "ls /tmp/edh-pwned-16* 2>/dev/null | grep -q ."'
expect "pty host: 1 tmux, 0 plain" '[[ $(pty_tmux_count) -eq 1 && $(pty_plain_count) -eq 0 ]]'
capture "${EDH_PC}" hostile-folder-terminal
