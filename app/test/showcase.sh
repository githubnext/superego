#!/bin/sh
# Scripted threads on a small project, screenshotted for looking at the transcript: `pnpm showcase <dir>`.
# Each thread at its top, middle and end, in light and dark. Cleans up its daemon afterwards.
set -e
cd "$(dirname "$0")/.."
OUT="$(cd "$(dirname "${1:?usage: showcase.sh <dir>}")" && pwd)/$(basename "$1")"
mkdir -p "$OUT"
unset ANTHROPIC_API_KEY ANTHROPIC_OAUTH_TOKEN OPENAI_API_KEY
export MU_HOME="$(mktemp -d)" MU_HEADLESS=1 MU_SHOWCASE_OUT="$OUT" MU_REPLAY_SPEED=0
# East of UTC, so the date bug in the fixture shows (local midnight is the previous day in UTC).
export TZ=Europe/Copenhagen
export MU_SHOWCASE_PROJECT="$MU_HOME/ledger"
node test/showcase/setup.mjs "$MU_SHOWCASE_PROJECT" "$MU_HOME/turns.jsonl"
export MU_MODEL="replay:$MU_HOME/turns.jsonl"
cleanup() {
  for pid in $(cat "$MU_HOME/daemon.pid" 2>/dev/null) $(lsof -t "$MU_HOME"/*.sock 2>/dev/null); do kill "$pid" 2>/dev/null || true; done
  rm -rf "$MU_HOME"
}
trap cleanup EXIT
node_modules/.bin/electron test/showcase.mjs
