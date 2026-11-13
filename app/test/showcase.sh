#!/bin/sh
# Scripted threads on a small project, screenshotted for looking at the transcript: `pnpm showcase <dir>`.
# Each thread at its top, middle and end, in light and dark. Cleans up its daemon afterwards.
set -e
cd "$(dirname "$0")/.."
# A heavy check: it waits for a slot (../scripts/check.ts), then builds the app if its sources changed.
[ -n "$SUPEREGO_CHECK_SLOT" ] || exec node ../scripts/check.ts test/showcase.sh "$@"
node scripts/build.ts
OUT="$(cd "$(dirname "${1:?usage: showcase.sh <dir>}")" && pwd)/$(basename "$1")"
mkdir -p "$OUT"
unset ANTHROPIC_API_KEY ANTHROPIC_OAUTH_TOKEN OPENAI_API_KEY
export SUPEREGO_HOME="$(mktemp -d)" SUPEREGO_HEADLESS=1 SUPEREGO_SHOWCASE_OUT="$OUT" SUPEREGO_REPLAY_SPEED=0
# East of UTC, so the date bug in the fixture shows (local midnight is the previous day in UTC).
export TZ=Europe/Copenhagen
export SUPEREGO_SHOWCASE_PROJECT="$SUPEREGO_HOME/ledger"
node test/showcase/setup.mjs "$SUPEREGO_SHOWCASE_PROJECT" "$SUPEREGO_HOME/turns.jsonl"
export SUPEREGO_MODEL="replay:$SUPEREGO_HOME/turns.jsonl"
cleanup() {
  for pid in $(cat "$SUPEREGO_HOME/daemon.pid" 2>/dev/null) $(lsof -t "$SUPEREGO_HOME"/*.sock 2>/dev/null); do kill "$pid" 2>/dev/null || true; done
  rm -rf "$SUPEREGO_HOME"
}
trap cleanup EXIT
node_modules/.bin/electron test/showcase.mjs
