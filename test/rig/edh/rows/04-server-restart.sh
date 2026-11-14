# Row 4 (v1 matrix) — the vscode-server restarts under a live window: kill the REH main
# process on the remote. VS Code reconnects, the resolver starts a fresh server, and that
# server cannot resume the old one's session (stock VS Code then offers "Reload Window" — a
# modal, accepted here with Enter). After the reload the terminal re-attaches: same session
# (name + creation time), process alive, marker in its scrollback, one client, no plain shell.
connect "${EDH_PC}" || exit 1
new_terminal "${EDH_PC}"
wait_sessions_attached 1 || exit 1
read -r name _ created < <(sessions)
wait_prompt "${name}" || exit 1
type_line "${EDH_PC}" 'sleep 9999 & echo $! > /tmp/edh-r04.pid; echo MARKER-R04'
wait_until "sleep pid recorded" 20 'rsh "test -s /tmp/edh-r04.pid"' || exit 1
pid=$(rsh 'cat /tmp/edh-r04.pid')

# The REH main process: `node … out/server-main.js …` (the pty and extension hosts are its
# children and go down with it).
server_pids() { rsh "pgrep -u wedh -f -- '[o]ut/server-main.js' || true"; }
old_server=$(server_pids | head -1)
[[ -n "${old_server}" ]] || { note "no server-main process found"; exit 1; }
resolves=$(resolve_count "${EDH_PC}")
note "killing vscode-server ${old_server}"
rsh "kill -KILL ${old_server}"
expect "the old vscode-server is gone" 'wait_until "server gone" 10 "! rsh \"kill -0 ${old_server}\""'

expect "VS Code re-resolved the remote" \
  'wait_until "re-resolve" 120 "[[ \$(resolve_count ${EDH_PC}) -gt ${resolves} ]]"'
expect "a new vscode-server is running" \
  'wait_until "new server" 120 "server_pids | grep -vqx ${old_server}"'
sleep 5 # stimulus timing: the reconnect is rejected and the reload dialog appears
capture "${EDH_PC}" reconnect-dialog
if ! wait_until "re-wired without a reload" 5 '[[ $(log_count "${EDH_PC}" "Tmux terminal layer wired successfully") -ge 2 ]]'; then
  key "${EDH_PC}" Return # "Reload Window" in the "Cannot reconnect" dialog
fi
wait_wired "${EDH_PC}" 2 || { capture "${EDH_PC}" not-rewired; exit 1; }
wait_sessions_attached 1 60 || true
wait_stable 8 90 || true
dump_remote
expect "same session after the server restart" '[[ "$(sessions | awk "{print \$1, \$3}")" == "${name} ${created}" ]]'
expect "one client on it" '[[ $(client_count "${name}") -eq 1 ]]'
expect "sleep ${pid} still alive" 'rsh "kill -0 ${pid}"'
expect "marker in scrollback" 'pane_has "${name}" MARKER-R04'
expect "pty host: 1 tmux, 0 plain" '[[ $(pty_tmux_count) -eq 1 && $(pty_plain_count) -eq 0 ]]'
capture "${EDH_PC}" after-restart
