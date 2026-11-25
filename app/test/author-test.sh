#!/bin/bash
# `superego extension new` and `superego extension test`, as an author has them in the packaged app: the build (out/)
# copied out of the repo and run on Electron as Node from a folder of its own, with a fresh data folder and an
# environment that names nothing of this checkout, for each shape `new` makes: a tool, a pane, a sidebar mark, and a tool
# with a pane (in the user's profile: a project's needs the daemon, which is the same in or out of the repo). The types
# check and each one's tests pass as made, with only what the app carries. Run by smoke.sh; on its own, build first (`node scripts/build.ts`).
set -e
cd "$(dirname "$0")/.."
ELECTRON=$(node -p "require('electron')" | tail -1)
STAGE=$(mktemp -d /tmp/sg-author.XXXXXX)
STAGE=$(cd "$STAGE" && pwd -P)
HOME_DIR="$STAGE/home"
WORK="$STAGE/work"
cleanup() {
  sg daemon stop >/dev/null 2>&1 || true
  rm -rf "$STAGE"
}
trap cleanup EXIT
# What the command line uses of the build; cloned where the file system can (APFS), else copied.
mkdir -p "$STAGE/app/out" "$HOME_DIR" "$WORK"
for part in main node_modules skill types; do cp -cR "out/$part" "$STAGE/app/out/" 2>/dev/null || cp -R "out/$part" "$STAGE/app/out/"; done
cd "$WORK"
git init -q
# The app's command line, as the script Settings → Command line installs runs it.
sg() { env -i HOME="$HOME_DIR" PATH=/usr/bin:/bin TMPDIR="$STAGE" SUPEREGO_HOME="$HOME_DIR" ELECTRON_RUN_AS_NODE=1 "$ELECTRON" "$STAGE/app/out/main/cli.js" "$@"; }
# Each shape, by its flags: name and flags, one per line.
SHAPES='words
peek --ui
failed --badge
todos --tool --ui'
echo "$SHAPES" | while read -r name flags; do
  # shellcheck disable=SC2086
  sg extension new "$name" $flags --user >/dev/null </dev/null
done
echo "$SHAPES" | while read -r name flags; do
  if ! out=$(sg extension test "$name" --user 2>&1 </dev/null); then
    echo "superego extension new $name $flags: its test failed outside the repo:"
    echo "$out"
    exit 1
  fi
  echo "$out" | grep -q ' passed' || { echo "superego extension test $name ran no tests:"; echo "$out"; exit 1; }
done
echo "author-test: extension new and test pass outside the repo, in each shape (tool, pane, badge, tool with a pane)"
