#!/bin/sh
# EDH client container start: install the run's throwaway key and the SSH config for the
# remote, pin its host key (so connect never stops on the "authenticity of host" prompt),
# start a private Xvfb, install the mounted .vsix, then idle. VSCodium itself is launched
# per row by lib.sh (`codium_open`), never here.
#
# Mounts (run.sh): /run/edh/id_ed25519 (private key, ro), /run/edh/ext.vsix (ro).
# Env: EDH_REMOTE_HOST — the remote's name on the docker network.
set -eu

: "${EDH_REMOTE_HOST:?}"
home=/home/pc

install -d -m 0700 -o pc -g pc "${home}/.ssh"
install -m 0600 -o pc -g pc /run/edh/id_ed25519 "${home}/.ssh/id_ed25519"
cat > "${home}/.ssh/config" <<EOF
Host ${EDH_REMOTE_HOST}
  HostName ${EDH_REMOTE_HOST}
  User wedh
  IdentityFile ${home}/.ssh/id_ed25519
  IdentitiesOnly yes
EOF
chown pc:pc "${home}/.ssh/config"

# The remote may still be starting: retry the scan for up to ~30 s.
tries=0
until ssh-keyscan -T 2 -t ed25519 "${EDH_REMOTE_HOST}" > "${home}/.ssh/known_hosts" 2>/dev/null \
  && [ -s "${home}/.ssh/known_hosts" ]; do
  tries=$((tries + 1))
  if [ "${tries}" -ge 30 ]; then
    echo "edh-client: could not scan ${EDH_REMOTE_HOST}'s host key" >&2
    exit 1
  fi
  sleep 1
done
chown pc:pc "${home}/.ssh/known_hosts"

# -nolisten tcp: the X server must not show up as a listener in row 32's audit.
runuser -u pc -- Xvfb :99 -screen 0 1600x1000x24 -nolisten tcp >/tmp/xvfb.log 2>&1 &

# The extension needs proposed APIs (resolvers); enabled exactly as README "Activation" tells
# users to, via argv.json.
install -d -o pc -g pc "${home}/.vscode-oss"
printf '{\n\t"enable-crash-reporter": false,\n\t"enable-proposed-api": ["developerz-ai.open-remote-ssh-tmux"]\n}\n' > "${home}/.vscode-oss/argv.json"
chown pc:pc "${home}/.vscode-oss/argv.json"

runuser -u pc -- codium --extensions-dir "${home}/ext" --install-extension /run/edh/ext.vsix --force

touch /tmp/edh-client-ready
exec sleep infinity
