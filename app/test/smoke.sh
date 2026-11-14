#!/bin/sh
# Two app processes against one daemon, which must outlive the first. Cleans up the daemon afterwards.
set -e
cd "$(dirname "$0")/.."
# A heavy check: it waits for a slot (../scripts/check.ts), is stopped after 8 minutes (SUPEREGO_SMOKE_TIMEOUT, in
# seconds), and builds the app first if its sources changed.
[ "$SUPEREGO_CHECK_COMMAND" = test/smoke.sh ] || exec node ../scripts/check.ts --timeout SUPEREGO_SMOKE_TIMEOUT=480 test/smoke.sh "$@"
node scripts/build.ts
unset ANTHROPIC_API_KEY ANTHROPIC_OAUTH_TOKEN OPENAI_API_KEY
export SUPEREGO_HOME="$(mktemp -d)" SUPEREGO_MODEL=faux SUPEREGO_HEADLESS=1
# A recorded agent that asks the user something, then uses the answer: offered as the model "replay/replay".
export SUPEREGO_REPLAY="$SUPEREGO_HOME/ask.jsonl" SUPEREGO_REPLAY_SPEED=0
# Skills from a folder of the test's own, not this machine's ~/.agents.
export SUPEREGO_AGENTS="$SUPEREGO_HOME/agents"
mkdir -p "$SUPEREGO_AGENTS/skills/smoke-skill"
printf -- '---\nname: smoke-skill\ndescription: Checks the smoke.\n---\n\nSay smoke.\n' > "$SUPEREGO_AGENTS/skills/smoke-skill/SKILL.md"
# A user profile: every thread here starts with it, loaded by the daemon on Electron's own Node.
mkdir -p "$SUPEREGO_HOME/profiles/default/ui"
cat > "$SUPEREGO_HOME/profiles/default/profile.ts" <<'PROFILE'
import { defineProfile } from 'superego'
export default defineProfile({ description: 'smoke', prompt: 'Be brief.', ui: ['./ui/badge.ts'] })
PROFILE
# Its UI, loaded by the window at runtime: a badge in the header of its threads.
cat > "$SUPEREGO_HOME/profiles/default/ui/badge.ts" <<'UI'
import { defineUiExtension, h } from 'superego/ui'
import { label } from './label.ts'
export default defineUiExtension({
  name: 'badge',
  setup(superego) {
    superego.view('badge.label', { title: 'Badge', context: 'thread', fits: ['header'], default: 'header',
      component: ({ thread }) => h('span', { className: 'smoke-badge' }, `${label}: ${thread.title}`) })
    // One that throws as it draws until the smoke says otherwise: it shows that it failed, in its own place, and the
    // rest of the window carries on.
    superego.view('badge.crash', { title: 'Crash', context: 'thread', fits: ['header'], default: 'header', component: () => {
      if (!globalThis.__smokeFixed) throw new Error('smoke crash')
      return h('span', { className: 'smoke-fixed' }, 'fixed')
    } })
  },
})
UI
printf "export const label: string = 'profile ui'\n" > "$SUPEREGO_HOME/profiles/default/ui/label.ts"
# The second machine's own default profile, with UI too: it runs in this window only once allowed here.
mkdir -p "$SUPEREGO_HOME/second/profiles/default/ui"
cat > "$SUPEREGO_HOME/second/profiles/default/profile.ts" <<'PROFILE'
import { defineProfile } from 'superego'
export default defineProfile({ description: 'remote', ui: ['./ui/badge.ts'] })
PROFILE
cat > "$SUPEREGO_HOME/second/profiles/default/ui/badge.ts" <<'UI'
import { defineUiExtension, h } from 'superego/ui'
import { label } from './label.ts'
export default defineUiExtension({
  name: 'remote-badge',
  setup(superego) { superego.view('remote-badge.label', { title: 'Remote badge', context: 'thread', fits: ['header'], default: 'header', component: () => h('span', { className: 'remote-badge' }, label) }) },
})
UI
printf "export const label: string = 'remote ui'\n" > "$SUPEREGO_HOME/second/profiles/default/ui/label.ts"

cat > "$SUPEREGO_REPLAY" <<'TURNS'
{"at":0,"provider":"x","model":"x","message":{"role":"assistant","content":[{"type":"toolCall","id":"ask-1","name":"ask_user","arguments":{"question":"Which colour?","options":["red","blue"]}}],"stopReason":"toolUse"}}
{"at":0,"provider":"x","model":"x","message":{"role":"assistant","content":[{"type":"text","text":"Blue it is."}],"stopReason":"stop"}}
{"at":0,"provider":"x","model":"x","message":{"role":"assistant","content":[{"type":"text","text":"Noted for later."}],"stopReason":"stop"}}
TURNS
# Then an agent showing images (made by smoke.mjs): one alone, three in a grid (one gone by the time it's looked at),
# and six in a carousel. Then its answer, with images inline: by a path relative to its folder (the shots), by an
# absolute one in it, and one outside it.
S="$SUPEREGO_HOME/shots"
cat >> "$SUPEREGO_REPLAY" <<TURNS
{"at":0,"provider":"x","model":"x","message":{"role":"assistant","content":[{"type":"toolCall","id":"img-1","name":"show_images","arguments":{"images":[{"path":"$S/wide.png","caption":"The home page, at full width"}]}},{"type":"toolCall","id":"img-2","name":"show_images","arguments":{"title":"Before and after","images":[{"path":"$S/a.png","caption":"Before"},{"path":"$S/b.png","caption":"After"},{"path":"$S/gone.png","caption":"Gone"}]}},{"type":"toolCall","id":"img-3","name":"show_images","arguments":{"images":[{"path":"$S/1.png","caption":"First"},{"path":"$S/2.png","caption":"Second"},{"path":"$S/3.png","caption":"Third"},{"path":"$S/4.png"},{"path":"$S/5.png"},{"path":"$S/6.png","caption":"Last"}]}}],"stopReason":"toolUse"}}
{"at":0,"provider":"x","model":"x","message":{"role":"assistant","content":[{"type":"text","text":"Those are the screens.\\n\\n![The wide one](wide.png)\\n\\n![Before](file:$S/a.png) and ![Before, by its whole path]($S/a.png)\\n\\n![Elsewhere](/etc/elsewhere.png)"}],"stopReason":"stop"}}
TURNS
. test/run-app.sh
cleanup() {
  stop_started
  rm -rf "$SUPEREGO_HOME" out/main/zz-smoke-restart.js
}
trap cleanup EXIT
ELECTRON=node_modules/.bin/electron
run_app env SUPEREGO_SMOKE_PHASE=first $ELECTRON test/smoke.mjs
kill -0 "$(cat "$SUPEREGO_HOME/daemon.pid" 2>/dev/null)" 2>/dev/null || { echo "daemon did not outlive the app"; exit 1; }
run_app env SUPEREGO_SMOKE_PHASE=reopen $ELECTRON test/smoke.mjs
