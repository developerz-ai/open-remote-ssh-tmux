# Row 50 (base pass, 09-verify step 5) — connect through a ProxyJump host. A second sshd
# container (`edh-jump`, the same rig image) is the only way to the remote: the remote also
# sits on a private network under the name `edh-hidden`, which the client can neither resolve
# nor route to. The client's ssh config sends `edh-viajump` (HostName edh-hidden) through
# `ProxyJump edh-jump`. Pass: the window connects, a terminal is a tmux one, and the remote's
# sshd session for it is served from the jump host's address.
cleanup_jump() {
  timeout 30 docker network disconnect --force "${EDH_NET2}" "${EDH_REMOTE}" >/dev/null 2>&1 || true
  timeout 60 docker rm -f "${EDH_JUMP}" >/dev/null 2>&1 || true
  timeout 30 docker network rm "${EDH_NET2}" >/dev/null 2>&1 || true
}
trap cleanup_jump EXIT
timeout 30 docker network create --internal "${EDH_NET2}" >/dev/null || exit 1
timeout 60 docker run -d --init --name "${EDH_JUMP}" --network "${EDH_NET}" --network-alias edh-jump \
  -e RIG_AUTHORIZED_KEY="$(cat "${EDH_KEY}.pub")" "$(remote_image base)" >/dev/null || exit 1
timeout 30 docker network connect "${EDH_NET2}" "${EDH_JUMP}" || exit 1
timeout 30 docker network connect --alias edh-hidden "${EDH_NET2}" "${EDH_REMOTE}" || exit 1
wait_until "jump sshd up" 30 "timeout 10 docker exec ${EDH_JUMP} pgrep -x sshd" || exit 1
jump_ip=$(timeout 10 docker inspect -f "{{(index .NetworkSettings.Networks \"${EDH_NET2}\").IPAddress}}" "${EDH_JUMP}")
note "jump host on the private network: ${jump_ip}"

expect "the client cannot reach the remote directly (edh-hidden does not resolve)" \
  '! timeout 10 docker exec "${EDH_PC}" getent hosts edh-hidden'
# Host keys: the jump's scanned; the remote's under its private name (same key as edh-remote).
cx "${EDH_PC}" sh -c 'ssh-keyscan -T 5 -t ed25519 edh-jump >> ~/.ssh/known_hosts 2>/dev/null; \
  sed -n "s/^edh-remote /edh-hidden /p" ~/.ssh/known_hosts >> ~/.ssh/known_hosts; \
  cat >> ~/.ssh/config <<EOF
Host edh-jump
  HostName edh-jump
  User wedh
  IdentityFile ~/.ssh/id_ed25519
  IdentitiesOnly yes
Host edh-viajump
  HostName edh-hidden
  User wedh
  IdentityFile ~/.ssh/id_ed25519
  IdentitiesOnly yes
  ProxyJump edh-jump
EOF' || exit 1

EDH_CONNECT_HOST=edh-viajump
connect "${EDH_PC}" || exit 1
new_terminal "${EDH_PC}"
wait_sessions_attached 1 || exit 1
wait_stable 3 30 || true
dump_remote
# Where wedh's SSH logins come from, as sshd told them (SSH_CONNECTION of every wedh process;
# the rig image has no `ss`).
peers=$(rsh 'for p in $(pgrep -u wedh); do tr "\0" "\n" < /proc/$p/environ 2>/dev/null | sed -n "s/^SSH_CONNECTION=\([^ ]*\) .*/\1/p"; done | sort -u')
note "remote ssh peers: ${peers//$'\n'/ }"
expect "connected through the jump host (the remote's ssh peer is the jump)" '[[ "${peers}" == *"${jump_ip}"* ]]'
expect "the jump host relays it (an sshd session for wedh there)" \
  'timeout 10 docker exec "${EDH_JUMP}" pgrep -f "^sshd: wedh"'
expect "terminal is a tmux one: 1 session, 1 client, 1 tmux pty" \
  '[[ $(session_count) -eq 1 && $(pty_tmux_count) -eq 1 && $(pty_plain_count) -eq 0 ]]'
capture "${EDH_PC}" via-jump
