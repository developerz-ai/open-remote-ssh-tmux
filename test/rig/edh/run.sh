#!/usr/bin/env bash
# EDH acceptance driver: real VSCodium (in docker, under its own Xvfb) + the extension .vsix
# under test, connected over real SSH to a real-tmux rig container, driven by xdotool.
# One script per automatable matrix row in rows/; assertions read the remote's tmux state.
#
#   test/rig/edh/run.sh <path/to/extension.vsix> [row …]
#   test/rig/edh/run.sh ./open-remote-ssh-tmux.vsix            every row in rows/
#   test/rig/edh/run.sh ./x.vsix 06-exit-closes 07-churn      just these (file stems)
#
# Env: EDH_OUT    artifact dir (default: a new mktemp dir; printed at the end)
#      EDH_TMUX   rig tmux version for the remote (default 3.4; any service in compose.yml)
#
# Needs docker only. Nothing listens on the host: the containers share a private docker
# network and publish no ports. The SSH key is generated per run and deleted on exit.
# Exit status: 0 when every selected row passed, 1 otherwise.
set -euo pipefail

readonly VSCODIUM_VERSION=1.143.17232
readonly VSCODIUM_SHA256=ca1895aa040bd91a09c709d79eac7862d8c1aa0237fdc25b503deeb8bcd87efd
readonly REH_SHA256=7ac6cec1343f2734be8ccf34bc8dbf5176e315295cec78ad34712f254d7f40ef

edh_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
rig_dir=$(cd "${edh_dir}/.." && pwd)
readonly edh_dir rig_dir

if [[ $# -lt 1 || ! -f "$1" ]]; then
  echo "usage: $0 <extension.vsix> [row …]   (rows: $(cd "${edh_dir}/rows" && ls -- *.sh | sed 's/\.sh$//' | tr '\n' ' '))" >&2
  exit 2
fi
EDH_VSIX=$(cd "$(dirname "$1")" && pwd)/$(basename "$1")
shift
tmux_version=${EDH_TMUX:-3.4}

rows=("$@")
if [[ ${#rows[@]} -eq 0 ]]; then
  mapfile -t rows < <(cd "${edh_dir}/rows" && ls -- *.sh | sed 's/\.sh$//' | sort -V)
fi
for row in "${rows[@]}"; do
  [[ -f "${edh_dir}/rows/${row}.sh" ]] || { echo "edh: no such row: ${row}" >&2; exit 2; }
done

command -v docker >/dev/null 2>&1 || { echo "edh: docker is not installed" >&2; exit 2; }
timeout 20 docker info >/dev/null 2>&1 || { echo "edh: the docker daemon is not reachable" >&2; exit 2; }

EDH_OUT=${EDH_OUT:-$(mktemp -d -t orst-edh-XXXXXX)}
mkdir -p "${EDH_OUT}"
EDH_OUT=$(cd "${EDH_OUT}" && pwd)
work=$(mktemp -d)
run_id=$$
EDH_NET=orst-edh-net-${run_id}
EDH_REMOTE=orst-edh-remote-${run_id}
EDH_PC=orst-edh-pc-${run_id}
EDH_LAPTOP=orst-edh-laptop-${run_id}
EDH_KEY=${work}/id_ed25519
export EDH_OUT EDH_NET EDH_REMOTE EDH_PC EDH_LAPTOP EDH_KEY EDH_VSIX

cleanup() {
  timeout 60 docker rm -f "${EDH_PC}" "${EDH_LAPTOP}" "${EDH_REMOTE}" >/dev/null 2>&1 || true
  timeout 30 docker network rm "${EDH_NET}" >/dev/null 2>&1 || true
  rm -rf "${work}"
}
trap cleanup EXIT

# shellcheck source=lib.sh
source "${edh_dir}/lib.sh"

note "building rig image orst-tmux-rig:${tmux_version}"
RIG_AUTHORIZED_KEY=build-only timeout 1800 docker compose --project-name orst-edh-rigbuild \
  --file "${rig_dir}/compose.yml" build "tmux-${tmux_version}" >"${EDH_OUT}/build.log" 2>&1
note "building orst-edh-remote:${tmux_version} and orst-edh-client (VSCodium ${VSCODIUM_VERSION})"
timeout 1800 docker build --file "${edh_dir}/remote.Dockerfile" \
  --build-arg RIG_IMAGE="orst-tmux-rig:${tmux_version}" \
  --build-arg VSCODIUM_VERSION="${VSCODIUM_VERSION}" --build-arg REH_SHA256="${REH_SHA256}" \
  --tag "orst-edh-remote:${tmux_version}" "${edh_dir}" >>"${EDH_OUT}/build.log" 2>&1
timeout 1800 docker build --file "${edh_dir}/client.Dockerfile" \
  --build-arg VSCODIUM_VERSION="${VSCODIUM_VERSION}" --build-arg VSCODIUM_SHA256="${VSCODIUM_SHA256}" \
  --tag orst-edh-client "${edh_dir}" >>"${EDH_OUT}/build.log" 2>&1

ssh-keygen -q -t ed25519 -N '' -C orst-edh -f "${EDH_KEY}"
timeout 30 docker network create "${EDH_NET}" >/dev/null
timeout 60 docker run -d --init --name "${EDH_REMOTE}" --network "${EDH_NET}" --network-alias "${EDH_HOST}" \
  -e RIG_AUTHORIZED_KEY="$(cat "${EDH_KEY}.pub")" "orst-edh-remote:${tmux_version}" >/dev/null

results="${EDH_OUT}/results.tsv"
: > "${results}"
overall=0
for row in "${rows[@]}"; do
  EDH_ROW_DIR="${EDH_OUT}/${row}"
  export EDH_ROW_DIR
  mkdir -p "${EDH_ROW_DIR}"
  note "=== row ${row}"
  # Two-machine rows say so in their header; everything else runs on the PC only.
  ensure_client "${EDH_PC}"
  if grep -q '^# edh: machines=2' "${edh_dir}/rows/${row}.sh"; then
    ensure_client "${EDH_LAPTOP}"
  fi
  for c in "${EDH_PC}" "${EDH_LAPTOP}"; do
    if timeout 10 docker inspect "${c}" >/dev/null 2>&1; then
      reset_client "${c}"
    fi
  done
  reset_remote
  started=$SECONDS
  set +e
  (
    set -uo pipefail
    # shellcheck source=lib.sh
    source "${edh_dir}/lib.sh"
    # shellcheck disable=SC1090 # the row script is chosen at run time
    source "${edh_dir}/rows/${row}.sh"
    exit $((ROW_FAILURES > 0 ? 1 : 0))
  ) 2>&1 | tee "${EDH_ROW_DIR}/transcript.txt" >&2
  status=${PIPESTATUS[0]}
  set -e
  case "${status}" in
    0) verdict=PASS ;;
    3) verdict=NOT-AUTOMATED ;;
    *) verdict=FAIL; overall=1 ;;
  esac
  # Final evidence for every row, whatever happened.
  for c in "${EDH_PC}" "${EDH_LAPTOP}"; do
    if codium_running "${c}" 2>/dev/null; then
      capture "${c}" "end-$(machine "${c}")"
    fi
  done
  dump_remote 2> "${EDH_ROW_DIR}/remote-state.txt" || true
  printf '%s\t%s\t%ss\t%s\n' "${row}" "${verdict}" "$((SECONDS - started))" "${EDH_ROW_DIR}" | tee -a "${results}" >&2
done

note "results: ${results}"
column -t -s $'\t' "${results}" >&2 || cat "${results}" >&2
exit "${overall}"
