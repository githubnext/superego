#!/bin/sh
# Two app processes against one daemon, which must outlive the first. Cleans up the daemon afterwards.
set -e
cd "$(dirname "$0")/.."
unset ANTHROPIC_API_KEY ANTHROPIC_OAUTH_TOKEN OPENAI_API_KEY
export MU_HOME="$(mktemp -d)" MU_MODEL=faux MU_HEADLESS=1
# A recorded agent that asks the user something, then uses the answer: offered as the model "replay/replay".
export MU_REPLAY="$MU_HOME/ask.jsonl" MU_REPLAY_SPEED=0
# A user profile: every thread here starts with it, loaded by the daemon on Electron's own Node.
mkdir -p "$MU_HOME/profiles/default/ui"
cat > "$MU_HOME/profiles/default/profile.ts" <<'PROFILE'
import { defineProfile } from 'mu'
export default defineProfile({ description: 'smoke', prompt: 'Be brief.', ui: ['./ui/badge.ts'] })
PROFILE
# Its UI, loaded by the window at runtime: a badge in the header of its threads.
cat > "$MU_HOME/profiles/default/ui/badge.ts" <<'UI'
import { defineUiExtension, h } from 'mu/ui'
import { label } from './label.ts'
export default defineUiExtension({
  name: 'badge',
  setup(mu) { mu.slot('thread.header', ({ thread }) => h('span', { className: 'smoke-badge' }, `${label}: ${thread.title}`)) },
})
UI
printf "export const label: string = 'profile ui'\n" > "$MU_HOME/profiles/default/ui/label.ts"

cat > "$MU_REPLAY" <<'TURNS'
{"at":0,"provider":"x","model":"x","message":{"role":"assistant","content":[{"type":"toolCall","id":"ask-1","name":"ask_user","arguments":{"question":"Which colour?","options":["red","blue"]}}],"stopReason":"toolUse"}}
{"at":0,"provider":"x","model":"x","message":{"role":"assistant","content":[{"type":"text","text":"Blue it is."}],"stopReason":"stop"}}
TURNS
cleanup() {
  # The daemons by their pid files, and anything still holding their sockets.
  for pid in $(cat "$MU_HOME/daemon.pid" "$MU_HOME/second/daemon.pid" 2>/dev/null) $(lsof -t "$MU_HOME"/*.sock "$MU_HOME"/second/*.sock 2>/dev/null); do kill "$pid" 2>/dev/null || true; done
  rm -rf "$MU_HOME" out/main/zz-smoke-restart.js
}
trap cleanup EXIT
ELECTRON=node_modules/.bin/electron
MU_SMOKE_PHASE=first $ELECTRON test/smoke.mjs
kill -0 "$(cat "$MU_HOME/daemon.pid" 2>/dev/null)" 2>/dev/null || { echo "daemon did not outlive the app"; exit 1; }
MU_SMOKE_PHASE=reopen $ELECTRON test/smoke.mjs
