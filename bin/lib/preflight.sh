# Sourced by the bin/ scripts (after they cd to the repo root). Turns the silent ways a
# checkout goes wrong into a clear message:
#  - a Node that is not the .nvmrc major: warn (most things work, but CI is on .nvmrc);
#  - missing node_modules: fail, or every script dies with a cryptic `vitest: not found`;
#  - node_modules older than package-lock.json: warn (probably stale).

preflight_node() {
  if ! command -v node >/dev/null 2>&1; then
    echo "bin: node is not on PATH; install Node $(cat .nvmrc) (see .nvmrc)" >&2
    exit 1
  fi
  wanted=$(sed 's/^v//; s/\..*//' .nvmrc)
  actual=$(node -p 'process.versions.node.split(".")[0]')
  if [ "${wanted}" != "${actual}" ]; then
    echo "bin: warning: Node $(node -v) is in use, but .nvmrc pins $(cat .nvmrc), which CI runs; results may differ" >&2
  fi
}

preflight_deps() {
  if [ ! -d node_modules/.bin ]; then
    echo "bin: node_modules is missing; run bin/setup first" >&2
    exit 1
  fi
  # npm rewrites node_modules/.package-lock.json on install, so a package-lock.json newer
  # than it means the lockfile moved (a pull, a branch switch) since the last install.
  # A warning only: mtimes cannot tell a real change from a checkout of identical bytes.
  if [ ! -f node_modules/.package-lock.json ] \
    || [ -n "$(find package-lock.json -newer node_modules/.package-lock.json)" ]; then
    echo "bin: warning: package-lock.json is newer than node_modules; run bin/setup if dependencies changed" >&2
  fi
}
