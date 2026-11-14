# edh: remote=notmux
# Row 12 (v1 matrix) — a Unix remote without tmux. The connect works, New Terminal is a plain
# login shell that runs commands, the extension logs exactly one line about it and nothing at
# Error level, never writes the tmux default profile, and shows no notification (screenshot).
codium_open "${EDH_PC}"
wait_until "VSCodium window" 60 '[[ -n $(window_id "${EDH_PC}") ]]' || exit 1
expect "the capability check logged tmux as unavailable" \
  'wait_until "unavailable line" 120 "[[ \$(log_count ${EDH_PC} \"Persistent terminals unavailable\") -ge 1 ]]"'
wait_until "remote extension host up" 60 'rsh "pgrep -u wedh -f -- \"[-]-type=extensionHost\""' || true
sleep 3 # stimulus timing: the workbench finishes restoring before the first keypress
new_terminal "${EDH_PC}"
wait_until "a plain shell in the pty host" 30 '[[ $(pty_plain_count) -eq 1 ]]' || true
sleep 2
type_line "${EDH_PC}" 'echo PLAIN-R12 > /tmp/edh-r12.out'
wait_stable 3 30 || true
dump_remote
expect "connect completed: the plain terminal runs commands" 'wait_until "typed" 20 "rsh \"grep -q PLAIN-R12 /tmp/edh-r12.out\""'
expect "pty host: 0 tmux, 1 plain" '[[ $(pty_tmux_count) -eq 0 && $(pty_plain_count) -eq 1 ]]'
expect "exactly one log line about it: \"Persistent terminals unavailable: not-installed\"" \
  '[[ $(log_count "${EDH_PC}" "Persistent terminals unavailable") -eq 1 && $(log_count "${EDH_PC}" "Persistent terminals unavailable: not-installed") -eq 1 ]]'
expect "no Error-level log line" '[[ $(log_count "${EDH_PC}" "\[Error") -eq 0 ]]'
expect "the tmux layer was not wired" '[[ $(log_count "${EDH_PC}" "Tmux terminal layer wired") -eq 0 ]]'
expect "no default-profile write in the workspace settings" '! default_profile_written'
capture "${EDH_PC}" plain-terminal-no-popup
