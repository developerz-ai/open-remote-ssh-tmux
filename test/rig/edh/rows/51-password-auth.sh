# Row 51 (base pass, 09-verify step 5) — password authentication. User `wpw` on the remote
# accepts only a password (remote.Dockerfile Match block); it gets a random one for this run.
# The client's alias `edh-pw` has no key for it, so the extension asks for the password in
# VS Code's input box; xdotool types it. Pass: the window connects (log: password auth tried),
# a terminal is a tmux one owned by wpw, and the password never appears in the log.
pw="edh-$(head -c 12 /dev/urandom | od -An -tx1 | tr -d ' \n')"
printf 'wpw:%s\n' "${pw}" | timeout 30 docker exec -i "${EDH_REMOTE}" chpasswd || exit 1
cx "${EDH_PC}" sh -c 'cat >> ~/.ssh/config <<EOF
Host edh-pw
  HostName edh-remote
  User wpw
  PreferredAuthentications password
EOF' || exit 1
wpw_sessions() { timeout 30 docker exec -u wpw "${EDH_REMOTE}" sh -c "tmux ls -F '#{session_name} #{session_attached}' 2>/dev/null | grep '^code-'" || true; }

EDH_CONNECT_HOST=edh-pw
EDH_CONNECT_WS=/home/wpw/ws
codium_open "${EDH_PC}"
wait_until "VSCodium window" 60 '[[ -n $(window_id "${EDH_PC}") ]]' || exit 1
expect "the extension asked for a password" \
  'wait_until "password prompt" 60 "[[ \$(log_count ${EDH_PC} \"Trying password authentication\") -ge 1 ]]"'
sleep 2 # stimulus timing: the input box takes focus
capture "${EDH_PC}" password-prompt
cx "${EDH_PC}" xdotool type --delay 15 -- "${pw}"
cx "${EDH_PC}" xdotool key Return
wait_wired "${EDH_PC}" 1 || { capture "${EDH_PC}" not-connected; exit 1; }
new_terminal "${EDH_PC}"
wait_until "a wpw code session, attached" 40 '[[ $(wpw_sessions | awk "\$2 == 1" | grep -c .) -eq 1 ]]' || true
note "wpw sessions: $(wpw_sessions | tr '\n' ';')"
expect "connected with the password: 1 tmux session for wpw, attached" '[[ $(wpw_sessions | awk "\$2 == 1" | grep -c .) -eq 1 ]]'
expect "the password is not in the log" '[[ $(log_count "${EDH_PC}" "${pw}") -eq 0 ]]'
capture "${EDH_PC}" connected
