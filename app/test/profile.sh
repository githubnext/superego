#!/bin/bash
# Profiles the window's renderer, CPU and memory, with a scripted model in an isolated app (a temp SUPEREGO_HOME):
# `test/profile.sh <dir> [idle|streaming|transcript|memory …]` (all four, unless given), writing <dir>/report.md and
# <dir>/report.json, the CPU profiles and the heap snapshots' summaries. See test/profile.mjs for what each measures.
#
# The window is shown, but see-through and passing clicks through (PROFILE_OPACITY=1 to see it): a window that's never
# shown, as the other tests' headless ones are, draws no frames, so its animations and frame-driven work cost nothing.
# PROFILE_MINUTES sets the memory scenario's length (12), PROFILE_SCALE the other phases' (1; 0.1 for a quick look),
# PROFILE_LONG_MESSAGES the long transcript's (12 messages, each answered after 150 tool calls); PROFILE_KEEP_SNAPSHOTS=1
# keeps the heap snapshots (test/profile/retainers.mjs says what holds on to something in one).
set -e
cd "$(dirname "$0")/.."
# A heavy check: it waits for a slot (../scripts/check.ts), and is stopped after an hour (SUPEREGO_PROFILE_TIMEOUT, in
# seconds).
[ "$SUPEREGO_CHECK_COMMAND" = test/profile.sh ] || exec node ../scripts/check.ts --timeout SUPEREGO_PROFILE_TIMEOUT=3600 test/profile.sh "$@"
# A build of its own (out-profile), the renderer's names kept: the profiles name functions and components.
node_modules/.bin/electron-vite build -c test/profile/vite.config.ts --outDir "$PWD/out-profile" --logLevel error
OUT="$(cd "$(dirname "${1:?usage: profile.sh <dir> [idle|streaming|transcript|memory …]}")" && pwd)/$(basename "$1")"
shift
mkdir -p "$OUT"
unset ANTHROPIC_API_KEY ANTHROPIC_OAUTH_TOKEN OPENAI_API_KEY ELECTRON_RUN_AS_NODE ELECTRON_RENDERER_URL SUPEREGO_THREAD
export SUPEREGO_HOME="$(mktemp -d)" SUPEREGO_HEADLESS=1 SUPEREGO_PROFILE_OUT="$OUT" SUPEREGO_PROFILE_SCENARIOS="$*"
# The scripted model's pace: about a real one's.
export SUPEREGO_REPLAY_SPEED="${PROFILE_TOKENS_PER_SECOND:-150}" SUPEREGO_MODEL="replay:$SUPEREGO_HOME/turns.jsonl"
export SUPEREGO_PROFILE_PROJECT="$SUPEREGO_HOME/project" SUPEREGO_AGENTS="$SUPEREGO_HOME/agents" XDG_RUNTIME_DIR="$SUPEREGO_HOME/run"
mkdir -p "$SUPEREGO_AGENTS"
node test/profile/setup.mjs "$SUPEREGO_PROFILE_PROJECT" "$SUPEREGO_HOME/turns.jsonl"
(cd "$SUPEREGO_PROFILE_PROJECT" && git init -q && git add -A && git -c user.name=x -c user.email=x@x commit -qm init)
. test/run-app.sh
cleanup() {
  stop_started
  rm -rf "$SUPEREGO_HOME"
}
trap cleanup EXIT
run_app node_modules/.bin/electron test/profile.mjs
