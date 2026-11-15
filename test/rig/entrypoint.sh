#!/bin/sh
# Install the run's throwaway public key for every rig user, then run sshd in the
# foreground. The key arrives through the environment (run.sh generates it per run), so
# nothing secret is ever baked into the image or committed.
set -eu

if [ -z "${RIG_AUTHORIZED_KEY:-}" ]; then
  echo "rig: RIG_AUTHORIZED_KEY is empty; start the rig through test/rig/run.sh" >&2
  exit 1
fi

for home in /home/*; do
  user=$(basename "${home}")
  install -d -m 0700 -o "${user}" -g "${user}" "${home}/.ssh"
  printf '%s\n' "${RIG_AUTHORIZED_KEY}" > "${home}/.ssh/authorized_keys"
  chown "${user}:${user}" "${home}/.ssh/authorized_keys"
  chmod 0600 "${home}/.ssh/authorized_keys"
done

exec /usr/sbin/sshd -D -e
