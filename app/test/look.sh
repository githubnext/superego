#!/bin/sh
# The window's layout in the states the design covers, screenshotted: `test/look.sh <dir>` (after electron-vite build).
set -e
cd "$(dirname "$0")/.."
OUT="$(cd "$(dirname "${1:?usage: look.sh <dir>}")" && pwd)/$(basename "$1")"
mkdir -p "$OUT"
unset ANTHROPIC_API_KEY ANTHROPIC_OAUTH_TOKEN OPENAI_API_KEY
export SUPEREGO_HOME="$(mktemp -d)" SUPEREGO_HEADLESS=1 SUPEREGO_SHOWCASE_OUT="$OUT" SUPEREGO_REPLAY_SPEED=0 TZ=Europe/Copenhagen
export SUPEREGO_SHOWCASE_PROJECT="$SUPEREGO_HOME/ledger"
node test/showcase/setup.mjs "$SUPEREGO_SHOWCASE_PROJECT" "$SUPEREGO_HOME/turns.jsonl"
(cd "$SUPEREGO_SHOWCASE_PROJECT" && git init -q && git add -A && git -c user.name=x -c user.email=x@x commit -qm init)
export SUPEREGO_MODEL="replay:$SUPEREGO_HOME/turns.jsonl"
cleanup() {
  for pid in $(cat "$SUPEREGO_HOME/daemon.pid" 2>/dev/null) $(lsof -t "$SUPEREGO_HOME"/*.sock 2>/dev/null); do kill "$pid" 2>/dev/null || true; done
  rm -rf "$SUPEREGO_HOME"
}
trap cleanup EXIT
node_modules/.bin/electron test/look.mjs
