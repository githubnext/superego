#!/bin/bash
# A provider's OAuth flow, as the built daemon loads it: refreshing an expired sign-in. pi loads each flow with an
# import() the bundler can't follow, so a build that leaves one out fails only here, when it's first needed (a ChatGPT
# sign-in renewed, an hour in). An expired ChatGPT sign-in without the client id it was issued is refused by the flow
# itself, before it asks OpenAI anything: that refusal, and not "Cannot find module", says the flow loaded. Run by
# smoke.sh; on its own, build first (`node scripts/build.ts`), or name a packaged app: `test/oauth.sh <Superego.app>`.
set -e
cd "$(dirname "$0")/.."
if [ -n "$1" ]; then
  APP=$(cd "$1" && pwd -P)
  ELECTRON="$APP/Contents/MacOS/Superego" OUT="$APP/Contents/Resources/app.asar/out/main"
else
  ELECTRON=$(node -p "require('electron')" | tail -1) OUT=$(pwd -P)/out/main
fi
HOME_DIR=$(mktemp -d /tmp/sg-oauth.XXXXXX)
HOME_DIR=$(cd "$HOME_DIR" && pwd -P)
sg() { env -i HOME="$HOME_DIR" PATH=/usr/bin:/bin TMPDIR="$HOME_DIR" SUPEREGO_HOME="$HOME_DIR" ELECTRON_RUN_AS_NODE=1 "$ELECTRON" "$OUT/cli.js" "$@"; }
cleanup() {
  sg daemon stop >/dev/null 2>&1 || true
  rm -rf "$HOME_DIR"
}
trap cleanup EXIT
printf '{"openai":{"type":"oauth","access":"expired","refresh":"expired","expires":0}}\n' > "$HOME_DIR/auth.json"
chmod 600 "$HOME_DIR/auth.json"
mkdir -p "$HOME_DIR/work"
thread=$(cd "$HOME_DIR/work" && sg start -p hi </dev/null)
out=$(sg read "$thread" --wait 2>&1 </dev/null) || true
if ! echo "$out" | grep -q 'does not contain an issued client ID'; then
  echo "oauth: the built daemon didn't refresh a ChatGPT sign-in through its OAuth flow:"
  echo "$out"
  exit 1
fi
echo "oauth: the built daemon loads the ChatGPT OAuth flow to refresh a sign-in"
