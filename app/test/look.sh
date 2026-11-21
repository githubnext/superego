#!/bin/sh
# The window's layout in the states the design covers, screenshotted:
# `test/look.sh <dir> [look|focus|panes|panehead|composer|images|mcp|web|terminal|toolbar|titlebar|titlebar-fit|pins|folds|states|cards|dialogs|machines|staff|picker|providers|keptpage|themes|claude-agent|setup]` (look, unless given), each a script of
# that name here:
# - `look`: the sidebar shown, dragged and hidden, the thread alone and with panes, details, a phone; ⌘N's dialog, Settings and its Keyboard;
# - `focus`: each region holding the focus;
# - `panes`: a thread's panes scrolled and stacked;
# - `panehead`: panes' heads (a tab, an editor's bar, the Browser pane's toolbar) at rest and with what's under them scrolled;
# - `composer`: the composer and what's around it;
# - `images`: an agent's images in a thread, the lightbox, a message's own images, on a phone too;
# - `mcp`: Settings → MCP servers, a thread's MCP calls, its chip and details;
# - `web`: Settings → Web access, pairing and devices and each Tailscale state (a stub `tailscale` on PATH: the machine's
#   own is never touched);
# - `terminal`: the terminal pane, reloaded, and in a browser;
# - `toolbar`: the Browser pane's toolbar, a web page's and an HTML file's, with and without history, with its hint;
# - `titlebar`: the title bar, a profile's card, the sidebar's heading;
# - `titlebar-fit`: the title bar from 700 to 1800 wide with few to many things in it, checked for overlaps and wraps,
#   its ··· menu, and a contact sheet;
# - `pins`: pinned threads at the top of the sidebar, a row's menu, the rail's dots.
# - `folds`: the sidebar with a project and a thread's offshoots folded.
# - `states`: every thread state in the sidebar, the rail, the title bar and ⌘U.
# - `cards`: a thread's card, pointed at in the sidebar (in a worktree, waiting on you, folded) and in the rail.
# - `dialogs`: the palette, ⌘L (archived threads too), the pane picker and ⌘N's fields.
# - `machines`: Settings → Machines with two other machines, one behind and needing a service, wide and narrow, and a
#   row's menu.
# - `staff`: a lead on the chief-of-staff profile at work, its children, its board and its question (the public site's
#   hero).
# - `picker`: Select element in the Browser pane: the page in pick mode, the element picked in its card, its chip in the composer.
# - `keptpage`: a Browser pane's page scrolled partly under the thread kept in view (a still of it, under the thread), and
#   beside it (the page itself).
# - `providers`: Settings → Providers (signed in, added, searched, the add form), Favourite models, ⌘N's model menu.
# - `setup`: first-run setup on a fresh home with no model: what it finds (a stand-in Ollama and `claude`), a key's
#   field, a composer's card when sending failed, a model saying hi, Claude Code used.
# - `claude-agent`: a Claude Agent thread waiting on a permission (needs `claude` installed; nothing is signed in or spent).
# - `themes`: code in a message, the editor and the terminal under Superego's theme and four built-in pairs, light and
#   dark, and Settings → Appearance's theme pickers.
set -e
cd "$(dirname "$0")/.."
# A heavy check: it waits for a slot (../scripts/check.ts), is stopped after 8 minutes (SUPEREGO_SHOWCASE_TIMEOUT, in
# seconds), and builds the app first if its sources changed.
[ "$SUPEREGO_CHECK_COMMAND" = test/look.sh ] || exec node ../scripts/check.ts --timeout SUPEREGO_SHOWCASE_TIMEOUT=480 test/look.sh "$@"
node scripts/build.ts
OUT="$(cd "$(dirname "${1:?usage: look.sh <dir> [look|focus|panes|panehead|composer|images|mcp|web|terminal|toolbar|titlebar|titlebar-fit|pins|folds|states|cards|dialogs|machines|staff|picker|keptpage|themes|claude-agent|setup]}")" && pwd)/$(basename "$1")"
mkdir -p "$OUT"
unset ANTHROPIC_API_KEY ANTHROPIC_OAUTH_TOKEN OPENAI_API_KEY
export SUPEREGO_HOME="$(mktemp -d)" SUPEREGO_HEADLESS=1 SUPEREGO_SHOWCASE_OUT="$OUT" SUPEREGO_REPLAY_SPEED=0 TZ=Europe/Copenhagen
export SUPEREGO_SHOWCASE_PROJECT="$SUPEREGO_HOME/ledger"
node test/showcase/setup.mjs "$SUPEREGO_SHOWCASE_PROJECT" "$SUPEREGO_HOME/turns.jsonl"
(cd "$SUPEREGO_SHOWCASE_PROJECT" && git init -q && git add -A && git -c user.name=x -c user.email=x@x commit -qm init)
export SUPEREGO_MODEL="replay:$SUPEREGO_HOME/turns.jsonl"
# `mcp`: this machine's MCP servers in each state, one of them real, and a thread calling its tools.
if [ "$2" = mcp ]; then
  node test/showcase/mcp-setup.mjs "$SUPEREGO_HOME" "$SUPEREGO_HOME/mcp-turns.jsonl"
  export SUPEREGO_MODEL="replay:$SUPEREGO_HOME/mcp-turns.jsonl"
fi
# `themes`: an answer with code and a diff in it.
if [ "$2" = themes ]; then
  node test/showcase/themes-setup.mjs "$SUPEREGO_HOME/themes-turns.jsonl"
  export SUPEREGO_MODEL="replay:$SUPEREGO_HOME/themes-turns.jsonl"
fi
# `claude-agent`: a Claude Agent thread on this machine's own `claude` (a wrapper pointing it at the scene's stand-in
# for the Messages API, in a config folder of its own), with a profile that picks it.
if [ "$2" = claude-agent ]; then
  CLAUDE="$(command -v claude || true)"
  [ -n "$CLAUDE" ] || { echo "look.sh claude-agent: needs claude (Claude Code) installed" >&2; exit 1; }
  mkdir -p "$SUPEREGO_HOME/bin" "$SUPEREGO_HOME/profiles/claude"
  printf '#!/bin/sh\nexec env ANTHROPIC_BASE_URL="$(cat "%s/claude-mock-url")" ANTHROPIC_API_KEY=sk-ant-api03-look CLAUDE_CONFIG_DIR="%s/claude-config" CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 "%s" "$@"\n' "$SUPEREGO_HOME" "$SUPEREGO_HOME" "$CLAUDE" > "$SUPEREGO_HOME/bin/claude"
  chmod +x "$SUPEREGO_HOME/bin/claude"
  echo "export default { agent: 'claude-agent' }" > "$SUPEREGO_HOME/profiles/claude/profile.ts"
  export SUPEREGO_CLAUDE="$SUPEREGO_HOME/bin/claude"
fi
# `staff`: the chief-of-staff profile as one of this home's own (test/showcase/profiles), and its scene's turns.
if [ "$2" = staff ]; then
  cp -R test/showcase/profiles "$SUPEREGO_HOME/profiles"
  rm "$SUPEREGO_HOME/profiles/README.md"
  node test/showcase/staff.mjs "$SUPEREGO_HOME/staff-turns.jsonl"
  export SUPEREGO_MODEL="replay:$SUPEREGO_HOME/staff-turns.jsonl"
fi
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
