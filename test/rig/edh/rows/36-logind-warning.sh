# edh: remote=logind
# Row 36 (hardening sweep) — a host whose logind ends a user's processes at logout
# (`KillUserProcesses=yes`; remote-variants.Dockerfile `logind`: a `loginctl` stub first on
# PATH, the rig has no systemd). The one-time warning:
#   a) first connect: probed, logged `-> at risk`, the warning is on screen (screenshot);
#   b) a reconnect in the same window (sshd session killed): not probed or shown again;
#   c) once the user has closed it (notifications cleared) a reload neither probes nor shows
#      it — the host is remembered as dismissed.
# Row 36b is the control on the normal image: probed, `-> ok`, no warning.
readonly lifetime_line='Terminal lifetime: KillUserProcesses=true Linger=false -> at risk'
connect "${EDH_PC}" || exit 1
new_terminal "${EDH_PC}"
wait_sessions_attached 1 || exit 1
expect "a) probed and logged at risk" \
  'wait_until "lifetime line" 30 "[[ \$(log_count ${EDH_PC} \"${lifetime_line}\") -eq 1 ]]"'
sleep 2 # stimulus timing: the notification toast renders
capture "${EDH_PC}" a-warning-shown

resolves=$(resolve_count "${EDH_PC}")
rroot "pkill -KILL -f '^sshd: wedh'" || true
expect "b) the window reconnected" 'wait_until "re-resolved" 120 "[[ \$(resolve_count ${EDH_PC}) -gt ${resolves} ]]"'
wait_until "a new sshd session" 60 'rroot "pgrep -f \"^sshd: wedh\""' || true
wait_stable 8 90 || true
expect "b) no second probe on the reconnect" '[[ $(log_count "${EDH_PC}" "Terminal lifetime:") -eq 1 ]]'
capture "${EDH_PC}" b-after-reconnect

key "${EDH_PC}" ctrl+alt+shift+F8 # Clear All Notifications: the user closes the warning
sleep 2
reload_window "${EDH_PC}"
wait_wired "${EDH_PC}" 2 || exit 1
sleep 10 # the advisory probe runs right after "wired"; give it ample time to (not) happen
expect "c) after it was closed, a reload neither probes nor warns" '[[ $(log_count "${EDH_PC}" "Terminal lifetime:") -eq 1 ]]'
capture "${EDH_PC}" c-after-reload
dump_remote
