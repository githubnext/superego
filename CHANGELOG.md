# Changelog

## Unreleased

- Upgrade: CSS in a profile or extension that draws its own status dots with `--superego-status-dot` needs changing:
  that variable is gone. Draw them with 'superego/ui''s `Glyph` or `StatusGlyph` instead (`api: '^3.1'`).
- Threads read like a mail inbox: an unread title is bold, with a mark before it, and the row says what's wanted in a
  word: Question, Permission, Sign in or Failed. A working thread has a spinner before its title, and every spinner
  turns in step, so many at once move as one (still with reduced motion). The words are the same in the title bar, ⌘U, the menu bar, `superego threads` and
  `superego unread`, and notifications ("Release notes — Permission").
- Each state has its own shape, so none is told apart by colour alone, in the highlighted row of ⌘U and ⌘L too.
- A thread working for another (quiet) shows a smaller grey spinner while it works, and nothing new once it's done: the
  unread count already left it out. A collapsed thread sums up what's under it: a spinner while any works, then what
  needs you, or how many are new.
- A machine that's offline shows its threads at half strength, their spinners still; Settings no longer marks it as failed.
- Collapse parts of the sidebar: Pinned, a project, or the threads another thread started, from the caret beside its
  name (or ← and →). Collapsed, it shows how many threads it holds and whether any needs you. ⌘⌥↑ and ⌘⌥↓ skip what's
  collapsed, and going to a thread inside opens the way to it. ⌘K has Collapse all threads and Expand all threads.
- Suggestions over the composer no longer turn see-through on hover: the transcript stays hidden behind them.
- Sort the sidebar alphabetically (from its ··· menu or ⌘K): projects by name, threads by title, "Wave 2" before
  "Wave 10".
- Hide the sidebar's Pinned section from its ··· menu (Show pinned). Pinned threads stay pinned, at the top of their
  projects.
- Preview shows a page as your browser does, not framed in the window: signing in, redirects to another port or site,
  and cookies work there, and pages that refuse to be framed load. It has back and forward (also ⌘[ and ⌘]), ⌘R
  reloads the page, and the header shows where the page is now. Links that open a new window open in your browser;
  downloads go to Downloads. Artifacts show the same way. In a browser (Web access) pages are still framed, and the
  pane says what that can't do.
- ⌘U lists the unread threads, what needs you first, with each one's question or recap: type a few letters and
  press Enter to go there. The bell opens the same list. Change its key in Settings → Keyboard.
- Type `@` to mention another thread (on any machine) or a file in the thread's folder: pick it from the list, and the
  agent is told what it is and how to read it. In the sent message, a mentioned thread shows by its title and opens on
  a click; a file opens beside the thread.
- Pin a thread to keep it at the top of the sidebar, under Pinned, whichever project or machine it's on, and at the
  top of its own project: from its row's right-click menu, the pin in the title bar, or "Pin thread" in ⌘K. Drag
  pinned threads to reorder them, or drag a thread among them to pin it there. Pins are the same in every window; an
  archived thread leaves them.
- With the sidebar hidden, the rail's dots and the navigator (⌘L) list pinned threads first.

## 0.1.3

### Fixes

- Signing in with ChatGPT works in the app again, and so does renewing the sign-in: threads no longer fail with
  "OAuth refresh failed for openai: Cannot find module …openai-chatgpt.js".
- The pane menu in the title bar highlights its items under the mouse and from the keyboard again.

### Panes

- ⌘⇧P opens a pane beside the thread: pick one of the pane menu's by typing a few letters. Change its key in
  Settings → Keyboard.
- Changes can show what's uncommitted, what's staged, everything since the branch left main, or since its upstream:
  pick it in the pane's header. A thread on a branch opens on "Since main".

### Machines

- A thread on a remote machine knows when your window is on another computer: it no longer hands you a `localhost`
  address that only works over there, or takes a `curl` on the machine as proof it works for you.
- Preview shows a remote machine's `localhost` pages: the app forwards the port to this computer, at the same port when
  it's free, so your browser here can open it too.
- A remote machine can run a release instead of main: `scripts/install-machine.sh --release` installs the release's app
  on a Mac (no checkout needed), or checks out the release's tag on Linux. Updating such a machine moves it to the
  newest release.

## 0.1.2

**Upgrading:** extensions now need `api: '^3'`. A profile's own extensions that still ask for `^2` won't load until
their `about` is updated.

### Agents and Ego

- Agents can no longer give your consent for you. Allowing an MCP server command, a project profile or web access only
  works from the window, or from your own terminal.
- Ego hears back from the threads it starts and tells you what was actually built and how to try it.
- Ego waits for an MCP server to be running before saying it works, and asks before using a server in every thread.
- Agents can draw lists: rows with a status, a thread link and buttons.

### Building extensions

- `superego extension new` has starters for a tool (`--tool`), a pane (`--ui`) and a sidebar mark (`--badge`).
- Extensions' views are drawn from the same blocks agents use, with inputs and buttons that run the extension's own
  actions.
- The guide is split into topics that agents can read whole, with a new topic on the thread tools.
- `superego/testing` gives a thread the profile under test, and can read a thread's facts and tool calls.

### Fixes

- The window says when it runs a newer build than the app, and offers a restart.
- `superego read --wait` waits on the daemon instead of polling.

## 0.1.1

### New & Improved

- Notifications and the app icon's unread count are built into the app, with one unread list behind the rail, the
  bell, ⌘. and `superego unread`.
- ask_user and the agents' UI tools share one queue of questions above the composer.
- Failed tool calls show the error, not the raw wrapper around it.
- Pane kinds like Preview and Artifact are known before any window connects.

### Fixes

- Agents can't pass an outside agent's request on to Ego to change your setup.
- The desktop notifies you of what happened while a machine was away.
- Reloading a window no longer leaks its watches or loses a notification click.
- Closing the daemon waits for everything it was saving.

## 0.1.0

The first test build: Superego runs agent threads in projects on this Mac and on machines you reach over ssh, with
panes beside each thread, worktrees for parallel work, MCP servers, notifications, multiple windows (⌘⇧N), a resizable
sidebar, Ego to set things up, and extensions and profiles to make it yours.
