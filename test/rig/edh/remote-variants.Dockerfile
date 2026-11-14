# EDH remote variants: the EDH remote (remote.Dockerfile) with one thing changed, for the rows
# that need a different host (`# edh: remote=<target>` in a row's header; run.sh swaps the
# remote container for that row and back). Same image underneath, so same host keys — a
# client's pinned known_hosts entry stays valid across the swap.
#
#   notmux  row 12: a Unix host without tmux (the rig installs it only at /usr/local/bin)
#   logind  row 36: a host whose logind ends a user's processes at logout — a `loginctl` stub
#           first on PATH answering `KillUserProcesses=yes` (the rig has no systemd)

ARG BASE=orst-edh-remote:3.4

FROM ${BASE} AS notmux
RUN rm /usr/local/bin/tmux && ! command -v tmux

FROM ${BASE} AS logind
COPY remote/loginctl-kill-user-processes /usr/local/bin/loginctl
RUN chmod 0755 /usr/local/bin/loginctl \
  && [ "$(su -s /bin/sh wedh -c 'command -v loginctl')" = /usr/local/bin/loginctl ]
