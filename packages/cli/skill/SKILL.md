---
name: superego
description: Use Superego from the command line and extend it. Use when starting, scripting or inspecting Superego threads with the `superego` command, writing or changing a Superego profile (profile.ts), or building extensions for it - agent tools and prompt sections, daemon actions and live values, UI panes, slots and tool renderers.
---

# Superego

Superego runs agents. A **daemon** on each machine keeps them running while the app is closed; the **app** (desktop,
browser or phone) and the **`superego` command** are its clients. A **profile** says what an agent is (model, prompt,
tools, UI): files in `~/.superego/profiles/<name>/` or a project's `.superego/profiles/<name>/`.

```text
machine   a daemon (this computer, or one reached over ssh)
└─ project  a git repository (and its worktrees) or a folder, on that machine
   └─ thread  one conversation with an agent, in the folder or a worktree of its own
      └─ pane   a view beside the thread: a diff, a file, a web page, a profile's own
```

Everything the app does is an **action** with an id (`thread.start`, `pane.open`, `vault.graph`), run alike by the
command line, the window, keys and extensions. `superego actions` lists a machine's.

## Quick reference

```sh
superego                          # start a thread here and open it in the app
superego start . -p "fix tests"   # start one without the app; prints its id
superego send <thread> "and the docs" && superego read <thread> --wait   # its answer, once it stops working
superego threads --json           # every thread, with its status
superego do thread.rename --thread <thread> --title "Fix the tests"
superego profile new [name]       # .superego/profiles/<name>/profile.ts, with types for an editor
superego daemon restart           # onto the installed code
```

## Start an extension with `extension new`

Scaffold one in the shape of the job and change it; don't start from a blank file.

```sh
superego extension new orders           # an agent tool, in this project's default profile (made if there's none)
superego extension new orders --ui      # a pane, UI half only (ui.tsx)
superego extension new orders --badge   # a sidebar mark: a daemon half sets a thread's fact, a UI half draws it
superego extension new orders --tool --ui   # an agent tool, and a pane of what it did
superego extension new orders --user    # in your own profile (~/.superego/profiles/default), for every folder
superego extension test orders          # check its types and run its tests
superego extension reload               # load the profile's changes now, and say why if it doesn't load
superego extensions                     # every extension here: where it's from, how it stands, what it registered
```

`new` writes `<profile>/orders/`: the smallest working extension of that shape, with `version`, `api`, a passing test
on `superego/testing` and a README, and gives the profile its types.

**No Node needed.** `superego extension test` is the type checker and test runner. Don't look for `node`, `npx`,
`tsc` or `bun`: plain Node can't import `superego`.

Then:

- **A thread keeps the profile it started with.** A profile made after a thread started never reaches it, yours or the
  user's open ones. Start a new thread to use it (`superego -p "…"`), and tell the user to.
- Edits reach the profile's threads on their next turn; `superego extension reload` loads them now.
- A project's profile runs only once the user allows it (`superego profile allow <name>`, or in the window), and again
  after any change. That's their consent: it's refused from your shell, so tell them.
  Your own (`~/.superego/profiles`) need no allowing.

## Topics

Read only what the task needs: `superego --skill <topic>`, or `<topic>.md` beside this file.

| Topic | For |
|---|---|
| `guide` | building an extension: the big picture, [one end to end](guide.md#a-first-extension-end-to-end), the build-queue examples (`examples/`), [testing](guide.md#testing) |
| `cheatsheet` | what either half can register, a line each |
| `tools` | giving an agent tools and prompt sections ([testing a tool](tools.md#testing-a-tool)) |
| `daemon` | a daemon half: actions, methods, live values, shortcuts, blocked status, reaching threads, [watching tool calls](daemon.md#watching-tool-calls) |
| `ui` | a UI half: panes, slots ([a sidebar mark](ui.md#a-mark-in-the-sidebar)), tool rows, [reading threads](ui.md#reading-threads) (a board) |
| `window` | placing views, spaces, [data-only views](window.md#data-only-views) (blocks, no UI code), links, window events |
| `lifecycle` | teardown, [a thread's hooks](lifecycle.md#a-threads-life) (`starting`, `archived`, …), versions |
| `profiles` | `profile.ts`: model, prompt, extensions, panes, allowing, `extends`, when changes apply |
| `thread-tools` | handing work to other threads; a lead profile |
| `cli` | the command: threads, actions, `superego mcp` for outside agents, machines, settings, the daemon |
| `bundled` | working on Superego itself: a bundled extension in `extensions/` |
| `debugging` | something doesn't load, run or show |

A profile with a tool needs `profiles` and `tools`; one with a pane, `profiles`, `daemon` and `ui`.

## Ground rules

- A profile imports only `'superego'` (and in UI, `'superego/ui'` and `'react'`), which the daemon and window provide.
  No other npm packages.
- Declarations for an editor and `extension test` are in `~/.superego/types/node_modules` (`superego`, `superego/ui`,
  `superego/testing`, React, Node, vitest), put there as the app starts; `profile new`, `extension new` and
  `profile types` link a profile's `node_modules` to them. To learn the API, read `node_modules/superego/index.d.ts`,
  `ui.d.ts` and `testing.d.ts`.
- Names are namespaced: an extension `vault` names its actions and live values `vault.<something>`.
- Another machine's profile UI runs in this window only once allowed here: `superego profile allow-ui <name> -m <machine>`.
- The window loads a profile's UI as soon as it lists one of its threads ([ui.md](ui.md#when-the-ui-loads)). A changed
  profile loads on the thread's next turn, its UI when a shown thread of it moves on.
