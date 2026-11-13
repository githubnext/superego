#!/bin/sh
# Scripted threads on a small project, screenshotted for looking at the transcript: `pnpm showcase <dir>`.
# Each thread at its top, middle and end, in light and dark. Cleans up its daemon afterwards.
set -e
cd "$(dirname "$0")/.."
# A heavy check: it waits for a slot (../scripts/check.ts), is stopped after 8 minutes (SUPEREGO_SHOWCASE_TIMEOUT, in
# seconds), and builds the app first if its sources changed.
[ "$SUPEREGO_CHECK_COMMAND" = test/showcase.sh ] || exec node ../scripts/check.ts --timeout SUPEREGO_SHOWCASE_TIMEOUT=480 test/showcase.sh "$@"
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
. test/run-app.sh
cleanup() {
  stop_started
  rm -rf "$SUPEREGO_HOME"
}
trap cleanup EXIT
run_app node_modules/.bin/electron test/showcase.mjs
