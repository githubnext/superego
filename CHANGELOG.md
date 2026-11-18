# Changelog

## Unreleased

- The title bar fits any window: short of room, its chips and buttons (the model, MCP servers, the profile, pin,
  archive, an extension's) move into a ··· menu at its end, the panes' tabs shrink to icons and then follow, and they
  come back as the window widens. Nothing in it overlaps or wraps any more.
- The MCP chip says how many servers were left out when a thread has none ("2 left out"), not "0 servers".
- Pointing at a thread in the sidebar, or moving to it with the keyboard, shows a small card of it: its full title, its
  state and what it asks or did, project and machine, model, profile, branch, the thread that started it or how many
  it started, cost and when it was last active. The rail's dots show the same card.
- Extensions: a `header` view can say what its row in the title bar's ··· menu shows (`menuItem`).
- A profile's styles no longer leak into the rest of the window: with `superego.style(css)` they reach only what that
  profile draws, on its machine. The same profile from two machines at different versions, or two profiles with the
  same class names, no longer restyle each other's threads. A profile that appends a `<style>` to `document.head`
  still works, but styles the whole window: move it to `superego.style` (`api: '^4.2'`).

## 0.1.7

### Fixes

- Stopping a thread no longer loses the messages you'd queued: they come back into its composer, with their files.
  Messages another thread queued are withdrawn, and the thread says so.
- Allowing a remote machine's profile UI works again for profiles from a profile source.
- With panes stacked, the thread's tab stands apart from the stack's tabs.

## 0.1.6

**Upgrading:** the `preview` and `artifact` panes are now one, `browser`, with the same params (`{ url }` or
`{ path }`). Change a script or extension that opens the old kinds, and a profile going without `web-panes` to go
without `browser`. Sites start signed out, and ask again for what you'd allowed them.

### Browser

- Preview and Artifact are one Browser pane with an address bar: click it to type an address, a host like
  `localhost:5173`, an HTML file in the working folder, or a search. ⌘T, or Browser in the pane menu, opens a blank one.
  Settings → Browser picks the search engine.

### Profiles

- Install profiles from a git repo or a folder: `superego profile install git:github.com/<owner>/<repo>`, then
  `profile update`, `profile remove` and `profile sources`. Settings → Profiles says where each comes from.

### Web access

- Choose the host it's reached at (`web.host`), and on a machine running more than one tailscaled, which tailnet serves
  it (`web.tailscale.socket`).

### Fixes

- A profile linked somewhere new loads from there, instead of failing until the daemon restarts.
- A window reconnecting to a restarted daemon no longer misses what a profile's extensions bring.

## 0.1.5

**Upgrading:** extensions and profiles need `api: '^4'` (the extension API is now 4.0); one still on `'^3'` is refused
until it's changed. A tool view that shows `result.images` gets image references to show with `ImageFrame` (or read
with `image.read`), not base64.

### Images

- Threads with big images open fast: images show as thumbnails made on their machine as you scroll to them, and only
  the thumbnail crosses to a remote machine. The lightbox loads the full image.
- A very tall image, like a full-page screenshot, shows its top with Open to see it whole.
- Images keep their place while they load, and an image you sent opens in the lightbox.

### Preview

- Pages can ask for the camera, the microphone, notifications, or to reach apps on your Mac (as Okta FastPass does):
  Preview asks you under its toolbar and remembers your answer per site. Settings → Site permissions lists them.
- A proper browser toolbar: back, forward and reload as icon buttons, the address in a quiet pill, and a button to open
  the page in your browser.

### Panes

- A pane's tab is set apart by a faint tint instead of a line, with a soft shadow when content scrolls under it.

## 0.1.4

**Upgrading:** CSS in a profile or extension that draws its own status dots with `--superego-status-dot` needs
changing: that variable is gone. Use `superego/ui`'s `Glyph` or `StatusGlyph` instead (`api: '^3.1'`).

### Thread states

- Threads read like an inbox: an unread title is bold with a mark before it, and the row names what's wanted in a
  word: Question, Permission, Sign in or Failed. The same words appear in the title bar, ⌘U, the menu bar,
  `superego threads` and `superego unread`, and notifications.
- A working thread has a spinner before its title, and all spinners turn in step (still under reduced motion).
- Every state has its own shape, so none is told apart by colour alone.
- A thread working quietly for another shows a small grey spinner, and nothing new once it's done.
- An offline machine's threads show at half strength; Settings no longer marks the machine as failed.

### Sidebar

- Pin a thread from its right-click menu, the title bar or ⌘K: it sits under Pinned at the top, across projects and
  machines, and at the top of its own project. Drag to reorder. Hide Pinned from the sidebar's ··· menu.
- Collapse Pinned, a project, or a thread's sub-threads from the caret beside it (or ← and →). A collapsed group says
  how many it holds and whether any needs you.
- Sort the sidebar alphabetically.

### Finding threads

- ⌘U lists the unread threads, what needs you first, with each one's question or recap. The bell opens the same list.
- Type `@` in the composer to mention another thread or a file: the agent is told what it is and how to read it.

### Preview

- Preview shows a page as your browser does: sign-in, redirects and cookies work, and pages that refuse to be framed
  load. It has back, forward and reload, and shows where the page is now. Artifacts show the same way.
- Focusing a Preview or Artifact pane no longer puts you in the page: press Return, or click into it.

### Fixes

- An image too big for the model (a long pasted screenshot, a large photo) no longer breaks its thread: it's sent
  scaled down, and one the model still refuses is left out, with a note. Threads stuck on such an image work again
  from their next message.
- Preview and Artifact panes keep their page when you switch threads, open Settings or rearrange panes, and an
  artifact reloads when its file changes.
- Suggestions over the composer no longer turn see-through on hover.

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
