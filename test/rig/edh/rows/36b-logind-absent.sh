# Row 36 control — the normal remote (no logind, no `loginctl`): the lifetime probe runs once,
# reads "unknown", logs `-> ok`, and no warning is shown (screenshot).
connect "${EDH_PC}" || exit 1
new_terminal "${EDH_PC}"
wait_sessions_attached 1 || exit 1
expect "probed once, logged ok" \
  'wait_until "lifetime line" 30 "[[ \$(log_count ${EDH_PC} \"Terminal lifetime: KillUserProcesses=unknown Linger=unknown -> ok\") -eq 1 ]]"'
expect "never at risk" '[[ $(log_count "${EDH_PC}" "at risk") -eq 0 ]]'
sleep 2
capture "${EDH_PC}" no-warning
