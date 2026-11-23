# Working on Superego itself

New to this? Start with [the guide](guide.md) (`superego --skill guide`): the big picture, a first extension end to end, and testing; and [the cheat sheet](cheatsheet.md) of both halves.

For changes to the Superego repository (github.com/githubnext/superego): the core, or an extension bundled with the app.
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
| `packages/app` | the window: shell, panes, editor, the UI half of the extension API (`renderer/extension-api.ts`; the registry, `renderer/registry.tsx`), `superego/ui` exports (`renderer/index.tsx`) |
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
  tsconfig.json       { "extends": "../tsconfig.json", "include": ["src", "test"] }
  src/shared.ts       what both halves agree on: `about` (what it is), tool names, value keys, setting keys, action ids, types
  src/daemon.ts       export default defineDaemonExtension({ … })   from '@superego/daemon'
  src/ui.tsx          export default defineUiExtension({ … })       from '@superego/app/ui'
  test/daemon.test.ts
```

Bundled code imports packages directly, not `'superego'`. A daemon half takes the daemon's side from `@superego/daemon`
(`defineDaemonExtension`, `defineAction` for machine actions, `RunRecord` and the other daemon types), and what both
sides speak from `@superego/protocol` (`RpcError`, `ExtensionAbout`, `ThreadInfo`); `defineExtension`, `defineTool`,
`section` from `@earendil-works/pi-durable`; schemas from `@earendil-works/pi-schema`. A UI half takes everything of
the window from `@superego/app/ui` (`defineAction` for window actions, hooks, components), and icons from
`@superego/ui`. Copy `extensions/tasks/package.json` for dependencies, and list only what `src` imports.

**Required or optional.** An extension says what it is once, in `src/shared.ts`, and spreads that into both halves:

<!-- check: module; import type { ExtensionAbout } from 'superego' -->
```ts
export const about = {
  name: 'orders', version: '1.0.0', api: '^5', title: 'Orders', description: 'Look orders up.',
  panes: { order: 'an order, with its lines and status. Params: { id }' },   // the kinds its UI half draws, for pane_open
} satisfies ExtensionAbout
// daemon.ts: defineDaemonExtension({ ...about, setup(superego) { … } })
// ui.tsx:    defineUiExtension({ ...about, setup(superego) { … } })
```

Optional is the default, and almost always right: a machine can turn it off (Settings → Extensions lists it with its
`title` and `description`), a profile can leave it out (`without: ['orders']`), and the app works without it. A thread
that goes without it gets none of its agent parts or pane kinds, and the window draws none of its UI for that thread
(`ThreadInfo.without`): its panes already open are kept with the thread but not shown, its actions not offered. `required: true` is for what the app is (the sidebar): never listed, never left out. Nothing
else decides this. An extension whose work is all in the window needs no daemon half (`links` and `browser` have none):
the daemon lists its `about` alone (from its `shared.ts`, which has no UI code), so every machine knows it from the
start, window or not: lists it in Settings, tells the agent of its `panes`, and lets profiles do without it. A window
also declares its extensions to each machine it connects to (`extension.declare`), for a daemon that doesn't bundle
them.
Where a window part and a machine part should differ, make them two extensions, a folder and an `about` each:
`threads` is the required sidebar (UI only), and `thread-tools`, the agent's thread tools, is optional (daemon only).

Then wire it in:

1. `app/package.json`: `"@superego/orders": "workspace:*"`, then `pnpm install`.
2. `app/src/daemon.ts`: add the daemon half to `extensions: [...]`; one with none, its `about` (export `./shared` from
   its `package.json`).
3. `app/src/renderer/main.tsx`: add the UI half to `mountApp(app, { extensions: [...] })`.
4. Root `tsconfig.json`: add `{ "path": "extensions/orders" }` to `references`, or `pnpm typecheck` skips it.
5. `docs/development.md`'s table of bundled extensions: a line for it.

A daemon half the app or a test configures is a factory named after it, `ordersExtension({ … })`, with the module's
default export the one most hosts want (`export default ordersExtension()`); one nothing configures is just the default
export.

Bundled extensions get more than a profile's:

- **Views in the window's places**, not only a thread's: `superego.view(id, { title, icon, context, fits, default,
  narrow, withoutSpaces, order, component })` (see [Views and the layout](window.md#views-and-the-layout)). A `space`
  is a rail button (its `icon`, or its own `railButton` component, told `sidebarHidden`) and the sidebar while open;
  `rail` is a button there that
  isn't a space (Ego's, `order: 10`); `drawer` the foot of a phone's drawer, beside Settings; `titlebar` the title
  bar's start. `default` is where it starts (none: offered, the user places it), `narrow` where it goes on a phone,
  `withoutSpaces` where it goes while no view is in `space` (Unread's bell in the rail). A button of its own in the rail
  is a `<RailButton label on>`, lit while `on`, as the rail's own are. The user's layout decides in
  the end: read where it is with `usePlacement(id, place)`, never keep a setting of your own for it. And
  **`superego.work(divide)`** to group a run of
  work in the transcript (as `tasks` does).
- **New thread fields**: `superego.newThreadField({ component, from })`. `component` gets `{ machine, cwd, value,
  onChange }` and draws a field in the dialog (a checkbox, say); its value goes to
  `thread.start` as `options.<name>`, for the daemon half's `starting` hook. `from(thread)` is its value for a thread
  started like that one (⌘N). Shown while the machine picked has the extension. `worktrees` has one.
- **Window actions** with keys: `superego.action(defineAction({ id: 'orders.open', title, keys: 'mod+shift+o', when, run(params, context) { … } }))`;
  ids start with the extension's name. `when(context)` says when keys and the palette offer it (`(c) => Boolean(c.selection)`);
  `context` has the selection, projects, `appSetting(key)` and `dispatch`.
- **A store** for actions and components to share: `const open = superego.store('orders.open', false)` in setup,
  `open.set(true)` in an action, `open.use()` in a component; `{ persist: true }` keeps it across reloads. No module
  globals that rendering sets.
- **App settings** (per user, in Settings → General, or Appearance or Hotkeys with `tab: 'appearance'` or `'hotkeys'`):
  `superego.appSettings({ id, title, settings: [{ key: 'orders.x', … }] })`, read with `useAppSetting('orders.x')`, or `context.appSetting('orders.x')` in an action.
- **Machine settings** from the daemon half: `superego.settings.register({ id: 'orders', title, settings: [{ key: 'orders.x', title, default, type }] })`.
- **A settings section drawn your own way**, for what isn't a list of settings (a machine's MCP servers, its
  providers): the daemon half registers `{ id, title, ui: 'orders', settings: [], value: 'orders.list' }`, naming a
  live value of its own that it keeps current, and the UI half draws it with `superego.settings('orders', Component)`
  (given `{ target, section }`, the value as `section.data`, kept current: run actions with `{ machine: target }`, so a
  remote machine works the same). `data: () => …` instead is read with each snapshot, for what doesn't change between
  them. A sign-in of the
  extension's own runs in its daemon (`superego.auth.flow(context, run)`, answered `{ flow }`) and shows in the window
  with `<SignInFlow machine title start onClose />`. `extensions/mcp-servers` does all of it.
- **Byte streams**, for what doesn't fit JSON calls (a terminal's output and keystrokes): the daemon half accepts
  them with `superego.channel(kind, accept)` (`<name>.<kind>`; `accept(channel, params)` throws an `RpcError` to
  refuse, reads with `channel.onData`, writes with `channel.write`), and the window opens one with `channel(machine.id,
  kind, params)` from `superego/unstable`. A channel ends with its connection. `extensions/terminal` does it.
- Whether a machine has it: the daemon announces each extension set up and switched on there in `hello.extensions`
  (its manifest), and tells clients again whenever that changes, so `has(machine, 'ext:orders')` says whether a
  machine has it now (a profile's once the profile loads). Watching a value needs no check: it's null until the extension publishes it. The window draws
  none of the UI half for threads on a machine that runs the extension at another major than `about.version`'s; a
  minor it relies on, check with `has(machine, 'ext:orders@^1.2')`. See [Versions and compatibility](lifecycle.md#versions-and-compatibility).

## Tests

Use `superego/testing` (`@superego/sdk/testing`; [Testing](guide.md#testing)): `testDaemon({ extensions:
[yours], model: [callTool(…), say(…)] })` runs the daemon half against a real daemon with a scripted model, and
`mountUi({ extensions: [yours], machines: [fakeMachine({ … }) or daemonMachine(daemon)] })` the UI half in the window's
own registry and shell. No test opens a daemon by hand: `extensions/tasks/test/daemon.test.ts` is a short one to copy,
`extensions/agent-ui/test/daemon.test.ts` a longer one, `extensions/terminal/test/daemon.test.ts` one that opens
channels. What a test needs that `testDaemon` lacks goes in it (`packages/sdk/src/testing`), not in the test. A fixed
sleep is only for "nothing happened" where nothing says so, with a comment.

Pure logic (parsing, dividing work, a composer provider's `word`, a `sentWith` reader) gets plain unit tests; see
`extensions/skills/test/names.test.ts`. `pnpm test` runs everything under `packages/*/test` and
`extensions/*/test`.

## Conventions

- Comments explain why and what something is for, in plain words, at the top of each file.
- Name things after what the user sees: thread, pane, project, machine.
- Name your CSS classes after the extension (`.orders-list`, `.orders-list__row`). The window's own look comes through
  its components (`PaneMessage`, `PaneNote`, `PaneButton`, `HeaderChip`, `ThreadBadge`, `Chip`, `RailButton`, `DiffStat`), never its
  class names, and a fact through `factsOf<T>(thread, about)`.
- Keep this skill (`packages/cli/skill/`) and `docs/` in step when the extension API, profiles or commands change.
