# Row 52 (base pass, 09-verify step 5) — host-key prompt on the first connect. With an empty
# known_hosts the connect stops at the "authenticity of host … can't be established" modal
# (screenshot) and goes no further; Enter (Continue) accepts, the window connects, and the
# remote's real ed25519 key is now recorded for edh-remote. A second connect needs no prompt:
# it wires with no key pressed.
cx "${EDH_PC}" sh -c ': > ~/.ssh/known_hosts' || exit 1
remote_key=$(rroot 'cut -d" " -f2 /etc/ssh/ssh_host_ed25519_key.pub')
codium_open "${EDH_PC}"
wait_until "VSCodium window" 60 '[[ -n $(window_id "${EDH_PC}") ]]' || exit 1
wait_until "resolving" 60 '[[ $(resolve_count "${EDH_PC}") -ge 1 ]]' || exit 1
sleep 6 # stimulus timing: the host-key modal is up
capture "${EDH_PC}" hostkey-prompt
expect "the connect waits on the prompt (not wired, nothing recorded yet)" \
  '[[ $(log_count "${EDH_PC}" "Tmux terminal layer wired") -eq 0 ]] && ! cx "${EDH_PC}" grep -q . /home/pc/.ssh/known_hosts'
key "${EDH_PC}" Return # Continue
expect "accepting it connects" 'wait_wired "${EDH_PC}" 1'
expect "the remote's key is recorded for edh-remote" \
  'cx "${EDH_PC}" ssh-keygen -F edh-remote -f /home/pc/.ssh/known_hosts | grep -qF -- "${remote_key}"'
close_window "${EDH_PC}"
wait_until "VSCodium exited" 30 '! codium_running "${EDH_PC}"' || true

connect "${EDH_PC}" 2 || { capture "${EDH_PC}" second-connect-blocked; expect "second connect needs no prompt" false; exit 1; }
expect "second connect: no prompt, wired" true
expect "still one known_hosts entry for edh-remote" \
  '[[ $(cx "${EDH_PC}" ssh-keygen -F edh-remote -f /home/pc/.ssh/known_hosts | grep -vc "^#") -eq 1 ]]'
capture "${EDH_PC}" second-connect
