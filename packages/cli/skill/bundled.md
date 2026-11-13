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
export const about = { name: 'orders', title: 'Orders', description: 'Look orders up.' } satisfies ExtensionAbout
// daemon.ts: defineDaemonExtension({ ...about, setup(superego) { … } })
// ui.tsx:    defineUiExtension({ ...about, setup(superego) { … } })
```

Optional is the default, and almost always right: a machine can turn it off (Settings → Extensions lists it with its
`title` and `description`), a profile can leave it out (`without: ['orders']`), and the app works without it. A thread
that goes without it gets none of its agent parts or pane kinds, and the window draws none of its UI for that thread
(`ThreadInfo.without`): its panes already open are kept with the thread but not shown, its actions not offered. `required: true` is for what the app is (the sidebar): never listed, never left out. Nothing
else decides this. An extension whose work is all in the window still gets a daemon half of its declaration alone
(`export default defineDaemonExtension(about)`, as `links` has), so machines know it; a required one needn't.

Then wire it in:

1. `app/package.json`: `"@superego/orders": "workspace:*"`, then `pnpm install`.
2. `app/src/daemon.ts`: add the daemon half to `extensions: [...]` (and to `app/native/daemon.ts`, the native shell's).
3. `app/src/renderer/main.tsx`: add the UI half to `mountApp(app, { extensions: [...] })`.
4. Root `package.json`: add `tsc -p extensions/orders` to `typecheck`.
5. The README's layout table: a line for it.

Bundled extensions get more than a profile's:

- **Every slot**, including `sidebar`, and **`superego.work(divide)`** to group a run of work in the transcript
  (as `tasks` does).
- **Window actions** with keys: `superego.action(defineAction({ id: 'orders.open', title, keys: 'mod+shift+o', when, run(params, context) { … } }))`;
  ids start with the extension's name. `when(context)` says when keys and the palette offer it (`(c) => Boolean(c.selection)`);
  `context` has the selection, sessions, `appSetting(key)` and `dispatch`.
- **Window state** for actions and components to share: `const open = superego.store('orders.open', false)` in setup,
  `open.set(true)` in an action, `open.use()` in a component; `{ persist: true }` keeps it across reloads. No module
  globals that rendering sets.
- **App settings** (per user, in Settings → General): `superego.appSettings({ id, title, settings: [{ key: 'orders.x', … }] })`,
  read with `useAppSetting('orders.x')`, or `context.appSetting('orders.x')` in an action.
- **Machine settings** from the daemon half: `superego.settings.register({ id: 'orders', title, settings: [{ key: 'orders.x', title, default, type }] })`.
- A feature flag: the daemon announces `ext:<name>`, so a UI half checks `has(machine, 'ext:orders')` before
  watching a value an older or different daemon doesn't have.

## Tests

Daemon halves are tested against a real daemon with a scripted model. See `extensions/tasks/test/daemon.test.ts`:

- write the model's turns to a JSONL file and set `<APPID>_MODEL=replay:<file>` and `<APPID>_REPLAY_SPEED=0`;
- `openDaemon({ app, dataDir, defaultCwd, extensions: [yours] })`, `listen(daemon, socket)`, connect, call methods;
- wait for the thread's status and assert on the transcript, live values or action results.

Pure logic (parsing, dividing work, a composer provider's `word`, a `sentWith` reader) gets plain unit tests; see
`extensions/skills/test/names.test.ts`. `pnpm test` runs everything under `packages/*/test` and
`extensions/*/test`.

## Conventions

- Comments explain why and what something is for, in plain words, at the top of each file.
- Name things after what the user sees: thread, pane, session, machine.
- Keep this skill (`packages/cli/skill/`) and the README in step when the extension API, profiles or commands change.
