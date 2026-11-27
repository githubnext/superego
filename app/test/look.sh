#!/bin/bash
# The window's layout in the states the design covers, screenshotted:
# `test/look.sh <dir> [look|focus|focus-mode|panes|panehead|composer|images|mcp|web|terminal|toolbar|titlebar|titlebar-fit|pins|folds|states|cards|dialogs|machines|staff|picker|providers|keptpage|themes|theme-ui|mac-look|claude-agent|setup|phone-look|header|files|github|schedules|processes]` (look, unless given), each a script of
# that name here:
# - `look`: the sidebar shown, dragged and hidden, the thread alone and with panes, details, a phone; ⌘N's dialog, Settings' General, Appearance and Hotkeys (a clash too);
# - `focus`: each region holding the focus;
# - `focus-mode`: focus mode: threads in focus marked, a row's menu, the sidebar heading's ◎ and its menu, the list
#   narrowed, for an hour, and a phone's drawer; light and dark;
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
# - `machines`: the sidebar with three machines' projects, each named in its colour; Settings → Machines with two other
#   machines, one behind and needing a service, wide and narrow, a row's menu and its colour's swatches.
# - `staff`: a lead on the chief-of-staff profile at work, its children, its board and its question (the public site's
#   hero).
# - `picker`: Select element in the Browser pane: the page in pick mode, the element picked in its card, its chip in the composer.
# - `keptpage`: an editor and a Browser pane's page scrolled partly under the thread kept in view (a still of it, under the thread),
#   beside it (the page itself, with the focus), maximized, and in front of a stack: the page an inset, rounded sheet in
#   its column.
# - `providers`: Settings → Providers (signed in, added, searched, the add form), Favourite models, ⌘N's model menu.
# - `setup`: first-run setup on a fresh home with no model: what it finds (a stand-in Ollama and `claude`), a key's
#   field, a composer's card when sending failed, a model saying hi, Claude Code used.
# - `claude-agent`: a Claude Agent thread waiting on a permission, its model card, the plan's limit noted, a thread
#   waiting for Claude Code to be signed in, Settings → Claude Agent, and ⌘N's model menu with its group (needs `claude`
#   installed; nothing is signed in or spent).
# - `themes`: code in a message, the editor and the terminal under Superego's theme and four built-in pairs, light and
#   dark, and Settings → Appearance's theme pickers.
# - `theme-ui`: the whole window (sidebar, a thread with a task's tool calls and a code block, the Diff pane, the
#   composer) under Superego's own and every built-in theme, as <theme-id>.png.
# - `mac-look`: the window's macOS look, light and dark: the sidebar open, folded (a narrow window too) and full screen,
#   a menu, and Settings (a narrow window too).
# - `phone-look`: the web build on an iPhone (402×874 at 3×, a finger, its safe areas), paired by Web access: the drawer (a row swiped open),
#   its search (empty, with matches, with none), a thread, the keyboard up, the thread's menu, New thread, a pane, Settings.
# - `header`: threads in three projects, one building a page with the page in a Browser pane beside it (the README's
#   header and the site's link preview: ../site/shots.sh).
# - `processes`: a thread woken by its build failing (the report, the chip, the row's mark), the Processes pane on the
#   build's output and on a process gone with a restart of the machine, the chip's menu, and a phone's sheet and pane.
# - `files`: a folder pane's New file: the name typed in place, a taken one refused there, the file made open in the
#   editor, light and dark.
# - `github`: threads' pull requests in every state, from a stand-in `gh` on PATH (the machine's own never runs): the
#   title bar's chip and its menu, a row and its card, the pull-request pane, a PR link in a message, Settings → GitHub;
#   light and dark.
# - `schedules`: a thread's schedules: the agent's `schedule` row with its next times, the clock chip and its popover, the
#   sidebar's clock, a firing, a run that went late while Superego wasn't running, and the phone's sheet; light and dark.
set -e
cd "$(dirname "$0")/.."
# A heavy check: it waits for a slot (../scripts/check.ts), is stopped after 8 minutes (SUPEREGO_SHOWCASE_TIMEOUT, in
# seconds), and builds the app first if its sources changed.
[ "$SUPEREGO_CHECK_COMMAND" = test/look.sh ] || exec node ../scripts/check.ts --timeout SUPEREGO_SHOWCASE_TIMEOUT=480 test/look.sh "$@"
node scripts/build.ts
OUT="$(cd "$(dirname "${1:?usage: look.sh <dir> [look|focus|focus-mode|panes|panehead|composer|images|mcp|web|terminal|toolbar|titlebar|titlebar-fit|pins|folds|states|cards|dialogs|machines|staff|picker|keptpage|themes|theme-ui|mac-look|claude-agent|setup|phone-look|header|files|github|schedules|processes]}")" && pwd)/$(basename "$1")"
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
  # Its sign-in, as Settings tells it, a plan's (it's the stand-in's API key that really answers); signed out while
  # $SUPEREGO_HOME/claude-signed-out is there. What $SUPEREGO_HOME/claude-inject holds goes out after Claude Code's next
  # `system:init` (the plan's limits, which Claude Code reports only on a plan's sign-in).
  cat > "$SUPEREGO_HOME/bin/claude" <<EOF
#!/bin/bash
if [ -f "$SUPEREGO_HOME/claude-signed-out" ]; then
  [ "\$1 \$2" = "auth status" ] && { echo '{"loggedIn":false,"authMethod":"none"}'; exit 0; }
  exec env ANTHROPIC_BASE_URL="\$(cat "$SUPEREGO_HOME/claude-mock-url")" CLAUDE_CONFIG_DIR="$SUPEREGO_HOME/claude-config" CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 "$CLAUDE" "\$@"
fi
[ "\$1 \$2" = "auth status" ] && { echo '{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"max"}'; exit 0; }
env ANTHROPIC_BASE_URL="\$(cat "$SUPEREGO_HOME/claude-mock-url")" ANTHROPIC_API_KEY=sk-ant-api03-look CLAUDE_CONFIG_DIR="$SUPEREGO_HOME/claude-config" CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 "$CLAUDE" "\$@" | "$(command -v node)" "$PWD/../extensions/claude-agent/test/inject.mjs" "$SUPEREGO_HOME/claude-inject"
EOF
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
# `processes`: the project's scripts, a process an earlier daemon left (lost as this one starts), the thread's turns;
# zsh without the user's own startup files, so what a process prints is the scene's.
if [ "$2" = processes ]; then
  node test/showcase/processes-setup.mjs "$SUPEREGO_HOME" "$SUPEREGO_SHOWCASE_PROJECT" "$SUPEREGO_HOME/processes-turns.jsonl"
  export SUPEREGO_MODEL="replay:$SUPEREGO_HOME/processes-turns.jsonl"
  mkdir -p "$SUPEREGO_HOME/zdot"
  [ -x /bin/zsh ] && export SHELL=/bin/zsh ZDOTDIR="$SUPEREGO_HOME/zdot"
fi
# `header`: its scene's turns.
if [ "$2" = header ]; then
  node test/showcase/header.mjs "$SUPEREGO_HOME/header-turns.jsonl"
  export SUPEREGO_MODEL="replay:$SUPEREGO_HOME/header-turns.jsonl"
fi
# `github`: a stand-in gh, first and alone on PATH (no folder with a real one stays; run-app.sh keeps the login shell's
# PATH out), its world, and the scene's turns.
if [ "$2" = github ]; then
  node test/showcase/github-setup.mjs "$SUPEREGO_HOME" "$SUPEREGO_HOME/github-turns.jsonl"
  export SUPEREGO_MODEL="replay:$SUPEREGO_HOME/github-turns.jsonl"
  export PATH="$SUPEREGO_HOME/gh/bin:$(printf %s "$PATH" | tr ':' '\n' | while read -r d; do [ -e "$d/gh" ] || printf '%s:' "$d"; done)"
fi
# `schedules`: its scene's turns.
if [ "$2" = schedules ]; then
  node test/showcase/schedules-setup.mjs "$SUPEREGO_HOME/schedules-turns.jsonl"
  export SUPEREGO_MODEL="replay:$SUPEREGO_HOME/schedules-turns.jsonl"
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
