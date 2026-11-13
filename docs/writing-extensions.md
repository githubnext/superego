# Writing extensions

An extension has up to two halves: a **daemon half** next to the agents on a machine, and a **UI half** in the window.
Either can be left out. Everything either half registers is its own, and goes when it does.

## The big picture

<picture><source media="(prefers-color-scheme: dark)" srcset="writing-extensions/big-picture-dark.svg"><img src="writing-extensions/big-picture.svg" alt="The daemon half gives the agent tools; the UI half dispatches actions to it, calls its methods and watches its live values"></picture>

| The UI half wants to… | The daemon half offers | The UI uses |
|---|---|---|
| change something | `action(defineAction({ id, run }))`: logged, in ⌘K, on the command line | `useDispatch()(id, params, { machine })` |
| read something | `method(name, run, { params })`: a plain request | `call(machine, name, params)` |
| follow something | `value(key, initial)` | `useValue(machine, connected, key)` |

Where they come from:

<picture><source media="(prefers-color-scheme: dark)" srcset="writing-extensions/loading-dark.svg"><img src="writing-extensions/loading.svg" alt="Bundled extensions are built into the app; profiles in ~/.superego/profiles or a project's .superego/profiles name their extensions and UI modules"></picture>

A profile's halves import `'superego'` and `'superego/ui'`. A bundled extension's halves import the packages directly (`@superego/daemon`, `@superego/app/ui`, …), see [bundled.md](../packages/cli/skill/bundled.md).

## A first extension, end to end

A profile, `~/.superego/profiles/default/`, whose agent keeps notes and whose window shows them in a pane:

```ts
// profile.ts
import { defineProfile } from 'superego'
export default defineProfile({ extensions: ['./notes.ts'], ui: ['./ui.tsx'] })
```

```ts
// notes.ts: the daemon half. A tool for the agent, a read for the pane, and the pane described to the agent.
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { defineDaemonExtension, defineExtension, defineTool, obj, str } from 'superego'

export default defineDaemonExtension({
  name: 'notes',
  setup(superego) {
    const fileOf = async (id: string) => join((await superego.threads.get(id)).cwd, 'NOTES.md')
    const read = async (id: string) => readFile(await fileOf(id), 'utf8').catch(() => '')
    superego.agent(defineExtension({
      name: 'notes',
      tools: [defineTool({
        name: 'add_note', description: 'Add a line to NOTES.md.', parameters: obj({ text: str() }),
        async execute({ text }, api) {
          const id = superego.threads.of(api.conversationId)!
          await writeFile(await fileOf(id), `${await read(id)}- ${text}\n`)
          return { output: [{ type: 'text', text: 'Noted.' }] }
        },
      })],
    }))
    superego.method('notes.read', async ({ id }) => ({ text: await read(id) }), { params: obj({ id: str() }) })
    superego.pane('notes', "the thread's NOTES.md; no params")
  },
})
```

```tsx
// ui.tsx: the UI half. A pane, offered in the thread's pane menu.
import { useEffect, useState } from 'react'
import { call, defineUiExtension, type PaneProps } from 'superego/ui'

function Notes({ machine, thread }: PaneProps) {
  const [text, setText] = useState('')
  useEffect(() => { void call<{ text: string }>(machine.id, 'notes.read', { id: thread.id }).then((r) => setText(r.text)) }, [thread.activeAt])
  return <pre className="pane-scroll">{text || 'No notes yet.'}</pre>
}

export default defineUiExtension({ name: 'notes', setup: (superego) => superego.pane('notes', { title: 'Notes', component: Notes, menu: true }) })
```

Send a thread a message: the daemon loads the profile and the agent has `add_note`; the window loads its UI when it
shows the thread. After an edit, the daemon half reloads on the thread's next turn, the UI once the thread moves on.

## Cheat sheet

| Daemon half (`superego.` in `setup`) | For |
|---|---|
| `agent(defineExtension({ tools, sections, hooks }))` | the agent's tools, prompt sections and hooks |
| `action(defineAction({ id: 'x.y', params, run }))` | an intent: logged, in ⌘K; `expose: ['ui', 'cli']` for `superego do` |
| `method('x.y', run, { params })` | a read for the UI; params checked first |
| `value('x.y', initial)` → `get`, `set`, `update` | live state the UI watches; in memory |
| `pane(kind, about)` | tell the agent about a pane kind, for `open_pane` |
| `status((thread) => ({ kind: 'question' }))`, `invalidate()` | show a thread as needing you |
| `submit(({ thread, text, attachments, content }) => [...content, block])` | add to what a message gives the agent before its turn (a named skill's instructions); return nothing to leave it |
| `settings.register({ id: 'x', settings })`, `settings.get`, `settings.onChange` | machine settings of its own (`x.…`); read any |
| `threads.list()`, `get(id)`, `of(conversationId)`, `conversation(id)`, `attachments(id)` | reach threads, and the folder a thread keeps files in |
| `agentsDir` | the folder agents share (`~/.agents`): skills, `AGENTS.md` |
| `harness` | pi-durable itself; unstable |

| UI half (`superego.` in `setup`) | For |
|---|---|
| `slot(name, Component, { order })` | a component in a place in the window (below) |
| `pane(kind, { title, component, icon, file, menu, opens, folders, urls, width })` | a kind of pane beside the thread; `opens`, `folders`, `urls`: files, folders or web pages a thread names open in it |
| `tool(name, Component, { fold })` | how calls to a tool look; `fold: false` shows them outside the run's fold (images) |
| `entry(kind, Component)` | transcript entries of a kind it writes |
| `composer.complete({ title, word(text, caret), items(word, { machine, thread }) })` | complete the word being typed: `word` finds it (`{ start, query }`), `items` offers `{ label, detail, insert }` |
| `composer.sentWith({ read(blocks), component })` | draw what its `submit` put in sent messages under them (a chip): `read` returns `{ items, blocks }`, and those blocks leave the text |
| `work(divide)` | split a run of work into titled parts (tasks); bundled only |
| `action(defineAction({ id, keys, when, run }))` | a window action with keys, in ⌘K while `when(context)` holds; bundled only |
| `store('x.y', initial, { persist })` → `get`, `set`, `use()` | window state its actions and components share |
| `appSettings({ id, settings })` | per-user settings; `useAppSetting(key)`, `context.appSetting(key)`; bundled only |
| `settings(ui, Component)` | draw under a settings section that names `ui` |
| `dispatch(id, params, { machine })` | run any action outside React |

Names: everything is `<extension>.<something>`, except tool and pane kind names. In components: `useSelection`,
`useMachines`, `useSessions`, `useValue`, `useDispatch`, `call`, `has(machine, 'ext:x')`; in panes `<PaneHeader>` and
`useTabNote`; to build from, `FileEditor`, `Markdown` and `Diff`. Full tables: [daemon.md](../packages/cli/skill/daemon.md), [ui.md](../packages/cli/skill/ui.md).

## Places in the window

<picture><source media="(prefers-color-scheme: dark)" srcset="writing-extensions/places-dark.svg"><img src="writing-extensions/places.svg" alt="The window: rail, sidebar, the thread with its header, transcript and composer.above, thread.aside, panes with the editor's bar and side, and an overlay over everything"></picture>

Thread slots get `{ machine, thread }`; editor slots also `path` and `open(path)`. A profile's UI draws only in its own
threads, and not in `sidebar` or `rail`.

## Lifecycle and ownership

<picture><source media="(prefers-color-scheme: dark)" srcset="writing-extensions/lifecycle-dark.svg"><img src="writing-extensions/lifecycle.svg" alt="Set up, registrations owned by the extension, torn down when its profile changes or the daemon stops, then set up again"></picture>

- `setup` may return a cleanup. Registrations need none: teardown removes them all.
- A name is claimed while set up: a second extension of the same name is refused.
- A profile's daemon half loads with its first turn, when a window shows one of its threads, or before an interrupted
  run of it resumes. A project's profile runs only once allowed (`superego profile allow`).

Bundled extensions also declare whether they're required, once, in `about` (spread into both halves):

<picture><source media="(prefers-color-scheme: dark)" srcset="writing-extensions/required-dark.svg"><img src="writing-extensions/required.svg" alt="A required extension is always on; an optional one can be switched off per machine or left out by a profile, and that thread then has none of its tools, pane kinds or UI"></picture>

Only the sidebar (`threads`) is required. Everything else is optional, the core's own `coding-tools`, `panes`,
`agents-md` and `thread-tools` included.

## Real ones to read

| Extension | Shows |
|---|---|
| [`tasks`](../extensions/tasks/src) | the smallest: two tools and a prompt section; a `work` divider |
| [`suggestions`](../extensions/suggestions/src) | a hook, a side call, a live value, a `composer.above` slot |
| [`ask-user`](../extensions/ask-user/src) | a tool that waits on you: `status`, an action to answer, a `tool` view |
| [`images`](../extensions/images/src) | a tool with `{ fold: false }`, files kept with `threads.attachments` |
| [`git`](../extensions/git/src) | Changes: a `method` (a read), a `pane` the agent is told of, built on the kit's `Diff`, an `action` with keys |
| [`web-panes`](../extensions/web-panes/src) | two pane kinds and nothing else; `urls: true` makes web links open in one |
| [`skills`](../extensions/skills/src) | a prompt section, a `submit` transform, a `method`; `composer.complete` and `composer.sentWith` |
| [`files`](../extensions/files/src) | a `method`, a `pane` the agent is told of, an `overlay`, `store`s, `when` |
| [`links`](../extensions/links/src) | UI only, with a daemon half that only declares it |
| [`threads`](../extensions/threads/src) | the required one: `sidebar`, `rail`, `thread.aside`, app settings |

Diagram sources are the `.mmd` files in [writing-extensions/](writing-extensions/); re-render with the `diagram` skill
(`bun <skill>/scripts/render.ts x.mmd x.svg`, and `--dark` for `x-dark.svg`).
