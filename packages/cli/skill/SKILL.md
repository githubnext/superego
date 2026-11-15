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
└─ session  a project on that machine: a git repository (and its worktrees) or a folder
   └─ thread  one conversation with an agent, in the folder or a worktree of its own
      └─ pane   a view beside the thread: a diff, a file, a web page, a profile's own
```

Everything the app does is an **action** with an id (`thread.create`, `pane.open`, `vault.graph`). The command line,
the window, keyboard shortcuts and extensions all run actions. `superego actions` lists what a machine offers.

## Quick reference

```sh
superego                          # start a thread here and open it in the app
superego create . -p "fix tests"  # start one without the app; prints its id
superego send <thread> "and the docs"
superego threads --json           # every thread, with its status
superego actions                  # what `superego do` can run
superego mcp                      # those exposed to MCP, as an MCP server on stdio (cli topic)
superego do thread.rename --id <thread> --title "Fix the tests"
superego profile new [name]       # .superego/profiles/<name>/profile.ts, in this project, with types for an editor
superego daemon restart           # onto the installed code
```

## Where to read more

This is the overview. Print a topic with `superego --skill <topic>`:

| Topic | Read it when |
|---|---|
| `cli` | starting and scripting threads, machines, settings, actions, the daemon |
| `profiles` | writing `profile.ts`: model, prompt, extensions, panes, trust, `extends` |
| `tools` | giving an agent tools and prompt sections (`defineExtension`, `defineTool`, `section`) |
| `daemon` | daemon extensions: actions, live values, a thread's blocked status, reaching threads |
| `ui` | UI extensions: panes, slots, tool renderers, hooks and components from `superego/ui` |
| `bundled` | working on Superego itself: a bundled extension in `extensions/`, tests, typecheck |
| `debugging` | something doesn't load, run or show up |

Read only the topics the task needs. A profile with a tool needs `profiles` and `tools`; one with a pane needs
`profiles`, `daemon` and `ui`.

## Ground rules

- A profile and its extensions import from `'superego'` (and UI from `'superego/ui'` and `'react'`). Nothing to
  install: the daemon and the window provide those modules. Other npm packages are not available to profiles.
- A first extension, end to end, with diagrams and a cheat sheet: [docs/writing-extensions.md](https://github.com/mikker/superego/blob/main/docs/writing-extensions.md) in the Superego repository.
- Names are namespaced: an extension called `vault` names its actions and live values `vault.<something>`.
- A project's profile is code from that repo, so it runs only once allowed: `superego profile allow <name>`, again
  after any of its files change. Your own (`~/.superego/profiles`) need no allowing. A profile's UI from another
  machine runs in this computer's window only once allowed here: `superego profile allow-ui <name> -m <machine>`.
- A changed profile loads again on the thread's next turn; its UI loads again when the thread next changes.
