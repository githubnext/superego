#!/bin/sh
# `superego extension new` and `superego extension test`, as an author has them in the packaged app: the build (out/)
# copied out of the repo and run on Electron as Node from a folder of its own, with a fresh data folder and an
# environment that names nothing of this checkout, for an extension that is data-only and one with a UI half (in the
# user's profile: a project's needs the daemon, which is the same in or out of the repo). The types check and the tests
# pass with only what the app carries. Run by smoke.sh; on its own, build first (`node scripts/build.ts`).
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
sg extension new notes --user >/dev/null
sg extension new board --ui --user >/dev/null
# The UI half's view drawn as a pane, and a slot, by the test window.
BOARD=$(dirname "$(find "$HOME_DIR" -path '*/board/ui.tsx')")
cat > "$BOARD/pane.test.tsx" <<'TEST'
import { afterEach, expect, it } from 'vitest'
import { defineUiExtension, type SlotProps } from 'superego/ui'
import { fakeMachine, mountUi, testThread, type TestWindow } from 'superego/testing'
import ui from './ui.tsx'
import { ITEMS } from './shared.ts'

const ref = { scope: 'user' as const, name: 'default', dir: '/profiles/default' }
const badge = defineUiExtension({ name: 'badge', setup(superego) {
  superego.slot('thread.badge', ({ thread }: SlotProps['thread.badge']) => <span className="thread-badge">{thread.title}</span>)
} })
let shown: TestWindow | undefined
afterEach(async () => { await shown?.unmount() })

it('draws the items as a pane, and a badge for a thread', async () => {
  const thread = testThread({ id: 't1', profile: ref })
  const machine = fakeMachine({ extensions: ['board'], threads: [thread], values: { [ITEMS]: { t1: [{ id: '1', text: 'first' }] } } })
  shown = await mountUi({ extensions: [badge], machines: [machine], profile: { ref, extensions: [ui] } })
  expect((await shown.render({ pane: { kind: 'board.list' }, thread: 't1' })).text()).toContain('first')
  expect((await shown.render({ slot: 'thread.badge', thread: testThread({ title: 'Mine' }) })).text()).toBe('Mine')
})
TEST
for name in notes board; do
  if ! out=$(sg extension test "$name" --user 2>&1); then
    echo "superego extension test $name failed outside the repo:"
    echo "$out"
    exit 1
  fi
  echo "$out" | grep -q ' passed' || { echo "superego extension test $name ran no tests:"; echo "$out"; exit 1; }
  [ "$name" = notes ] || echo "$out" | grep -q 'pane.test.tsx' || { echo "superego extension test board ran no pane test:"; echo "$out"; exit 1; }
done
echo "author-test: extension new and test pass outside the repo (data-only and with a UI half)"
