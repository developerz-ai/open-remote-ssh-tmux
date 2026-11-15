# Row 8 (v1 matrix, zombie) — close and reopen the workspace 3× with one terminal open:
# no session-count growth, one client, one tmux terminal each time.
connect "${EDH_PC}" || exit 1
new_terminal "${EDH_PC}"
wait_sessions_attached 1 || exit 1
name=$(session_names)
for i in 1 2 3; do
  close_window "${EDH_PC}"
  wait_until "VSCodium exited" 30 '! codium_running "${EDH_PC}"' || true
  connect "${EDH_PC}" $((i + 1)) || exit 1
  wait_sessions_attached 1 60 || true
  wait_stable 5 60 || true
  dump_remote
  expect "reopen ${i}: still exactly ${name}" '[[ "$(session_names)" == "${name}" ]]'
  expect "reopen ${i}: one client" '[[ $(client_count "${name}") -eq 1 ]]'
  expect "reopen ${i}: pty host 1 tmux, 0 plain" '[[ $(pty_tmux_count) -eq 1 && $(pty_plain_count) -eq 0 ]]'
done
