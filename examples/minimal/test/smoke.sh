#!/bin/sh
# The core alone, end to end. Cleans up its daemon afterwards.
set -e
cd "$(dirname "$0")/.."
unset ANTHROPIC_API_KEY ANTHROPIC_OAUTH_TOKEN OPENAI_API_KEY
export MU_MINIMAL_HOME="$(mktemp -d)" MU_MINIMAL_MODEL=faux MU_MINIMAL_HEADLESS=1
cleanup() {
  # The daemon by its pid file, and anything still holding its socket.
  for pid in $(cat "$MU_MINIMAL_HOME/daemon.pid" 2>/dev/null) $(lsof -t "$MU_MINIMAL_HOME"/*.sock 2>/dev/null); do kill "$pid" 2>/dev/null || true; done
  rm -rf "$MU_MINIMAL_HOME"
}
trap cleanup EXIT
node_modules/.bin/electron test/smoke.mjs
