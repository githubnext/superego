# Working on Superego itself

New to this? Start with [docs/writing-extensions.md](https://github.com/mikker/superego/blob/main/docs/writing-extensions.md): the big picture, a first extension end to end, and a cheat sheet.

For changes to the Superego repository (github.com/mikker/superego): the core, or an extension bundled with the app.
A profile is the way to extend Superego for a project or for yourself; bundle an extension only when every Superego
user should have it.

## The repository

```sh
pnpm install
pnpm test                 # unit + daemon/CLI end-to-end, with scripted models
pnpm typecheck
pnpm dev                  # the app, from source; its daemon lives in ~/.superego
pnpm --filter superego smoke   # end-to-end of the app, headless
pnpm link:cli             # `superego` on PATH, from this checkout
```

| | |
|---|---|
| `packages/protocol` | the contract: methods, JSON-RPC, actions, status types |
| `packages/daemon` | the daemon: threads, profiles, worktrees, the daemon half of the extension API (`extension.ts`) |
| `packages/app` | the window: shell, panes, editor, the UI half of the extension API (`renderer/extension.tsx`), `superego/ui` exports (`renderer/index.tsx`) |
| `packages/cli` | the `superego` command; this skill is in `packages/cli/skill/` |
| `packages/ui` | components and design tokens |
| `extensions/*` | bundled extensions |
| `app/` | the app itself: `superego.config.ts`, the daemon entry (`src/daemon.ts`), the window entry (`src/renderer/main.tsx`), `bin/superego.ts` |

After changing daemon code, `superego daemon restart` runs the new code (the app offers the same).

## A bundled extension

A package in `extensions/<name>` with up to two halves, imported by the app at build time:

```text
extensions/orders/
  package.json        "name": "@superego/orders", "exports": { "./daemon": "./src/daemon.ts", "./ui": "./src/ui.tsx" }
  tsconfig.json       copy extensions/tasks/tsconfig.json
  src/shared.ts       what both halves agree on: `about` (what it is), tool names, value keys, action ids, types
  src/daemon.ts       export default defineDaemonExtension({ … })   from '@superego/daemon'
  src/ui.tsx          export default defineUiExtension({ … })       from '@superego/app/ui'
  test/daemon.test.ts
```

Bundled code imports packages directly, not `'superego'`: `defineExtension`, `defineTool`, `section` from
`@earendil-works/pi-durable`; schemas from `@earendil-works/pi-schema`; `defineAction` (machine actions), `RpcError`
from `@superego/protocol`; `defineAction` for window actions from `@superego/app/ui`; components from `@superego/ui`.
Copy `extensions/ask-user/package.json` for dependencies.

**Required or optional.** An extension says what it is once, in `src/shared.ts`, and spreads that into both halves:

```ts
export const about = { name: 'orders', version: '1.0.0', api: '^1', title: 'Orders', description: 'Look orders up.' } satisfies ExtensionAbout
// daemon.ts: defineDaemonExtension({ ...about, setup(superego) { … } })
// ui.tsx:    defineUiExtension({ ...about, setup(superego) { … } })
```

Optional is the default, and almost always right: a machine can turn it off (Settings → Extensions lists it with its
`title` and `description`), a profile can leave it out (`without: ['orders']`), and the app works without it. A thread
that goes without it gets none of its agent parts or pane kinds, and the window draws none of its UI for that thread
(`ThreadInfo.without`): its panes already open are kept with the thread but not shown, its actions not offered. `required: true` is for what the app is (the sidebar): never listed, never left out. Nothing
else decides this. An extension whose work is all in the window needs no daemon half (`links` has none): the window
declares its `about` to every machine it connects to, so each lists it in Settings and profiles can do without it.
Where the halves should differ, a package can be two extensions, an `about` each: `threads` is the required sidebar
(its UI half), and its daemon half is `thread-tools`, the agent's thread tools, optional.

Then wire it in:

1. `app/package.json`: `"@superego/orders": "workspace:*"`, then `pnpm install`.
2. `app/src/daemon.ts`: add the daemon half to `extensions: [...]` (and to `app/native/daemon.ts`, the native shell's).
3. `app/src/renderer/main.tsx`: add the UI half to `mountApp(app, { extensions: [...] })`.
4. Root `tsconfig.json`: add `{ "path": "extensions/orders" }` to `references`, or `pnpm typecheck` skips it.
5. The README's layout table: a line for it.

Bundled extensions get more than a profile's:

- **Views in the window's places**, not only a thread's: `superego.view(id, { title, icon, context, fits, default,
  narrow, withoutSpaces, order, component })` (see "Views and the layout" in `docs/writing-extensions.md`). A `space`
  is a rail button (its `icon`, or its own `rail` component) and the sidebar while open (`fold`: the action, given
  `{ on }`, that folds it into the rail as the sidebar's edge is dragged narrow); `rail` is a button there that
  isn't a space (Ego's, `order: 10`); `drawer` the foot of a phone's drawer, beside Settings; `titlebar` the title
  bar's start. `default` is where it starts (none: offered, the user places it), `narrow` where it goes on a phone,
  `withoutSpaces` where it goes while no view is in `space` (Unread's bell in the rail). The user's layout decides in
  the end: read where it is with `usePlacement(id, place)`, never keep a setting of your own for it. `slot()` in the
  old places (`sidebar`, `rail`, `footer`, `thread.aside`, `thread.header`) is deprecated, and goes after 2027-03-01
  (`ALIASES['ui:view-slots']`): until then it declares a view of that place, `<extension>.<slot>`, with a warning.
  Declare the `view`. And **`superego.work(divide)`** to group a run of
  work in the transcript (as `tasks` does).
- **New thread fields**: `superego.newThreadField({ component, from })`. `component` gets `{ machine, cwd, value,
  onChange }` and draws a field in the dialog (a checkbox: `<label className="new-thread__check">`); its value goes to
  `thread.create` as `options.<name>`, for the daemon half's `creating` hook. `from(thread)` is its value for a thread
  started like that one (⌘N). Shown while the machine picked has the extension. `worktrees` has one.
- **Window actions** with keys: `superego.action(defineAction({ id: 'orders.open', title, keys: 'mod+shift+o', when, run(params, context) { … } }))`;
  ids start with the extension's name. `when(context)` says when keys and the palette offer it (`(c) => Boolean(c.selection)`);
  `context` has the selection, sessions, `appSetting(key)` and `dispatch`.
- **Window state** for actions and components to share: `const open = superego.store('orders.open', false)` in setup,
  `open.set(true)` in an action, `open.use()` in a component; `{ persist: true }` keeps it across reloads. No module
  globals that rendering sets.
- **App settings** (per user, in Settings → General): `superego.appSettings({ id, title, settings: [{ key: 'orders.x', … }] })`,
  read with `useAppSetting('orders.x')`, or `context.appSetting('orders.x')` in an action.
- **Machine settings** from the daemon half: `superego.settings.register({ id: 'orders', title, settings: [{ key: 'orders.x', title, default, type }] })`.
- A feature flag: the daemon announces `ext:<name>` for each extension set up and switched on there, and tells clients
  again whenever that changes, so `has(machine, 'ext:orders')` says whether a machine has it now (a profile's once the
  profile loads). Watching a value needs no check: it's null until the extension publishes it. Check it before calling the
  daemon half's methods: a machine running an older Superego may not have them, or a newer one a major ahead
  (`has(machine, 'ext:orders@<2')`; `about` says the extension's `version` and the extension `api` it needs). Renaming
  a method or action keeps the old name as an alias until a milestone: an entry in `ALIASES`
  (`packages/protocol/src/compat.ts`), from which the daemon's `MOVED_*` are read. See "Versions and compatibility" in
  `docs/writing-extensions.md`.

## Tests

Use `superego/testing` (`@superego/sdk/testing`; "Testing" in `docs/writing-extensions.md`): `testDaemon({ extensions:
[yours], model: [callTool(…), say(…)] })` runs the daemon half against a real daemon with a scripted model, and
`mountUi({ extensions: [yours], machines: [fakeMachine({ … }) or daemonMachine(daemon)] })` the UI half in the window's
own registry and shell. Older tests set up the same by hand (`extensions/tasks/test/daemon.test.ts`).

Pure logic (parsing, dividing work, a composer provider's `word`, a `sentWith` reader) gets plain unit tests; see
`extensions/skills/test/names.test.ts`. `pnpm test` runs everything under `packages/*/test` and
`extensions/*/test`.

## Conventions

- Comments explain why and what something is for, in plain words, at the top of each file.
- Name things after what the user sees: thread, pane, session, machine.
- Keep this skill (`packages/cli/skill/`) and the README in step when the extension API, profiles or commands change.
