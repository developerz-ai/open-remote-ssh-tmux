# Row 1, strict variant — the user presses New Terminal the moment the window has connected
# (the extension has logged "Tmux terminal layer wired", nothing else waited for). Pass =
# that first terminal is already a tmux one. "wired" is logged only once the Workspace-scope
# default-profile write has landed (bug B: it used to come ~2 s before it), so the write must
# already be in the remote's .vscode/settings.json at the keypress.
codium_open "${EDH_PC}"
wait_until "VSCodium window" 60 '[[ -n $(window_id "${EDH_PC}") ]]' || exit 1
wait_wired "${EDH_PC}" 1 || exit 1
t0=$SECONDS
written_at_press=no
default_profile_written && written_at_press=yes
new_terminal "${EDH_PC}"
wait_default_profile || true
note "default profile written: at keypress=${written_at_press}, seen $((SECONDS - t0))s after wired"
wait_until "a terminal in the pty host" 30 '[[ -n "$(pty_children)" ]]' || true
wait_stable 3 30 || true
dump_remote
expect "the default profile was written before \"wired\"" '[[ ${written_at_press} == yes ]]'
expect "the first terminal opened right after connect is persistent (tmux)" '[[ $(pty_tmux_count) -eq 1 && $(pty_plain_count) -eq 0 ]]'
capture "${EDH_PC}" first-terminal
