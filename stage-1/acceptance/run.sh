#!/bin/sh
# Run the stage-1 acceptance suite against a running container.
#
#   BASE_URL=http://127.0.0.1:8080 ./run.sh            # everything
#   BASE_URL=http://127.0.0.1:9099 ./run.sh --fast     # skip the slow concurrency checks
#
# BASE_URL defaults to http://127.0.0.1:8080, so the suite can be pointed at any
# container on any port. Set ALT_BASE_URL to a second container to also exercise
# cross-container import. Needs only Node 18 or newer -- no packages to install.
set -eu

here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
: "${BASE_URL:=http://127.0.0.1:8080}"
export BASE_URL

if ! command -v node >/dev/null 2>&1; then
  echo "run.sh: node is required (18 or newer)" >&2
  exit 2
fi

major=$(node -p 'process.versions.node.split(".")[0]')
if [ "$major" -lt 18 ]; then
  echo "run.sh: node 18 or newer is required, found $(node --version)" >&2
  exit 2
fi

exec node "$here/main.mjs" "$@"
