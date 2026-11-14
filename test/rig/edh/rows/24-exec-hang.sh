# Row 24 (hardening sweep) — a remote exec hangs. The hang is produced by SIGSTOPping the
# remote tmux SERVER: every tmux command the extension sends (`list-sessions`, `has-session`)
# then blocks on the server socket, i.e. the exec channel never answers — the field failure
# mode. (SIGSTOPping the sshd session process instead would freeze the whole connection,
# VS Code's own server channel included, so no terminal of any kind could open and the
# row's pass condition would be meaningless; see README.)
#   a) new terminal while hung  -> a plain shell within the deadline (TMUX_EXEC_DEADLINE_MS
#      = 8 s) + the one info log line; nothing tmux-ish on screen (screenshot).
#   b) reload while hung        -> connect completes, a new terminal is again plain within
#      about ONE deadline: the reconcile it waits behind gives up after its first unanswered
#      call, and the terminal does not ask again (bug D: it used to take 32-33 s).
#   c) SIGCONT                  -> the original session is intact, no extra sessions.
readonly budget=13
connect "${EDH_PC}" || exit 1
new_terminal "${EDH_PC}"
wait_sessions_attached 1 || exit 1
name=$(session_names)
server=$(rsh "tmux ls -F '#{pid}' | head -1")
note "tmux server pid ${server}"
rsh "kill -STOP ${server}"
trap 'rsh "kill -CONT ${server}" || true' EXIT

t0=$SECONDS
new_terminal "${EDH_PC}"
if wait_until "plain shell in the pty host" 60 '[[ $(pty_plain_count) -ge 1 ]]'; then
  note "a) plain shell after $((SECONDS - t0))s"
  expect "a) plain shell within ${budget}s" '[[ $((SECONDS - t0)) -le ${budget} ]]'
else
  expect "a) plain shell opened at all" false
fi
expect "a) info line logged" '[[ $(log_count "${EDH_PC}" "did not answer in time") -ge 1 ]]'
capture "${EDH_PC}" a-plain-shell

t1=$SECONDS
reload_window "${EDH_PC}"
expect "b) reload completes while tmux is hung" 'wait_wired "${EDH_PC}" 2'
note "b) re-wired after $((SECONDS - t1))s"
plain_before=$(pty_plain_count)
t2=$SECONDS
new_terminal "${EDH_PC}"
if wait_until "another plain shell" 60 '[[ $(pty_plain_count) -gt ${plain_before} ]]'; then
  note "b) plain shell after $((SECONDS - t2))s"
  expect "b) plain shell within ${budget}s" '[[ $((SECONDS - t2)) -le ${budget} ]]'
else
  expect "b) plain shell opened at all" false
fi
capture "${EDH_PC}" b-after-reload

rsh "kill -CONT ${server}"
trap - EXIT
wait_stable 5 60 || true
dump_remote
expect "c) original session intact, nothing extra" '[[ "$(session_names)" == "${name}" ]]'
