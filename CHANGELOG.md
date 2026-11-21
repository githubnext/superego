# Changelog

## Unreleased

- **Upgrade:** Web access over Tailscale needs Tailscale 1.94 or later on the machine that serves it (Settings → Web
  access says so when it's older). Where Tailscale lets only an administrator set it up (Linux, unless you may run
  `sudo tailscale` without a password), Settings → Web access shows a `sudo tailscale serve …` command to run once. It
  no longer lets in every device logged in to Tailscale as you, such as the
  machines your agents run on. The first time one of your devices opens the page, it waits in Settings → Web access
  (or `superego web devices`) until you approve it from the app or a device that's already in; pairing with a code
  still works. The "Require pairing for my Tailscale login too" setting is gone.
- **Upgrade:** `AGENTS.md` files and a project's profiles (`.superego/profiles`) are read only from the thread's
  project: its folder up to the repository's top, or the folder alone outside a repository. One above that (say
  `~/dev/AGENTS.md`) no longer applies: move it into `~/.agents/AGENTS.md` or the repository. Nor is one read that
  another user on the computer could have written (in `/tmp`, or a folder writable by others).
- **Upgrade:** a profile's modules can import only `'superego'`, Node's built-ins and files by their paths. One that
  imports a package by name or a `#` alias no longer loads, and says why: import the file by its path instead.
- A first run starts with a model: **Who does the thinking?** shows what's already on the computer (an API key in your
  shell, Ollama or LM Studio running, Claude Code signed in) and the other ways in (ChatGPT, GitHub Copilot or
  OpenRouter sign-in, an API key, a local server), then the default model, a few favourites and a "Say hi" to prove it
  works, then your first thread. It replaces the welcome page and its extension switches (they stay in Settings), and
  opens again from Settings → Providers or ⌘K (**Set up models…**), for this computer or another machine.
- A message that can't be sent for lack of a model says so with **Set up models…**, and comes back to the thread once
  one works. ⌘N no longer leaves an empty thread behind when it can't start one.
- An API key is tried before it's kept: a wrong one says so right away, instead of at the first message.
- API keys exported in your shell's startup files (`~/.zshrc`) are found when Superego is opened from the Dock.
- Choosing Claude Code in setup makes a `claude` profile whose threads run on it.
- Allowing a project's profile now covers everything it can load: a change to any file it runs asks to allow it again.
- A page an agent draws (an `html` block) can't reach the network (no fetching, nothing loaded from the web, no
  navigating away), and no longer answers or messages for you by itself: what it would say shows under it, and goes
  only when you press Send there.
- Images on the web in a thread (in a message, a rendered file, an image an agent shows or a block it draws) load
  only when you click them: until then they say where they're from. One click loads the rest in the same message.
- A web page an agent opens in a Browser pane waits for you to press Open page, showing its whole address, unless it's a
  dev server on this computer or its network.
- Claude Agent threads no longer load a folder's own Claude Code settings (`.claude/`, `.mcp.json`), whose hooks and
  MCP servers can run commands, until you allow them: the thread asks over its composer, listing the files, and asks
  again after they change. Until then Claude Code runs with your settings only, without the folder's `CLAUDE.md`.
  Where another user on the computer could change those settings, there's nothing to allow.
- Claude Agent threads ask before following a folder's `CLAUDE.md` too (and `CLAUDE.local.md`, and the files they
  import), even in a folder with no other Claude Code settings: until now such a folder's `CLAUDE.md` was silently
  left out. A change to any of them asks again.
- Another user account on the same computer can no longer pass as you through Web access over Tailscale.
- A malformed request to Web access, or to a sign-in page's callback, no longer stops the daemon and every agent with
  it.
- An HTML artifact is served only files really in its thread's folder (a symlink leading outside is refused), and in a
  browser its address works only for the device that opened it (over Tailscale) or briefly after its page last used it
  (on this computer), so a page that sends its address elsewhere doesn't give the folder away.
- The public website now uses GitHub Next analytics to track visits.
- On an iPhone, text in the app is one size again: Safari no longer enlarges some rows (a wave's title on the board, a
  long line) and not others.
- On a phone, the page no longer zooms or scrolls as a whole, and the composer stays in view, right on top of the keyboard.
- On a phone, the thread's sheet (tap its title) is a plain menu: a row each for its model and other details, Rename
  (the title at its top becomes a field), Pin, Archive or Unarchive, and the panes to open beside it, each with its
  icon, sized for a finger.
- An image file opens as the picture in the editor pane (from a link in a message, the file tree or `pane_open`), fitted to the pane with its size in pixels, instead of "is a binary file". SVG still opens as its source.
- A new built-in theme: Zenbones, light and dark (Settings → Appearance).
- Importing a Ghostty theme reads its quoted colours (`foreground = "#2c363c"`), where its foreground, background, cursor and selection were left out.
- Claude Agent finds your `claude` when your shell has it as an alias (such as `claude --dangerously-skip-permissions`): it runs the `claude` on your shell's PATH, without the alias's flags.
- Claude Agent threads ask before Claude Code does something your Claude Code settings don't allow: the thread
  shows "Permission" (in the sidebar, the menu bar, notifications and on your phone), with Allow, Deny and, when
  Claude Code offers it, "Always allow …" above the message box (⌃1–⌃3; type to deny and say what to do instead).
  What you always allow is remembered for that folder, without changing its own Claude Code settings. Its questions
  come as question cards, and a plan comes with Approve plan or Keep planning. A profile picks how much it asks with
  `claudeAgent: { permissionMode }` (`default`, `acceptEdits`, `plan`, `auto`; `bypassPermissions` only when the
  profile says so), and can narrow `settingSources`, `allowedTools` and `disallowedTools`.
- Claude Agent threads have Superego's tools: they start threads of their own (whose reports come back), open panes
  beside themselves, ask you things, show UI and images, and report their work as tasks, as other threads do. A
  profile's instructions are added to Claude Code's own prompt.
- A Claude Agent subagent's steps show under its call, while it runs too.
- Claude Agent threads have Superego's skill, and the `superego` command works from their Bash as that thread: what
  it starts or sends comes from the thread. Nothing is added to your `~/.claude`.
- Claude Agent finds your `claude` when your shell has it as an alias (such as
  `claude --dangerously-skip-permissions`): it runs the `claude` on your shell's PATH, without the alias's flags.
- A Claude Agent turn cut off by Superego restarting says so ("Interrupted: send again") instead of running again.
- An image file opens as the picture in the editor pane (from a link in a message, the file tree or `pane_open`),
  fitted to the pane with its size in pixels, instead of "is a binary file". SVG still opens as its source.
- A new built-in theme: Zenbones, light and dark (Settings → Appearance).
- Importing a Ghostty theme reads its quoted colours (`foreground = "#2c363c"`), where its foreground, background,
  cursor and selection were left out.
- The public website now uses GitHub Next analytics to track visits.
- Electron 45.3.2 (Chromium 156.0.8078.100), with its security fixes.

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
