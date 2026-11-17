---
name: superego
description: Use Superego from the command line and extend it. Use when starting, scripting or inspecting Superego threads with the `superego` command, writing or changing a Superego profile (profile.ts), or building extensions for it - agent tools and prompt sections, daemon actions and live values, UI panes, slots and tool renderers.
---

# Superego

Superego runs agents. A **daemon** on each machine keeps them running while the app is closed; the **app**
(desktop, browser or phone) and the **`superego` command** are both clients of that daemon. What an agent *is*
(model, prompt, tools, UI) comes from a **profile**: files in `~/.superego/profiles/<name>/` or in a project's
`.superego/profiles/<name>/`.

```text
machine   a daemon (this computer, or one reached over ssh)
└─ project  a git repository (and its worktrees) or a folder, on that machine
   └─ thread  one conversation with an agent, in the folder or a worktree of its own
      └─ pane   a view beside the thread: a diff, a file, a web page, a profile's own
```

Everything the app does is an **action** with an id (`thread.start`, `pane.open`, `vault.graph`). The command line,
the window, keyboard shortcuts and extensions all run actions. `superego actions` lists what a machine offers.

## What to read for a task

Each topic fits in one read: `superego --skill <topic>`, or the file beside this one.

| To… | Read |
|---|---|
| give an agent a tool or a prompt section | [tools.md](tools.md) |
| add a pane beside the thread | [guide.md](guide.md#a-first-extension-end-to-end), then [ui.md](ui.md) |
| show a view with no UI code (blocks from the daemon) | [window.md](window.md#data-only-views) |
| put a mark on threads in the sidebar | [ui.md](ui.md#a-mark-in-the-sidebar), with [daemon.md](daemon.md#watching-tool-calls) |
| draw a board of threads | [ui.md](ui.md#reading-threads) |
| add an action, a shortcut or a live value | [daemon.md](daemon.md), the [cheat sheet](cheatsheet.md) |
| test it | [guide.md](guide.md#testing), [tools.md](tools.md#testing-a-tool) |
| write a profile | [profiles.md](profiles.md) |
| hand work to other threads, or write a lead profile | [thread-tools.md](thread-tools.md) |
| act as a thread starts, ends a run or is archived | [lifecycle.md](lifecycle.md#a-threads-life) |
| find out why it doesn't load or show | [debugging.md](debugging.md) |

## Extending Superego: start with `extension new`

To give agents a tool, or the window a pane or a mark, scaffold a working extension in the shape of the job and change
it. Don't start from a blank file.

**No Node needed.** `superego extension test` is the type checker and the test runner. Don't look for `node`, `npx`,
`tsc` or `bun`: plain Node can't import `superego`.

```sh
superego extension new orders           # an agent tool, in this project's default profile (.superego/profiles/default), made if there's none
superego extension new orders --ui      # a pane, UI half only (ui.tsx)
superego extension new orders --badge   # a mark in the sidebar: a daemon half sets a thread's fact, a UI half draws it
superego extension new orders --tool --ui   # an agent tool, and a pane of what it did
superego extension new orders --user    # in your own profile (~/.superego/profiles/default), for every folder
superego extension test orders          # check its types and run its tests
superego extension reload               # load the profile's changes now, and say why if it doesn't load
superego extensions                     # every extension here: where it's from, how it stands, what it registered
```

Each says which profile it uses. `superego <command> --help` gives any command's options.

`new` writes `<profile>/orders/`: the smallest working extension of that shape, with its `version` and `api`, a test on
`superego/testing` that passes as made, and a README; and it gives the profile its types. Then:

- **A thread keeps the profile it started with.** A profile made after a thread started doesn't reach it: not your own
  thread, nor the user's open ones. Start a new thread to use it (`superego -p "…"`), and tell the user to.
- Edits reach the profile's threads on their next turn; `superego extension reload` loads them now.
- A project's profile runs only once the user allows it (`superego profile allow <name>`, or in the window), again
  after any of its files change. That's their consent: from your shell it's refused, so tell them. Your own
  (`~/.superego/profiles`) need no allowing.
- Read the `guide` topic next: the big picture, a first extension end to end, the build-queue examples, a cheat sheet.

## Quick reference

```sh
superego                          # start a thread here and open it in the app
superego start . -p "fix tests"  # start one without the app; prints its id
superego send <thread> "and the docs" && superego read <thread> --wait   # its answer, once it stops working
superego threads --json           # every thread, with its status
superego actions                  # what `superego do` can run
superego mcp                      # those exposed to outside agents, as an MCP server on stdio (cli topic)
superego do thread.rename --thread <thread> --title "Fix the tests"
superego profile new [name]       # .superego/profiles/<name>/profile.ts, in this project, with types for an editor
superego daemon restart           # onto the installed code
```

## Where to read more

This is the overview. Each topic is a file beside this one (`guide.md`, `ui.md`, …), also printed by
`superego --skill <topic>`:

| Topic | Read it when |
|---|---|
| `guide` | building an extension: the big picture, one end to end, the build-queue examples (`examples/` beside it), testing |
| `cheatsheet` | looking up what either half of an extension can register, a line each |
| `window` | placing views (spaces, beside the thread, the pane menu, the header), data-only views, links, window events |
| `lifecycle` | teardown and what needs cleaning up, a thread's hooks (`starting`, `archived`, …), versions and compatibility |
| `cli` | starting and scripting threads, machines, settings, actions, the daemon |
| `profiles` | writing `profile.ts`: model, prompt, extensions, panes, allowing, `extends`, when changes apply |
| `tools` | giving an agent tools and prompt sections (`defineExtension`, `defineTool`, `section`) |
| `thread-tools` | an agent that starts, reads, messages and archives threads: parameters, reports, worktrees, a lead profile |
| `daemon` | an extension's daemon half: actions, live values, a thread's blocked status, reaching threads |
| `ui` | an extension's UI half: panes, slots, tool renderers, reading threads, hooks and components from `superego/ui` |
| `bundled` | working on Superego itself: a bundled extension in `extensions/`, tests, typecheck |
| `debugging` | something doesn't load, run or show up |

Read only the topics the task needs. A profile with a tool needs `profiles` and `tools`; one with a pane needs
`profiles`, `daemon` and `ui`.

## Ground rules

- A profile and its extensions import from `'superego'` (and UI from `'superego/ui'` and `'react'`). Nothing to
  install: the daemon and the window provide those modules. Other npm packages are not available to profiles.
- Their declarations, for an editor and `extension test`, are in `~/.superego/types/node_modules` (`superego`,
  `superego/ui`, `superego/testing`, React, Node, vitest). The app puts them there as it starts, and `superego profile
  new`, `extension new` and `profile types` link a profile's `node_modules` to them. To learn the API, read
  `node_modules/superego/index.d.ts`, `ui.d.ts` and `testing.d.ts`: one documented file per entry.
- Names are namespaced: an extension called `vault` names its actions and live values `vault.<something>`.
- A profile's UI from another machine runs in this computer's window only once allowed here:
  `superego profile allow-ui <name> -m <machine>`.
- The window loads a profile's UI as soon as it lists one of its threads ([ui.md](ui.md#when-the-ui-loads)). A
  changed profile loads again on the thread's next turn, and its UI when a shown thread of it moves on.
