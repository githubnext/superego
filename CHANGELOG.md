# Changelog

## Unreleased

- If you added Superego to an iPhone's home screen, remove it and add it again, so its top bar is drawn under the
  status bar.
- The image viewer behaves like the other dialogs: the window behind it can't be scrolled or reached with a screen
  reader while it's open.
- **Upgrade:** the extension API is now 5.0. A profile's extension that asks for `api: '^4'` (or `^4.x`) is refused
  until it asks for `^5`. A composer completion provider's `items(word, where)` gets `where.cwd`, and `where.thread` only
  once there is a thread: in the New thread dialog there isn't one yet.
- The New thread dialog asks in the order you decide: the machine, then a folder on it, then the profile, model and
  thinking, then what to work on. Picking another machine offers that machine's folders.
- Its folder field lists every folder that machine's threads have worked in, archived ones' too, most recent first,
  and narrows as you type: ↑↓ and ⏎ pick one.
- Its prompt is the full composer: attach, paste or drop files, and complete skills (`$`, `/`) and mentions (`@`, a
  folder's files too) as in a thread. ⏎ starts the thread, as it sends in a thread; ⌘⏎ starts it from any field.
- Each of its fields has a key, shown beside its name: ⌃1 machine, ⌃2 folder, ⌃3 profile, ⌃4 model, ⌃5 thinking, ⌃6
  prompt, ⌃7 name. ⌃I goes to its prompt too, as it does in a thread.
- What you write there is kept if you close it without starting, and models or profiles that can't be listed say why.
- A thread opened in a pane beside another has less padding at its sides: its messages line up with the composer.
- `superego machines` no longer hangs on a machine that takes the connection but never answers: after 15 seconds it
  shows as "not answering (timed out connecting)" and the command finishes. `-m` on such a machine gives up after 30
  seconds, and closing a connection (in the app too) ends everything its command started.
- The title bar fits any window: short of room, its chips and buttons (the model, MCP servers, the profile, pin,
  archive, an extension's) move into a ··· menu at its end, the panes' tabs shrink to icons and then follow, and they
  come back as the window widens. Nothing in it overlaps or wraps any more.
- The thread's profile is a small badge right after its title; pointed at, it still shows the profile's card.
- The model in the title bar is its provider's mark (Anthropic, OpenAI and others). Pointed at, a card says the model,
  its provider, how hard it thinks, whose choice it is (the thread's, its profile's or this machine's) and what the
  thread has cost; a click still shows or hides thread details.
- The MCP chip is the plug and a count ("3"). A thread with none but some left out shows their count in the warning
  colour, and its tooltip says why.
- Pointing at a thread in the sidebar, or moving to it with the keyboard, shows a small card of it: its full title, its
  state and what it asks or did, project and machine, model, profile, branch, the thread that started it or how many
  it started, cost and when it was last active. The rail's dots show the same card.
- Extensions: a `header` view can say what its row in the title bar's ··· menu shows (`menuItem`).
- A profile's styles no longer leak into the rest of the window: with `superego.style(css)` they reach only what that
  profile draws, on its machine. The same profile from two machines at different versions, or two profiles with the
  same class names, no longer restyle each other's threads. A profile that appends a `<style>` to `document.head`
  still works, but styles the whole window: move it to `superego.style` (`api: '^4.2'`).
- On a phone, swipe right from a thread's left edge to pull out the sidebar, and swipe it left to put it away. It
  follows your finger and slides open or shut when you let go, smoothly both ways, and slides in and out when you tap ☰
  or beside it too.
- On a phone, the thread's sheet (from its title) slides up and follows your finger: swipe it down to put it away. While
  it's open the thread behind it can't be reached by accident, Escape closes a menu in it before the sheet, and closing
  it puts the focus back on the title.
- On a phone, text is 15% bigger throughout, on top of the Text size you pick in Settings → Appearance.
- The font pickers in Settings → Appearance work from the keyboard: the arrow keys move through the fonts, typing
  highlights the first match, Enter picks the highlighted one, and screen readers hear a list. Opening one scrolls to
  the current font, and long font lists scroll smoothly.
- Screen readers read out the row you move to in the command palette, Go to (⌘L) and the other pick lists (open a
  pane, unread threads, an extension's quick open).
- Sliders, in Settings and in an agent's UI, mark their stops on the track when stepped, and take a finger anywhere
  near them on a phone.
- Settings' sections move with the arrow keys, and an agent's choices with the arrow keys within them (Enter or Space
  picks).

### Fixes

- The sidebar's Archived list says why when a machine couldn't list its archived threads, rather than looking empty.
- On a phone, the page no longer zooms in when you tap into a field, so the New thread dialog fits the screen.
- On a phone, buttons and rows take one tap, not two: controls that showed on hover (the sidebar's +, ··· and fold
  carets) are always shown there.
- On a phone, the bar at the top is drawn cleanly under the status bar, its ☰ and + plain icons, and full-screen
  dialogs keep clear of the status bar and the home indicator.
- On iPhone and iPad, a link to a thread shows its status dot right before its title again, not spread across the line.
- On a phone or tablet, the keyboard no longer pops up over what you just opened: the New thread dialog, a thread,
  the palettes, a pane or a blank page leave their fields alone until you tap one. Used with a keyboard or trackpad,
  an iPad or a touchscreen laptop puts you in them as a computer does.
- On a phone or tablet, the focused pane no longer wears a blue ring while you tap; with a keyboard or trackpad it
  does.
- On an iPhone's home screen, the top of the page is no longer blurred under the status bar: the bar at the top now
  runs up under it in its own colour.
  still works, but styles the whole window: move it to `superego.style`.

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
