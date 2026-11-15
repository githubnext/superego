#!/bin/sh
# The window's layout in the states the design covers, screenshotted: `test/look.sh <dir> [focus|panes|composer|web]`;
# `focus`: each region holding the focus; `panes`: a thread's panes scrolled and stacked; `composer`: the composer and
# what's around it; `web`: Settings → Web access,
# pairing and devices and each Tailscale state (a stub `tailscale` on PATH: the machine's own is never touched).
set -e
cd "$(dirname "$0")/.."
# A heavy check: it waits for a slot (../scripts/check.ts), is stopped after 8 minutes (SUPEREGO_SHOWCASE_TIMEOUT, in
# seconds), and builds the app first if its sources changed.
[ "$SUPEREGO_CHECK_COMMAND" = test/look.sh ] || exec node ../scripts/check.ts --timeout SUPEREGO_SHOWCASE_TIMEOUT=480 test/look.sh "$@"
node scripts/build.ts
OUT="$(cd "$(dirname "${1:?usage: look.sh <dir>}")" && pwd)/$(basename "$1")"
mkdir -p "$OUT"
unset ANTHROPIC_API_KEY ANTHROPIC_OAUTH_TOKEN OPENAI_API_KEY
export SUPEREGO_HOME="$(mktemp -d)" SUPEREGO_HEADLESS=1 SUPEREGO_SHOWCASE_OUT="$OUT" SUPEREGO_REPLAY_SPEED=0 TZ=Europe/Copenhagen
export SUPEREGO_SHOWCASE_PROJECT="$SUPEREGO_HOME/ledger"
node test/showcase/setup.mjs "$SUPEREGO_SHOWCASE_PROJECT" "$SUPEREGO_HOME/turns.jsonl"
(cd "$SUPEREGO_SHOWCASE_PROJECT" && git init -q && git add -A && git -c user.name=x -c user.email=x@x commit -qm init)
export SUPEREGO_MODEL="replay:$SUPEREGO_HOME/turns.jsonl"
# Skills of its own (shown in the Skills data view), not this machine's ~/.agents.
export SUPEREGO_AGENTS="$SUPEREGO_HOME/agents"
for skill in commit:'Write commit messages in the house style.' release:'Cut a release and write its notes.' review:'Review a change for bugs and missing tests.'; do
  mkdir -p "$SUPEREGO_AGENTS/skills/${skill%%:*}"
  printf -- '---\nname: %s\ndescription: %s\n---\n\nDo it.\n' "${skill%%:*}" "${skill#*:}" > "$SUPEREGO_AGENTS/skills/${skill%%:*}/SKILL.md"
done
if [ "$2" = web ]; then
  mkdir -p "$SUPEREGO_HOME/bin"
  cp test/showcase/tailscale.sh "$SUPEREGO_HOME/bin/tailscale"
  chmod +x "$SUPEREGO_HOME/bin/tailscale"
  # Only the stub: no folder with a real one stays on PATH (web.mjs takes the stub away to show "not installed").
  export PATH="$SUPEREGO_HOME/bin:$(printf %s "$PATH" | tr ':' '\n' | while read -r d; do [ -e "$d/tailscale" ] || printf '%s:' "$d"; done)"
fi
. test/run-app.sh
cleanup() {
  stop_started
  rm -rf "$SUPEREGO_HOME"
}
trap cleanup EXIT
run_app node_modules/.bin/electron "test/${2:-look}.mjs"
