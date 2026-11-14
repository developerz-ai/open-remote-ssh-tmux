# Row 32 (hardening sweep) — listener audit during a live session: every TCP listener owned
# by a VSCodium process in the client container (extension host included: the SOCKS
# dynamic forward, local port forwards) binds loopback only. `ss` runs as the VSCodium user:
# as root it cannot name the owning process (no CAP_SYS_PTRACE in the container).
connect "${EDH_PC}" || exit 1
new_terminal "${EDH_PC}"
wait_sessions_attached 1 || exit 1
wait_stable 5 30 || true
timeout 10 docker exec -u pc "${EDH_PC}" ss -Hltnp > "${EDH_ROW_DIR}/ss-ltnp.txt" 2>&1 || true
timeout 10 docker exec -u pc "${EDH_PC}" ss -Hlunp >> "${EDH_ROW_DIR}/ss-ltnp.txt" 2>&1 || true
note "listeners:"
cat "${EDH_ROW_DIR}/ss-ltnp.txt" >&2
codium_listeners=$(grep -c 'codium' "${EDH_ROW_DIR}/ss-ltnp.txt" || true)
note "VSCodium listeners: ${codium_listeners}"
expect "the audit can attribute listeners (at least one VSCodium-owned)" '[[ ${codium_listeners} -ge 1 ]]'
nonloop=$(grep 'codium' "${EDH_ROW_DIR}/ss-ltnp.txt" | awk '{print $4}' | grep -vE '^(127\.[0-9.]+|\[::1\]|\[::ffff:127\.[0-9.]+\]):' || true)
expect "no VSCodium listener on a non-loopback address${nonloop:+ (found: ${nonloop//$'\n'/ })}" '[[ -z "${nonloop}" ]]'
