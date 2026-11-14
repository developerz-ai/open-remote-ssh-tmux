#!/usr/bin/env bash
# Build the real-tmux rig, start it, run the `integration` vitest project against it, and
# tear it down again — whatever happens in between.
#
#   test/rig/run.sh                  every matrix version (npm run test:tmux)
#   test/rig/run.sh --one            the reference version only, 3.4 (npm run test:tmux:one)
#   test/rig/run.sh 2.6 3.5a         just these versions
#   test/rig/run.sh 3.4 -- -t probe  anything after `--` goes to vitest
#
# Needs docker with the compose plugin, and nothing else: the SSH key is generated per run
# in a private temp dir and deleted on exit, and the containers listen on 127.0.0.1 only.
# Without docker the run is skipped with a message locally, but FAILS in CI (`CI` set), so
# a runner that lost docker cannot turn the rig job green by testing nothing.
set -euo pipefail

readonly REFERENCE_VERSION=3.4
rig_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
repo_root=$(cd "${rig_dir}/../.." && pwd)
readonly rig_dir repo_root

no_docker() {
  if [[ -n "${CI:-}" ]]; then
    echo "rig: $1 — the tmux rig cannot run, failing (CI is set)" >&2
    exit 1
  fi
  echo "rig: $1 — skipping the real-tmux integration tests" >&2
  exit 0
}

command -v docker >/dev/null 2>&1 || no_docker "docker is not installed"
docker info >/dev/null 2>&1 || no_docker "the docker daemon is not reachable"
docker compose version >/dev/null 2>&1 || no_docker "the docker compose plugin is missing"

versions=()
vitest_args=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --one) versions+=("${REFERENCE_VERSION}") ;;
    --) shift; vitest_args=("$@"); break ;;
    -*) echo "rig: unknown option $1" >&2; exit 2 ;;
    *) versions+=("$1") ;;
  esac
  shift
done

# A per-run project name, so a local run never tears down a concurrent one.
project="orst-tmux-rig-$$"
compose=(docker compose --project-name "${project}" --file "${rig_dir}/compose.yml")

work=$(mktemp -d)
cleanup() {
  "${compose[@]}" down --volumes --remove-orphans >/dev/null 2>&1 || true
  rm -rf "${work}"
}
trap cleanup EXIT

ssh-keygen -q -t ed25519 -N '' -C orst-tmux-rig -f "${work}/id_ed25519"
RIG_AUTHORIZED_KEY=$(cat "${work}/id_ed25519.pub")
export RIG_AUTHORIZED_KEY

if [[ ${#versions[@]} -eq 0 ]]; then
  mapfile -t versions < <("${compose[@]}" config --services | sed -n 's/^tmux-//p' | sort -V)
fi
services=()
for version in "${versions[@]}"; do
  services+=("tmux-${version}")
done

echo "rig: building and starting tmux ${versions[*]}"
"${compose[@]}" up --detach --build --wait "${services[@]}"

targets=()
for version in "${versions[@]}"; do
  targets+=("${version}=$("${compose[@]}" port "tmux-${version}" 22)")
done
RIG_TARGETS=$(IFS=,; echo "${targets[*]}")
export RIG_TARGETS
export RIG_KEY="${work}/id_ed25519"
echo "rig: targets ${RIG_TARGETS}"

cd "${repo_root}"
npx vitest run --project integration "${vitest_args[@]}"
