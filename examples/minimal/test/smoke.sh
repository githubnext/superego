#!/bin/sh
# The core alone, end to end. Cleans up its daemon afterwards.
set -e
cd "$(dirname "$0")/.."
unset ANTHROPIC_API_KEY ANTHROPIC_OAUTH_TOKEN OPENAI_API_KEY
export MU_MINIMAL_HOME="$(mktemp -d)" MU_MINIMAL_MODEL=faux MU_MINIMAL_HEADLESS=1
cleanup() { [ -f "$MU_MINIMAL_HOME/daemon.pid" ] && kill "$(cat "$MU_MINIMAL_HOME/daemon.pid")" 2>/dev/null; rm -rf "$MU_MINIMAL_HOME"; }
trap cleanup EXIT
node_modules/.bin/electron test/smoke.mjs
