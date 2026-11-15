# Row 35 (hardening sweep) — Ctrl-B and Esc typed into the integrated terminal reach the
# program inside, once each, and Esc is not held back by tmux's escape-time. A small bash
# key logger on the remote stamps every byte it reads (`date +%s%N`); the driver stamps
# each keypress right before xdotool sends it. Both containers share the host kernel's
# clock, so remote - client = end-to-end latency. `x` is the baseline key.
# Truecolor: a gradient is printed and screenshotted — eyes only.
# Note: stock VS Code binds Ctrl+B to the sidebar even inside a terminal; the driver's
# settings remove that from commandsToSkipShell (what a Claude Code user does), so this row
# measures tmux, not VS Code's keymap.
connect "${EDH_PC}" || exit 1
new_terminal "${EDH_PC}"
wait_sessions_attached 1 || exit 1
name=$(session_names)
wait_prompt "${name}" || exit 1
rsh_in "cat > /tmp/edh-keys.sh" <<'LOGGER'
out=/tmp/edh-keys.log
: > "$out"
echo ready > /tmp/edh-keys.ready
while IFS= read -rsn1 c; do
  printf '%s %s\n' "$(date +%s%N)" "$(printf '%s' "$c" | od -An -tx1 | tr -d ' \n')" >> "$out"
  [ "$c" = q ] && break
done
LOGGER
type_line "${EDH_PC}" 'bash /tmp/edh-keys.sh'
wait_until "key logger ready" 20 'rsh "test -e /tmp/edh-keys.ready"' || exit 1
wid=$(window_id "${EDH_PC}")
: > "${EDH_ROW_DIR}/keys.tsv"
n=0
for k in x ctrl+b x Escape x Escape x ctrl+b; do
  sent=$(cx "${EDH_PC}" sh -c "xdotool windowfocus --sync ${wid}; date +%s%N; xdotool key ${k}" | tail -1)
  n=$((n + 1))
  if wait_until "byte ${n} logged" 5 '[[ $(rsh "grep -c . /tmp/edh-keys.log") -ge ${n} ]]'; then
    read -r got hex < <(rsh "sed -n ${n}p /tmp/edh-keys.log")
    printf '%s\t%s\t%s ms\n' "${k}" "${hex}" "$(( (got - sent) / 1000000 ))" >> "${EDH_ROW_DIR}/keys.tsv"
  else
    printf '%s\t(missing)\t-\n' "${k}" >> "${EDH_ROW_DIR}/keys.tsv"
  fi
done
cx "${EDH_PC}" xdotool key q
note "key  bytes  latency"
cat "${EDH_ROW_DIR}/keys.tsv" >&2
expect "every key arrived exactly once (no extra/missing bytes)" '[[ $(rsh "grep -c . /tmp/edh-keys.log") -eq $((n + 1)) ]]'
expect "Ctrl-B arrived as 0x02 (no tmux prefix)" '[[ $(grep -c $'"'"'^ctrl+b\t02\t'"'"' "${EDH_ROW_DIR}/keys.tsv") -eq 2 ]]'
expect "Esc arrived as 0x1b" '[[ $(grep -c $'"'"'^Escape\t1b\t'"'"' "${EDH_ROW_DIR}/keys.tsv") -eq 2 ]]'
base=$(awk -F'\t' '$1 == "x" {gsub(/ ms/, "", $3); if ($3 > m) m = $3} END {print m + 0}' "${EDH_ROW_DIR}/keys.tsv")
esc=$(awk -F'\t' '$1 == "Escape" {gsub(/ ms/, "", $3); if ($3 > m) m = $3} END {print m + 0}' "${EDH_ROW_DIR}/keys.tsv")
note "worst baseline ${base} ms, worst Esc ${esc} ms"
expect "Esc not delayed (worst Esc <= worst baseline + 100 ms)" '[[ ${esc} -le $((base + 100)) ]]'
type_line "${EDH_PC}" "clear; awk 'BEGIN{for(i=0;i<80;i++){r=int(255-i*3.2);printf \"\\033[48;2;%d;%d;128m \",r,i*3;}printf \"\\033[0m\\n\"}'"
sleep 1
capture "${EDH_PC}" truecolor
