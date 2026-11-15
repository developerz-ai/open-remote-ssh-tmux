# Row 40 — where "Connect to Host..." lands (remote.SSH.openInWindow: auto, the default).
#   a) from an EMPTY local window it connects that window: still exactly one window, now remote;
#   b) from a window with a LOCAL folder open it opens a new window: two windows, the local one
#      kept.
# The command is driven through its real quick pick (type the host, Enter). Screenshots for a
# human: the pick (recent host first, add/configure at the bottom) and the SSH Targets view
# (connected host marked). Windows are counted with xdotool; the window title is set to carry
# `${remoteName}` so a remote window is told apart from a local one.
c=${EDH_PC}

# Seed the profile: one connection to the remote folder, so the host is "recently connected"
# and has a remembered folder. Close the window cleanly so globalState is flushed to disk.
connect "${c}" || exit 1
close_window "${c}"
wait_until "VSCodium exited" 30 "! codium_running ${c}" || exit 1

# Title carries the remote: "SSH: edh-remote" in a remote window, nothing in a local one.
cx "${c}" sh -c "f=${EDH_UDD}/User/settings.json; sed '1a\\
	\"window.title\": \"\${remoteName} | \${rootName} - \${appName}\",' \"\$f\" > \"\$f.new\" && mv \"\$f.new\" \"\$f\""

remote_windows() { window_titles "${c}" | grep -c 'SSH: edh-remote' || true; }

# --- a) empty local window → reused
codium_launch "${c}"
wait_until "empty VSCodium window" 60 "[[ \$(window_count ${c}) -eq 1 ]]" || { capture "${c}" a-no-window; exit 1; }
sleep 2 # let the workbench settle before the first chord
connect_to_host "${c}"
sleep 3 # the extension activates on the command, then the pick opens
capture "${c}" a-quick-pick
type_line "${c}" "${EDH_HOST}"
wait_until "a remote window" 90 "[[ \$(remote_windows) -ge 1 ]]" || true
sleep 5 # a second window, if one were opening, would map by now
window_titles "${c}" >&2
expect "empty local window: still exactly one window" '[[ $(window_count "${c}") -eq 1 ]]'
expect "empty local window: that window is now connected to the host" '[[ $(remote_windows) -eq 1 ]]'

show_remote_explorer "${c}"
sleep 3
capture "${c}" a-ssh-targets

# SSH Targets, by mouse. Positions are the rig's fixed layout (1600x1000 Xvfb, side bar at its
# default width, edh-remote the first and only host): the host row sits at y=152, its twistie
# at x=146, its label at x=218. The twistie only expands; hovering the label shows the address;
# clicking the label connects — from this (remote) window, in a new one.
cx "${c}" xdotool mousemove 146 152 click 1
sleep 2
expect "SSH Targets: the twistie expands without connecting" '[[ $(window_count "${c}") -eq 1 ]]'
cx "${c}" xdotool mousemove 218 152
sleep 2
capture "${c}" a-ssh-targets-expanded-hover
cx "${c}" xdotool click 1
wait_until "a second window" 60 "[[ \$(window_count ${c}) -eq 2 ]]" || true
expect "SSH Targets: clicking the host label connects, in a new window from a remote one" '[[ $(window_count "${c}") -eq 2 ]]'

timeout 20 docker exec "${c}" pkill -KILL -f '[/]opt/vscodium/' || true # nothing left to flush
wait_until "VSCodium exited" 30 "! codium_running ${c}" || exit 1

# --- b) window with a local folder → new window
cx "${c}" mkdir -p /home/pc/localproj
codium_launch "${c}" /home/pc/localproj
wait_until "local folder window" 60 "[[ \$(window_count ${c}) -eq 1 ]]" || { capture "${c}" b-no-window; exit 1; }
sleep 2
connect_to_host "${c}"
sleep 3
type_line "${c}" "${EDH_HOST}"
wait_until "a remote window" 90 "[[ \$(remote_windows) -ge 1 ]]" || true
sleep 3
window_titles "${c}" >&2
expect "local folder window: a second window opened" '[[ $(window_count "${c}") -eq 2 ]]'
expect "local folder window: the new one is connected to the host" '[[ $(remote_windows) -eq 1 ]]'
expect "local folder window: the local window is kept" '[[ $(window_titles "${c}") == *localproj* ]]'
capture "${c}" b-two-windows
