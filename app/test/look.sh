#!/bin/sh
# The window's layout in the states the design covers, screenshotted: `test/look.sh <dir> [focus|composer]`;
# `focus`: each region holding the focus; `composer`: the composer and what's around it.
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
. test/run-app.sh
cleanup() {
  stop_started
  rm -rf "$SUPEREGO_HOME"
}
trap cleanup EXIT
run_app node_modules/.bin/electron "test/${2:-look}.mjs"
