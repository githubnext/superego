#!/bin/sh
# Two app processes against one daemon, which must outlive the first. Cleans up the daemon afterwards.
set -e
cd "$(dirname "$0")/.."
unset ANTHROPIC_API_KEY ANTHROPIC_OAUTH_TOKEN OPENAI_API_KEY
export MU_HOME="$(mktemp -d)" MU_MODEL=faux MU_HEADLESS=1
cleanup() { [ -f "$MU_HOME/daemon.pid" ] && kill "$(cat "$MU_HOME/daemon.pid")" 2>/dev/null; rm -rf "$MU_HOME"; }
trap cleanup EXIT
ELECTRON=node_modules/.bin/electron
MU_SMOKE_PHASE=first $ELECTRON test/smoke.mjs
[ -S "$MU_HOME/mu.sock" ] || { echo "daemon did not outlive the app"; exit 1; }
MU_SMOKE_PHASE=reopen $ELECTRON test/smoke.mjs
