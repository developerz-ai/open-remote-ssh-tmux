# Row 14 (v1 matrix) — `remote.SSH.tmux.enabled: "off"` from the start, on a tmux-capable
# host: pure upstream behaviour. New Terminal is a plain shell, no `code-*` session and no
# tmux server is ever started, the tmux default profile is never written, the layer is never
# wired, and nothing is logged at Error level.
set_setting "${EDH_PC}" remote.SSH.tmux.enabled '"off"'
codium_open "${EDH_PC}"
wait_until "VSCodium window" 60 '[[ -n $(window_id "${EDH_PC}") ]]' || exit 1
wait_until "resolved" 120 '[[ $(resolve_count "${EDH_PC}") -ge 1 ]]' || exit 1
wait_until "remote extension host up" 90 'rsh "pgrep -u wedh -f -- \"[-]-type=extensionHost\""' || exit 1
sleep 5 # stimulus timing: the extension has activated and decided (or skipped) wiring
new_terminal "${EDH_PC}"
wait_until "a plain shell in the pty host" 30 '[[ $(pty_plain_count) -eq 1 ]]' || true
sleep 2
type_line "${EDH_PC}" 'echo PLAIN-R14 > /tmp/edh-r14.out'
new_terminal "${EDH_PC}"
wait_until "a second plain shell" 30 '[[ $(pty_plain_count) -eq 2 ]]' || true
wait_stable 3 30 || true
dump_remote
expect "the plain terminal runs commands" 'wait_until "typed" 20 "rsh \"grep -q PLAIN-R14 /tmp/edh-r14.out\""'
expect "pty host: 0 tmux, 2 plain" '[[ $(pty_tmux_count) -eq 0 && $(pty_plain_count) -eq 2 ]]'
expect "no code-* session" '[[ $(session_count) -eq 0 ]]'
expect "no tmux server was started" '! rsh "pgrep -u wedh -f \"^tmux\""'
expect "the tmux layer was not wired" '[[ $(log_count "${EDH_PC}" "Tmux terminal layer wired") -eq 0 ]]'
expect "no default-profile write in the workspace settings" '! default_profile_written'
expect "no Error-level log line" '[[ $(log_count "${EDH_PC}" "\[Error") -eq 0 ]]'
capture "${EDH_PC}" plain-terminals
