# Changelog

## Unreleased

- Claude Agent: when your login shell doesn't answer in time, it says so instead of that Claude Code isn't installed.
- Claude Agent finds Claude Code on the PATH Superego already read from your login shell, instead of starting the
  shell again for every look.
- Extensions can read your login shell's environment, its keys and PATH, with `superego.loginEnv()` (extension API
  5.11).
- With the sidebar folded, its panel's top lines up with the thread's beside it.
- The title bar's words, status, profile badge and buttons sit on one line, centred on the window's buttons.

## 0.4.0

- **Upgrade (extension authors):** extensions can greet new users on first-run setup with the `welcome` slot
  (extension API 5.10). A daemon older than 0.3.0 that still calls the sidebar `space` has its sidebar views left out:
  update it.

- `/clear` (or `/new`) starts over in a fresh thread with the same folder, profile and model; `/compact` summarizes
  the conversation to free its context. Both are in `⌘K` too, and `/` offers commands and skills together.
- First-run setup is a welcome again: after the model, a word on Ego and the extensions to switch on or off.
- A project's own profiles can add spaces to their project, listed under its heading and in the rail.
- Claude Agent (experimental) threads run in Auto permission mode by default; Settings → Claude Agent offers Allow all.
- Opened straight from Downloads, Superego offers to move itself to Applications, where it can update.
- On a phone, the thread list reads like Mail: one line when quiet, with the fold arrow at the end.
- In dark, the message box is flat, with a thin border instead of a shadow.
- Faster: archiving a thread with a worktree no longer stalls, and the Changes pane loads quicker.
- Fixes: a code block's scrollbar no longer shifts the layout, a compacted conversation shows as one folded row, and
  Settings opened during first-run setup stays open.

## 0.3.0

- **Upgrade (extension authors):** the place called `space` is now `sidebar`: `fits: ['sidebar']`,
  `default: 'sidebar'`, `withoutSidebar` and `SidebarRailProps`. In `~/.superego/layout.json`, `"space"` becomes
  `"sidebar"`.

- Global profiles (`global: true`): your own profiles can load with Superego and add sidebars to the rail and spaces,
  views that fill the main area (a notes page, a canvas) with a thread docked beside them.
- In dark, the message box is flat, with a thin border instead of a shadow.

## 0.2.0

- **Upgrade:** a machine still on an older Superego won't take anything only you may do (setting a secret, letting
  outside agents in) from your other machines' agents or extensions. Update it.
- **Upgrade (extension authors):** a `string` setting's `secret: true` is gone; use `type: { type: 'secret' }`. The
  onboarding slot's `use` takes `{ label, detail, model }` only. The CSS tokens `--superego-composer`,
  `--superego-rail-bg` and `--superego-rail-tab` are gone: use `--superego-glass` and `--superego-chrome`.

- A new macOS look: an inset glass sidebar, the thread and panes as rounded sheets, a soft accent ring on the one
  you're in, and softer controls and menus.
- Match window to theme (Settings → Appearance): the whole window in your theme's colours.
- Settings has Appearance and Hotkeys tabs.
- Improved model setup: every provider right in setup, paste any API key and it knows whose it is, recommended
  models by default, and clear errors. Sign-in codes are easy to copy, and closing a sign-in stops it.
- Claude Code (experimental) can be the default for new threads, and New thread says when it's signed out.
- Secrets: extensions can ask for keys and tokens, which you set in Settings or with `superego secrets set`, kept in
  the system keychain.
- Each thread remembers its column and pane widths. Widths from 0.1.10 aren't carried over.
- Safer: agents and extensions on your other machines can't do what only you may do, and agents can't add a machine
  that runs a command.
- On a phone: an iOS look, with glass buttons, sheets you swipe down to close, Settings as a list, and swipe actions
  and search in the thread list; dialogs stay above the keyboard, menus fit the screen, and wide tables scroll.
- Fixes: the dark editor's current line, Settings in narrow windows, panes restored as you left them, a maximized
  Browser pane you can click in, GitHub Copilot sign-in, and API keys kept out of the action log.

## 0.1.10

- **Upgrade:** `AGENTS.md` and project profiles are read only from the thread's project (up to its repository's top).
  Move one from above it, like `~/dev/AGENTS.md`, into `~/.agents/AGENTS.md` or the repository.
- **Upgrade:** a profile's modules can import only `'superego'`, Node's built-ins and files by path. Import packages
  and `#` aliases by their file path instead.
- **Upgrade:** Web access over Tailscale needs Tailscale 1.94 or later, and each new device now waits for your approval
  in Settings → Web access. On Linux, Settings shows a `sudo tailscale serve …` command to run once.

- Improved onboarding: setting up a model on first run, and whenever a message can't be sent for lack of one.
- API keys are tested before they're saved, and keys exported in `~/.zshrc` are found.
- Safer by default: pages agents draw can't reach the network or send for you, web images and pages agents open wait
  for a click, and allowing a profile covers every file it loads.
- Claude Agent (experimental): threads that run on your own Claude Code. Pick it in ⌘N's model menu; it asks before
  acting, has Superego's tools, and asks before loading a folder's Claude Code settings or `CLAUDE.md`. Set it up in
  Settings → Claude Agent.
- On a phone: no more zooming, the composer stays on the keyboard, and the thread's sheet is a simple menu.
- New theme: Zenbones, light and dark.
- Image files open as pictures in the editor pane.
- New models: GPT-6.2 Astra and Sol, and newer Qwen models. Dropped connections are retried.
- Electron 45.3.2, with its security fixes.

## 0.1.9

- Themes for code and the terminal, one for light and one for dark (Settings → Appearance): GitHub, One, Tokyo Night,
  Catppuccin, Solarized, Rosé Pine and Gruvbox, each with a preview. They colour code in the editor, messages and
  rendered files, diffs, the terminal, and the accent unless you chose your own. Import a VS Code theme, or a Ghostty
  or iTerm2 colour file, with Import theme…; extensions and profiles can bring themes too.
- The window uses far less CPU while an image loads in a thread (a shimmer that redrew the whole window every frame
  now costs next to nothing, and images far off the screen no longer shimmer while they wait), and while a Browser pane
  is open beside threads that are working.
- The app updates itself: it looks for a new release at launch and every few hours, downloads it in the background,
  and shows "Superego 0.1.9 is ready" with Restart in the sidebar's rail. Restarting stops this computer's daemon
  first (asking while agents work; they pick up again after). Quitting installs it too, and the daemon restarts onto it
  once its agents are idle. Check for Updates… is in the app menu and in Settings → About, which shows the version.
  This release is the last one you install by hand.
- Every model provider pi-ai supports is offered, not just Anthropic and OpenAI: Google, Vertex AI, Amazon Bedrock,
  Azure, Mistral, xAI, Groq, Cerebras, Together, Fireworks, OpenRouter, Vercel AI Gateway, Hugging Face, DeepSeek, Kimi,
  Z.ai and more, each with an API key (or its environment variable, an AWS profile, gcloud credentials). GitHub Copilot
  and OpenRouter can be signed in to from the browser, as ChatGPT can.
- Settings → Providers lists the ones you're signed in to first, then a search field and the rest, a line each.
- Add a provider of your own: any OpenAI-compatible endpoint (Ollama, LM Studio, vLLM, a company proxy), with its base
  URL, an optional key, and its models, listed from the endpoint or typed in. Edit or remove it later, or from the
  command line: `superego providers add --name … --base-url … [--key -]`.
- Favourite models: star a model in the New thread dialog's model menu (or press ⌘D on it), and the model menus list
  your favourites first. Reorder them by dragging in Settings → Favourite models. `superego models` lists the models, and
  `superego models favourite <provider/model>` stars one.
- The New thread dialog's model menu can be searched, and lists the models by provider.
- The editor opens and saves files outside the thread's folder (a whole path, or `~/…`), showing where the file
  is in its bar. Links to such files in a thread open them too, as do folder panes and images. A file that can't be
  opened says why: not there, a folder, a binary file, or no permission.
- Scrolled panes now pass beside the thread, which stays in view at the left. The pin next to the layout switch (or
  “Keep thread in view” in ⌘K) lets the thread scroll away with them again. A Browser pane's page passes under the
  thread too, rather than over it: while partly under, it shows as a still picture until it's back beside the thread.
- Select element in the Browser pane (⌘⇧C, or the cursor button in its toolbar): hover the page to outline an element,
  ↑ to its parent, click to pick it. A card shows its selector, tag, text and an image of it, to copy the selector or
  add it to your prompt as a chip; the agent gets the page's address, the selector, its HTML, its box and styles, and
  the image. Pick as many as you like. Desktop app only: a browser (Web access) can't reach into another site's page.
- Claude Agent (experimental): a profile with `agent: 'claude-agent'` runs its threads on your own Claude Code,
  signed in with its own `/login`: answers stream in, its tool calls show as rows, Stop interrupts it. Superego never
  sees your Claude sign-in, and keeps Anthropic API keys in its environment away from it.
- Settings → Machines is calmer: each machine is one line with its name and host, Update shows only when a machine is
  behind (with how far), and Settings, Connect and Remove are in the row's ··· menu, with the machine's route. A daemon
  that stops at logout gets an Install service button that runs `superego daemon install` there for you, and a
  machine's allowed profile UIs are one line that opens to the list to revoke.
- The Browser pane can show its page at a phone's, tablet's or laptop's width, or one you type in (`1024` or
  `1024×768`), from a size menu in its toolbar: the page sees that width, scaled down when the pane is narrower. Each
  pane keeps its own size.
- Superego no longer uses a Claude subscription token as an Anthropic key: one entered in Settings or with
  `superego providers key` is refused with what to use instead (an API key; Max, Team and Ultra plans include API
  credits), one already stored stops the provider until it's replaced, and `ANTHROPIC_OAUTH_TOKEN` is ignored.
- A suggestion over the composer can run one of your skills when it fits the next step, such as `$commit` after a
  change: it shows the skill's sparkle and name, with what the skill is for on hover.
- Suggestions over the composer stay on one row: more than fit scroll sideways (with a trackpad, the mouse wheel, or ←/→ picking one), fading at the edge where there's more.
- A folder opened from a link in a thread shows what's really in it on the thread's machine, git-ignored and
  untracked files too, read a folder at a time as you open them. One that can't be read says why, instead of "No files
  here.". The file tree beside the editor and ⌘P still leave out what git ignores.
- A middle click on a pane's tab in the title bar closes the pane.
- A notification stays in Notification Center until you clear it, and clicking it there later still opens its thread.
- The Browser pane shows a page loading: a thin line under its address bar that fills as it loads, a spinner on its
  tab and in the address, and Stop in place of Reload (Esc in the address bar stops it too). Quick loads show nothing.
- An agent's question and the box to answer it in are one card again, with no gap between its choices and the box.
- A save to `layout.json` made just after you changed the layout in the window is no longer sometimes undone.

## 0.1.8

- **Upgrade:** the extension API is now 5.0. A profile's extension that asks for `api: '^4'` (or `^4.x`) is refused
  until it asks for `^5`. A composer completion provider's `items(word, where)` gets `where.cwd`, and `where.thread` only
  once there is a thread: in the New thread dialog there isn't one yet.
- If you added Superego to an iPhone's home screen, remove it and add it again, so its top bar is drawn under the
  status bar.
- The image viewer behaves like the other dialogs: the window behind it can't be scrolled or reached with a screen
  reader while it's open.
- ⌘⇧↩ maximizes the thread too: with the focus in its transcript or prompt, it takes the whole width over its panes,
  until ⌘⇧↩ again, Esc, or a pane taking the focus.
- Drag a pane's tab in the title bar to move the pane: the others slide aside, the columns follow, and the order is
  kept with the thread. Esc puts it back. ⌘⌥⇧← and ⌘⌥⇧→ move the focused pane too.
- ⌃T (Focus threads list) puts the keyboard in the sidebar's threads, on the selected thread, showing the sidebar if
  it's hidden; ⌃T again goes back to the prompt. A terminal keeps ⌃T for its shell.
- In a file editor, ⌃D, ⌃O and ⌃T only do what the app binds them to, no longer editing the text as well.
- The window uses far less CPU while threads work: the working spinners no longer make it redraw the whole page every
  frame, which cost up to a third of a core at rest, and all of one with a long thread open.
- Long threads scroll smoothly and stream new answers without slowing the window: a folded run of steps is drawn once
  you open it, and what's already there isn't drawn again for every word that comes in.
- An open terminal no longer keeps the window busy while nothing happens in it, and a closed one no longer holds on to
  its memory.
- The New thread dialog asks in the order you decide: the machine, then a folder on it, then the profile, model and
  thinking, then what to work on. Picking another machine offers that machine's folders.
- Its folder field lists every folder that machine's threads have worked in, archived ones' too, most recent first,
  and narrows as you type: ↑↓ and ⏎ pick one.
- Its prompt is the full composer: attach, paste or drop files, and complete skills (`$`, `/`) and mentions (`@`, a
  folder's files too) as in a thread. ⏎ starts the thread, as it sends in a thread; ⌘⏎ starts it from any field.
- Each of its fields has a key, shown beside its name: ⌃1 machine, ⌃2 folder, ⌃3 profile, ⌃4 model, ⌃5 thinking, ⌃6
  prompt, ⌃7 name. ⌃I goes to its prompt too, as it does in a thread.
- What you write there is kept if you close it without starting, and models or profiles that can't be listed say why.
- The command palette, ⌘L, ⌘⇧P and the other pickers are lighter: tighter rows, the lit one grey as in the sidebar, no
  chevrons, and no focus ring cut off at the dialog's corners. ⌘K groups the thread's commands and the views to show
  under headings until you type.
- ⌘L can list archived threads too: ⌥A (or its Archived chip) adds them, muted, after the rest; picking one opens it.
  Its foot has chips for ⌃P, ⌃T and ⌃G as well.
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
- A path in a message's code is a link only when that file or folder is there on the thread's machine, untracked and
  git-ignored files included, and it opens there. Anything else stays plain code. A file that's gone by the time you
  click is struck through and says why. A remote machine needs updating before its threads' paths become links.
- A "thread" pane shows threads on remote machines too (the Chief of Staff board's "open beside" on another machine),
  and ⌘-clicking a link to a thread on another machine opens it beside the one you're in.
- The thread list no longer goes stale after a change comes in mid-update, or after a failed attempt to follow a
  machine's threads: a pane you opened, say, now shows.
- A profile's styles no longer leak into the rest of the window: with `superego.style(css)` they reach only what that
  profile draws, on its machine. The same profile from two machines at different versions, or two profiles with the
  same class names, no longer restyle each other's threads. A profile that appends a `<style>` to `document.head`
  still works, but styles the whole window: move it to `superego.style`.
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

- The send button stays round when the composer is short of room, as do other icon buttons, instead of being squeezed.
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
