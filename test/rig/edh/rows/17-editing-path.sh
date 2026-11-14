# Row 17 (v1 matrix) + base pass "file edit/save, extension install on remote, port forward" —
# the non-terminal path is unchanged with the tmux layer live (a tmux terminal is open
# throughout):
#   a) open a remote file in the window, type at its end, Save -> the remote file has the edit;
#   b) Install from VSIX a workspace-kind extension (fixtures/edh-probe-ext, built into the
#      client image, copied to the remote) in the remote window -> it lands in the REMOTE server's extensions
#      and activates there (writes /tmp/edh-probe-ext.activated on the remote, not the client);
#   c) "Forward a Port" for a server listening on the remote's 127.0.0.1 -> curl in the client
#      container gets its answer through a VSCodium-owned loopback listener.
# Auto-forwarding is off for this row so c) proves the explicit forward, not port detection.
set_setting "${EDH_PC}" remote.autoForwardPorts false
rsh "printf 'ORIGINAL-R17\n' > ${EDH_WS}/edh-edit-17.txt"
connect "${EDH_PC}" || exit 1
new_terminal "${EDH_PC}"
wait_sessions_attached 1 || exit 1
name=$(session_names)
wait_stable 3 30 || true

# a) edit + save: File: Open File... — an in-workbench dialog over the REMOTE filesystem in a
# remote window — the path typed in, then the edit at the end of the file and Ctrl+S.
palette "${EDH_PC}" 'File: Open File'
sleep 2 # stimulus timing: the open dialog lists the folder
key "${EDH_PC}" ctrl+a
type_line "${EDH_PC}" "${EDH_WS}/edh-edit-17.txt"
sleep 3 # the editor opens and takes focus
key "${EDH_PC}" ctrl+End
cx "${EDH_PC}" xdotool type --delay 15 -- 'EDITED-R17'
key "${EDH_PC}" ctrl+s
expect "a) the saved edit is in the remote file" \
  'wait_until "remote file edited" 20 "rsh \"grep -q EDITED-R17 ${EDH_WS}/edh-edit-17.txt\""'
expect "a) the original content is kept" 'rsh "grep -q ORIGINAL-R17 ${EDH_WS}/edh-edit-17.txt"'
capture "${EDH_PC}" a-edited

# b) extension install on the remote: the .vsix is put on the remote, then Extensions: Install
# from VSIX... (the same in-workbench dialog, on the remote filesystem) with its path typed in.
timeout 30 docker cp "${EDH_PC}:/opt/edh/edh-probe-0.0.1.vsix" - | timeout 30 docker cp - "${EDH_REMOTE}:/tmp/" || exit 1
rroot 'mv /tmp/edh-probe-0.0.1.vsix /tmp/edh-probe.vsix && chmod 0644 /tmp/edh-probe.vsix'
palette "${EDH_PC}" 'Extensions: Install from VSIX'
sleep 2
key "${EDH_PC}" ctrl+a
type_line "${EDH_PC}" /tmp/edh-probe.vsix
expect "b) the extension is installed in the remote server's extensions" \
  'wait_until "remote extension dir" 60 "rsh \"ls -d /home/wedh/.vscodium-server/extensions/edh.edh-probe-0.0.1*\""'
expect "b) it activated on the remote" 'wait_until "activated on remote" 60 "rsh \"test -s /tmp/edh-probe-ext.activated\""'
expect "b) it did not install or run on the client" \
  '! timeout 10 docker exec "${EDH_PC}" sh -c "ls -d ${EDH_EXT}/edh.edh-probe-* /tmp/edh-probe-ext.activated 2>/dev/null | grep -q ."'
note "b) remote activation: $(rsh 'cat /tmp/edh-probe-ext.activated' 2>/dev/null)"
capture "${EDH_PC}" b-extension-installed

# c) port forward
node=$(rsh 'ls -d /home/wedh/.vscodium-server/bin/*/node | head -1')
rsh "setsid -f ${node} -e 'require(\"http\").createServer((q, s) => s.end(\"EDH-PORT-R17\\n\")).listen(8765, \"127.0.0.1\")' >/dev/null 2>&1"
wait_until "remote http server" 20 "rsh \"${node} -e 'require(\\\"http\\\").get(\\\"http://127.0.0.1:8765\\\", r => process.exit(r.statusCode === 200 ? 0 : 1)).on(\\\"error\\\", () => process.exit(1))'\"" || exit 1
key "${EDH_PC}" ctrl+alt+shift+F9
sleep 1.5
type_line "${EDH_PC}" '8765'
forwarded() {
  local port
  for port in $(timeout 10 docker exec -u pc "${EDH_PC}" ss -Hltnp 2>/dev/null | grep codium | awk '{print $4}' | grep -E '^127\.0\.0\.1:' | cut -d: -f2); do
    if timeout 10 docker exec "${EDH_PC}" curl -fsS --max-time 3 "http://127.0.0.1:${port}/" 2>/dev/null | grep -q EDH-PORT-R17; then
      echo "${port}"
      return 0
    fi
  done
  return 1
}
expect "c) curl in the client reaches the remote server through the forward" 'wait_until "forwarded" 30 forwarded'
note "c) forwarded on client port $(forwarded || echo none)"
capture "${EDH_PC}" c-port-forwarded

dump_remote
expect "the tmux terminal stayed attached throughout" '[[ $(session_count) -eq 1 && $(client_count "${name}") -eq 1 ]]'
