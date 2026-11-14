#!/usr/bin/env bash
# Shared helpers for the EDH row scripts (sourced by run.sh, which exports):
#   EDH_REMOTE   remote container (sshd + tmux + pre-installed REH, user `wedh`)
#   EDH_PC       client container "PC"      (VSCodium + Xvfb + xdotool)
#   EDH_LAPTOP   client container "laptop"  (only started for the two-machine rows)
#   EDH_ROW_DIR  this row's artifact directory (screenshots, logs, transcript)
#
# Rules every helper keeps: each docker call is wrapped in `timeout`, nothing attaches
# interactively, and assertions read the REMOTE side (tmux state, the ptyHost's children,
# files) — never pixels. Waits poll real state; the only fixed sleeps are stimulus timing.

EDH_HOST=edh-remote
EDH_WS=/home/wedh/ws
EDH_UDD=/home/pc/data
EDH_EXT=/home/pc/ext
# VSCodium 1.14x writes its logs under XDG state, not under --user-data-dir.
EDH_LOGS=/home/pc/.local/state/VSCodium
EDH_DISPLAY=:99

ROW_FAILURES=0

note() { printf '%s  %s\n' "$(date +%H:%M:%S)" "$*" >&2; }

# --- remote side -----------------------------------------------------------------------

# Run a bash snippet on the remote as the workspace user (the tmux server's owner).
rsh() { timeout 30 docker exec -u wedh "${EDH_REMOTE}" bash -c "$1"; }
# rsh with this shell's stdin passed through (to write a file on the remote).
rsh_in() { timeout 30 docker exec -i -u wedh "${EDH_REMOTE}" bash -c "$1"; }
# Same, as root (signals to sshd, process listing across users).
rroot() { timeout 30 docker exec "${EDH_REMOTE}" bash -c "$1"; }

# `name attached created` for every code-* session (empty when no server runs).
sessions() {
  rsh "tmux ls -F '#{session_name} #{session_attached} #{session_created}' 2>/dev/null | grep '^code-' || true"
}
session_count() { sessions | grep -c . || true; }
session_names() { sessions | awk '{print $1}'; }
# Client pids on one exact session.
client_pids() { rsh "tmux list-clients -t '=$1' -F '#{client_pid}' 2>/dev/null || true"; }
client_count() { client_pids "$1" | grep -c . || true; }
# A session's close marker (`<client id>:<epoch>` once its window's connection dropped).
closed_marker() { rsh "tmux display-message -p -t '=$1:' '#{@orst_closed}' 2>/dev/null || true"; }
# Total tmux clients attached to code-* sessions.
all_clients() {
  rsh "tmux list-clients -F '#{session_name} #{client_pid}' 2>/dev/null | grep '^code-' || true"
}

# What the remote VS Code pty host has spawned AS TERMINALS = what the tabs are running: one
# line per terminal, `tmux: client` for ours (tmux >= 3 renames its client), the login shell
# for a plain one. Only children holding a pty count — the pty host also runs short-lived
# helpers (`sh -c …` for shell/env detection) that are not terminals. The `[-]` keeps pgrep
# from matching the bash running this very snippet.
pty_children() {
  rsh 'for p in $(pgrep -u wedh -f -- "[-]-type=ptyHost"); do ps -o tty=,comm= --ppid "$p"; done' \
    | awk '$1 != "?" { $1 = ""; sub(/^ /, ""); print }'
}
# tmux >= 3.x renames its client process to "tmux: client".
pty_tmux_count() { pty_children | grep -c '^tmux' || true; }
pty_plain_count() { pty_children | grep -vc '^tmux' || true; }

# Wipe the remote between rows: every process of the workspace user (vscode-server, pty
# host, tmux server, its sshd sessions) and every per-row file.
reset_remote() {
  rroot 'pkill -CONT -u wedh 2>/dev/null; pkill -KILL -u wedh 2>/dev/null; sleep 0.5; rm -rf /home/wedh/ws/.vscode /tmp/edh-* /tmp/tmux-*; true'
}

# --- client side -----------------------------------------------------------------------

# (Re)start client container $1 ("machine"): fresh container on the run's network with
# the run's key and .vsix mounted (run.sh exports EDH_NET, EDH_KEY, EDH_VSIX). A row that
# `docker kill`s a machine leaves it to the next row's ensure_client to bring back.
# "pc" / "laptop" from a container name like orst-edh-pc-1234.
machine() {
  local m=${1#orst-edh-}
  echo "${m%-*}"
}

start_client() {
  local c=$1
  timeout 30 docker rm -f "${c}" >/dev/null 2>&1 || true
  timeout 60 docker run -d --init --name "${c}" --hostname "$(machine "${c}")" --network "${EDH_NET}" \
    --shm-size 1g -e EDH_REMOTE_HOST="${EDH_HOST}" \
    -v "${EDH_KEY}:/run/edh/id_ed25519:ro" -v "${EDH_VSIX}:/run/edh/ext.vsix:ro" \
    orst-edh-client >/dev/null || return 1
  wait_until "client ${c} ready" 120 "timeout 10 docker exec ${c} test -e /tmp/edh-client-ready" || {
    timeout 30 docker logs "${c}" 2>&1 | tail -20 >&2
    return 1
  }
}

ensure_client() {
  local running
  running=$(timeout 10 docker inspect -f '{{.State.Running}}' "$1" 2>/dev/null || true)
  [[ "${running}" == true ]] || start_client "$1"
}

# Run a command in a client container as the machine user, on its private display.
cx() {
  local c=$1
  shift
  timeout 30 docker exec -u pc -e DISPLAY="${EDH_DISPLAY}" "${c}" "$@"
}

# Kill VSCodium and start from an empty user-data dir seeded with the driver's settings and
# keybindings (extensions stay installed in their own dir).
reset_client() {
  local c=$1
  timeout 20 docker exec "${c}" sh -c "pkill -KILL -f '[/]opt/vscodium/' 2>/dev/null; sleep 0.5; rm -rf ${EDH_UDD} ${EDH_LOGS}; install -d -o pc -g pc ${EDH_UDD} ${EDH_UDD}/User && install -o pc -g pc -m 0644 /etc/edh-client/settings.json /etc/edh-client/keybindings.json ${EDH_UDD}/User/" >/dev/null
}

codium_running() { timeout 10 docker exec "$1" pgrep -f '/opt/vscodium/codium' >/dev/null 2>&1; }

# Open the remote workspace in a new VSCodium on client $1 (returns at once).
codium_open() {
  local c=$1
  timeout 30 docker exec -d -u pc -e DISPLAY="${EDH_DISPLAY}" "${c}" \
    codium --user-data-dir "${EDH_UDD}" --extensions-dir "${EDH_EXT}" \
    --no-sandbox --disable-gpu --password-store=basic --log trace \
    --folder-uri "vscode-remote://ssh-remote+${EDH_HOST}${EDH_WS}"
}

# The visible VSCodium window id (the newest when several map).
window_id() { cx "$1" xdotool search --onlyvisible --name 'VSCodium' 2>/dev/null | tail -1; }

# Press a key chord in the VSCodium window of client $1 (XTEST, after focusing it).
key() {
  local c=$1 chord=$2 wid
  wid=$(window_id "${c}")
  [[ -n "${wid}" ]] || { note "no VSCodium window on ${c}"; return 1; }
  cx "${c}" xdotool windowfocus --sync "${wid}" key --clearmodifiers "${chord}"
}

# Type literal text into the focused element, then Enter.
type_line() {
  local c=$1 text=$2 wid
  wid=$(window_id "${c}")
  [[ -n "${wid}" ]] || { note "no VSCodium window on ${c}"; return 1; }
  cx "${c}" xdotool windowfocus --sync "${wid}" type --delay 15 -- "${text}"
  cx "${c}" xdotool key Return
}

# The driver's keybindings (client/keybindings.json).
new_terminal() { key "$1" ctrl+alt+shift+F1; }
reload_window() { key "$1" ctrl+alt+shift+F2; }
close_window() { key "$1" ctrl+alt+shift+F3; }
kill_terminal() { key "$1" ctrl+alt+shift+F4; }
focus_terminal() { key "$1" ctrl+alt+shift+F5; }

# Flip remote.SSH.tmux.enabled in client $1's user settings (application scope) while the
# window is running — VS Code picks the file change up live, like a Settings UI edit.
set_tmux_enabled() {
  local c=$1 value=$2
  cx "${c}" sh -c "f=${EDH_UDD}/User/settings.json; grep -v '\"remote.SSH.tmux.enabled\"' \"\$f\" | sed '1a\\
	\"remote.SSH.tmux.enabled\": \"${value}\",' > \"\$f.new\" && mv \"\$f.new\" \"\$f\""
}

# Every "Remote - SSH" output-channel log of client $1, oldest first, concatenated.
remote_log() {
  cx "$1" sh -c "find ${EDH_LOGS} -name '*Remote - SSH.log' -printf '%T@ %p\n' 2>/dev/null | sort -n | cut -d' ' -f2- | while IFS= read -r f; do cat \"\$f\"; done"
}
log_count() { remote_log "$1" | grep -cE -- "$2" || true; }

# Screenshot + the extension log of client $1 into the row's artifact dir.
capture() {
  local c=$1 label=$2
  cx "${c}" import -window root "/tmp/edh-shot.png" >/dev/null 2>&1 \
    && timeout 30 docker cp "${c}:/tmp/edh-shot.png" "${EDH_ROW_DIR}/${label}.png" >/dev/null 2>&1 \
    || note "screenshot ${label} failed"
  remote_log "${c}" > "${EDH_ROW_DIR}/${label}.remote-ssh.log" 2>/dev/null || true
  # Every VSCodium log (main, renderer, exthost, …) for diagnosis; the next row wipes them.
  timeout 30 docker cp "${c}:${EDH_LOGS}" "${EDH_ROW_DIR}/${label}.vscodium-logs" >/dev/null 2>&1 || true
}

# --- waiting and asserting -------------------------------------------------------------

# wait_until <description> <seconds> <shell condition…>: poll the condition every 0.5 s.
wait_until() {
  local what=$1 secs=$2
  shift 2
  local deadline=$((SECONDS + secs))
  while ((SECONDS < deadline)); do
    if eval "$*" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.5
  done
  note "timed out after ${secs}s waiting for: ${what}"
  return 1
}

# Wait until client $1's window has connected and wired the tmux layer at least $2 times
# in total (a reload re-wires in a new extension host, so the count grows by one).
wait_wired() {
  local c=$1 n=${2:-1}
  wait_until "tmux layer wired (#${n}) on ${c}" 120 \
    "[[ \$(log_count ${c} 'Tmux terminal layer wired successfully') -ge ${n} ]]"
}

# Open the workspace on client $1 and wait for the wired layer; on failure, capture.
connect() {
  local c=$1 n=${2:-1}
  codium_open "${c}"
  wait_until "VSCodium window on ${c}" 60 "[[ -n \$(window_id ${c}) ]]" || { capture "${c}" "connect-failed"; return 1; }
  # "wired" is logged only once the default-profile write has landed, so a terminal opened
  # from here on is a tmux one (row 01b holds the extension to that; no settle wait here).
  wait_wired "${c}" "${n}" || { capture "${c}" "connect-failed"; return 1; }
}

# The extension's Workspace-scope write of terminal.integrated.defaultProfile.linux.
default_profile_written() { rsh "grep -q 'Persistent Shell' ${EDH_WS}/.vscode/settings.json"; }
wait_default_profile() { wait_until "default profile written" 30 default_profile_written; }

# Wait until there are exactly $1 code-* sessions, each with exactly one client.
wait_sessions_attached() {
  local n=$1 secs=${2:-40}
  wait_until "${n} code-* session(s), all attached" "${secs}" \
    "[[ \$(session_count) -eq ${n} ]] && [[ \$(sessions | awk '\$2 != 1' | grep -c .) -eq 0 ]]"
}

# Wait until session $1's pane shows a shell prompt (so typed input reaches the shell).
has_prompt() { rsh "tmux capture-pane -p -t '=$1:' | grep -qE '[\$#] ?\$'"; }
pane_text() { rsh "tmux capture-pane -p -t '=$1:'"; }
# A prompt, and the pane unchanged for 1.5 s: the login shell's start-up output (and any
# redraw on the first resize) is over, so typed input is not interleaved with it.
wait_prompt() {
  local name=$1 last='' now since=$SECONDS deadline=$((SECONDS + 30))
  while ((SECONDS < deadline)); do
    now=$(pane_text "${name}" 2>/dev/null || true)
    if [[ "${now}" != "${last}" ]]; then
      last=${now}
      since=$SECONDS
    elif ((SECONDS - since >= 2)) && has_prompt "${name}"; then
      return 0
    fi
    sleep 0.5
  done
  note "timed out waiting for a quiet prompt in ${name}"
  return 1
}

# Does session $1's full scrollback contain $2?
pane_has() { rsh "tmux capture-pane -p -S - -t '=$1:' | grep -qF -- '$2'"; }

# Wait until the remote state stops changing for $1 seconds (bounded by $2).
wait_stable() {
  local quiet=$1 secs=$2 last='' now since=$SECONDS deadline
  deadline=$((SECONDS + secs))
  while ((SECONDS < deadline)); do
    now="$(sessions)|$(all_clients | awk '{print $1}' | sort)|$(pty_children | sort)"
    if [[ "${now}" != "${last}" ]]; then
      last=${now}
      since=$SECONDS
    elif ((SECONDS - since >= quiet)); then
      return 0
    fi
    sleep 0.5
  done
  note "remote state never settled for ${quiet}s within ${secs}s"
  return 1
}

# expect <description> <shell condition…>: record ok/FAIL for this row, never abort.
expect() {
  local what=$1
  shift
  if eval "$*" >/dev/null 2>&1; then
    note "ok    ${what}"
  else
    note "FAIL  ${what}"
    ROW_FAILURES=$((ROW_FAILURES + 1))
  fi
}

# Snapshot of the remote, for the transcript.
dump_remote() {
  {
    echo "--- sessions (name attached created)"
    sessions
    echo "--- clients (session pid)"
    all_clients
    echo "--- pty host children"
    pty_children
  } >&2
}
