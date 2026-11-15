# edh: machines=2
# Row 20 (v1 matrix) — reconciliation after both machines close. Runs row 19 first (PC with 2
# terminals, laptop with a fresh third), then: close the laptop, close the PC, reopen the PC.
# The PC comes back with its own 2 terminals PLUS the laptop's, adopted: still exactly the same
# 3 sessions (names + creation times), one client each, 3 tmux terminals and no plain shell —
# no duplicates.
# shellcheck source=19-concurrent-no-steal.sh
source "${edh_dir}/rows/19-concurrent-no-steal.sh"
[[ -n "${laptop_session}" ]] || exit 1
all_before=$(sessions | awk '{print $1, $3}' | sort)
pc_new_slots=$(log_count "${A}" "new slot")

close_window "${B}"
wait_until "laptop VSCodium exited" 30 '! codium_running "${B}"' || true
expect "the laptop's close marked its session closed (or its client went away)" \
  'wait_until "closed marker" 20 "[[ \$(closed_marker ${laptop_session}) =~ ^[0-9a-f-]+:[0-9]+\$ || \$(client_count ${laptop_session}) -eq 0 ]]"'
close_window "${A}"
wait_until "PC VSCodium exited" 30 '! codium_running "${A}"' || true

connect "${A}" 2 || exit 1
wait_sessions_attached 3 90 || true
wait_stable 8 90 || true
dump_remote
expect "still the same 3 sessions (names + creation times)" '[[ "$(sessions | awk "{print \$1, \$3}" | sort)" == "${all_before}" ]]'
expect "each has exactly one client" '[[ $(sessions | awk "\$2 != 1" | grep -c .) -eq 0 ]]'
expect "pty host: 3 tmux, 0 plain (the PC shows all three, no duplicate)" '[[ $(pty_tmux_count) -eq 3 && $(pty_plain_count) -eq 0 ]]'
expect "the PC took the laptop's session (adopt or hand-off take-over logged)" \
  '[[ $(log_count "${A}" "-> (adopt|handoff-takeover)") -ge 1 ]]'
expect "no new slot on the reopen" '[[ $(log_count "${A}" "new slot") -eq ${pc_new_slots} ]]'
capture "${A}" pc-three-terminals
