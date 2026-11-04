#!/bin/sh
# Two app processes against one daemon, which must outlive the first. Cleans up the daemon afterwards.
set -e
cd "$(dirname "$0")/.."
unset ANTHROPIC_API_KEY ANTHROPIC_OAUTH_TOKEN OPENAI_API_KEY
export MU_HOME="$(mktemp -d)" MU_MODEL=faux MU_HEADLESS=1
# A recorded agent that asks the user something, then uses the answer: offered as the model "replay/replay".
export MU_REPLAY="$MU_HOME/ask.jsonl" MU_REPLAY_SPEED=0
cat > "$MU_REPLAY" <<'TURNS'
{"at":0,"provider":"x","model":"x","message":{"role":"assistant","content":[{"type":"toolCall","id":"ask-1","name":"ask_user","arguments":{"question":"Which colour?","options":["red","blue"]}}],"stopReason":"toolUse"}}
{"at":0,"provider":"x","model":"x","message":{"role":"assistant","content":[{"type":"text","text":"Blue it is."}],"stopReason":"stop"}}
TURNS
cleanup() {
  for pid in "$MU_HOME/daemon.pid" "$MU_HOME/second/daemon.pid"; do [ -f "$pid" ] && kill "$(cat "$pid")" 2>/dev/null; done
  rm -rf "$MU_HOME" out/main/zz-smoke-restart.js
}
trap cleanup EXIT
ELECTRON=node_modules/.bin/electron
MU_SMOKE_PHASE=first $ELECTRON test/smoke.mjs
[ -S "$MU_HOME/mu.sock" ] || { echo "daemon did not outlive the app"; exit 1; }
MU_SMOKE_PHASE=reopen $ELECTRON test/smoke.mjs
