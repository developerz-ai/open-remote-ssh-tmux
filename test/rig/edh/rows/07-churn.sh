# Row 7 (v1 matrix, zombie) — open/close (Kill Terminal) 5×: the session count never
# exceeds the open terminals, slot 0 is reused every time, and nothing is left behind.
# Then 3 open, kill 1: sessions == tmux terminals == 2.
connect "${EDH_PC}" || exit 1
seen=()
for i in 1 2 3 4 5; do
  new_terminal "${EDH_PC}"
  wait_sessions_attached 1 || { note "cycle ${i}: no session"; ROW_FAILURES=$((ROW_FAILURES + 1)); break; }
  seen+=("$(session_names)")
  wait_prompt "${seen[-1]}" || true
  kill_terminal "${EDH_PC}"
  expect "cycle ${i}: session killed with its terminal" \
    'wait_until "session gone" 20 "[[ \$(session_count) -eq 0 ]]"'
done
note "sessions seen: ${seen[*]}"
expect "slot reused (one distinct name over 5 cycles)" \
  '[[ $(printf "%s\n" "${seen[@]}" | sort -u | grep -c .) -eq 1 ]]'

for n in 1 2 3; do
  new_terminal "${EDH_PC}"
  wait_sessions_attached "${n}" || true
done
kill_terminal "${EDH_PC}"
wait_until "two sessions left" 20 '[[ $(session_count) -eq 2 ]]' || true
wait_stable 3 30 || true
dump_remote
expect "3 open, 1 killed: 2 sessions" '[[ $(session_count) -eq 2 ]]'
expect "sessions == tmux terminals" '[[ $(session_count) -eq $(pty_tmux_count) ]]'
expect "no plain shells" '[[ $(pty_plain_count) -eq 0 ]]'
