// The UI half of an extension: `<pkg>/ui`, listed in the app's renderer entry. It fills named slots in the shell, draws
// tool calls and entries in the transcript, adds pane kinds, custom settings components and actions (with keys).
// Components reach everything else (machines, threads, selection, live values, calls) through the hooks this package
// exports.
//
// Everything an extension registers is owned by it: the registry keeps who added each thing, and an extension's
// teardown removes all of it at once. A profile's UI is owned by that profile on its machine too, and draws only in
// that profile's threads there.
import { createContext, useContext, useSyncExternalStore, type ComponentType, type ReactNode } from 'react'
import type { AppConfig, DeclaredSection, Json, Pane, ProfileRef, SectionInfo, ThreadInfo } from '@superego/protocol'
import type { MachineEntry } from '../shared.ts'
import { createWindowRouter, type Dispatch, type WindowAction, type WindowRouter } from './actions.tsx'
import { createStore, type Store } from './local-state.ts'

/** Where an extension can put UI. */
export type SlotName =
  /** The column left of the thread: thread lists, machine trees. With nothing here, the shell shows a compact picker. */
  | 'sidebar'
  /** The rail down the window's left edge: a space's button (and, folded, its list as dots). Without one, the rail shows what's unread. */
  | 'rail'
  /** Right of a thread's title: badges, small actions. */
  | 'thread.header'
  /** Above the composer: things waiting on the user, suggestions. */
  | 'composer.above'
  /** A pane beside the thread: details, diffs, files. Hidden while everything in it renders nothing. */
  | 'thread.aside'
  /** Beside a file being edited: a file tree, an outline. `open` shows another file there (`beside`: in a pane of its own). */
  | 'editor.side'
  /** In a file editor's bar: small buttons. */
  | 'editor.bar'
  /** Always there, over everything: an extension's own dialogs (a quick open), drawn while it wants them. */
  | 'overlay'

/** What a slot beside a file editor gets: the file, and a way to show another. */
export type EditorSlotProps = { machine: MachineEntry; thread: ThreadInfo; path: string; open(path: string, options?: { beside?: boolean }): void }

export type SlotProps = {
  'sidebar': Record<string, never>
  'rail': Record<string, never>
  'thread.header': { machine: MachineEntry; thread: ThreadInfo }
  'composer.above': { machine: MachineEntry; thread: ThreadInfo }
  'thread.aside': { machine: MachineEntry; thread: ThreadInfo }
  'editor.side': EditorSlotProps
  'editor.bar': EditorSlotProps
  'overlay': Record<string, never>
}

/** What a pane is drawn with: where it is, and its own params. */
export type PaneProps = { machine: MachineEntry; thread: ThreadInfo; pane: Pane }

/** A kind of pane. `title` names its tab when the pane wasn't given one: fixed, or from the pane (its params, say). */
export type PaneKind = {
  title: string | ((pane: Pane) => string | undefined)
  component: ComponentType<PaneProps>
  /** Its glyph on the pane's tab in the strip. */
  icon?: ComponentType<{ size?: number; 'aria-hidden'?: boolean }>
  /** Its title is a file's name: the strip shows it as one (cut from the start, in the mono face). */
  file?: boolean
  /** Offered in the thread's pane menu: it shows something without being given params. */
  menu?: boolean
  /** Files it shows, given `{ path }`: a file opened from the thread opens in the first kind that takes it. */
  opens?: (path: string) => boolean
  /** It shows folders, given `{ path }` (in the thread's folder; `''` for the folder itself): a folder a thread names opens in it. */
  folders?: boolean
  /** Its width to start with, as a share of the row (0.5 when unset); dragging its edge changes it for that pane. */
  width?: number
}

/** A tool call in the transcript. `result` is there once it finished; `live` while it runs. */
export type ToolCallProps = {
  machine: MachineEntry
  thread: ThreadInfo
  call: { id: string; name: string; arguments: Record<string, unknown> }
  result?: { text: string; isError: boolean; details?: unknown }
  live?: { status: 'pending' | 'running' | 'done'; output?: string; details?: unknown }
}

/** An entry of a kind an extension writes (`kind` is its own, like `git.commit`). */
export type EntryProps = { machine: MachineEntry; thread: ThreadInfo; entry: { id: number; kind: string; data?: unknown } }

export type SettingsComponentProps = { target: string; section: SectionInfo }

/** A block of what the agent wrote: thinking, text, or a tool call (`id`, `name`, `arguments`). */
export type WorkBlock = { type: string; text?: string; thinking?: string; id?: string; name?: string; arguments?: unknown }

/**
 * A run of work in the transcript: what the agent did between your message and its answer. `active` while the run
 * goes on (it's the transcript's last and the agent is working); `result` is a tool call's, once it has one.
 */
export type WorkRun = { blocks: WorkBlock[]; active: boolean; result(callId: string): { text: string; isError: boolean } | undefined }

/** How a titled part of a run went: still going, done, failed, unsure (plans changed, no proof), or cut off. */
export type WorkStatus = 'running' | 'success' | 'failure' | 'inconclusive' | 'interrupted'

/**
 * A part of a run. Untitled, it shows as the core shows any run (a line saying what was done); titled, as that title,
 * how it went and its outcome, its blocks folded under it. Blocks left out of every part don't show.
 */
export type WorkPart = { blocks: WorkBlock[]; title?: string; status?: WorkStatus; outcome?: string }

export type UiApi = {
  app: AppConfig
  slot<S extends SlotName>(slot: S, component: ComponentType<SlotProps[S]>, options?: { order?: number }): void
  /**
   * Draw calls to the tool `name` (of the extension's daemon half, or any other). `fold: false` keeps them out of the
   * fold a run of work closes into: they show under it, open, as what the agent showed you (images, say).
   */
  tool(name: string, component: ComponentType<ToolCallProps>, options?: { fold?: boolean }): void
  entry(kind: string, component: ComponentType<EntryProps>): void
  /**
   * Divide runs of work into parts: the tasks an agent reported, say. The first divider to return parts for a run
   * draws it; `undefined` leaves it to the next, then to the core.
   */
  work(divide: (run: WorkRun) => WorkPart[] | undefined): void
  /** Draw the settings section that names `ui` (its daemon half registers the section). */
  settings(ui: string, component: ComponentType<SettingsComponentProps>): void
  /**
   * A kind of pane: a view opened beside a thread (`pane.open`, or the agent's open_pane tool) with params of its own.
   * A profile's pane kinds exist in that profile's threads only.
   */
  pane(kind: string, pane: PaneKind): void
  /**
   * An action of this extension: dispatched by its keys, from the palette, from other code (`useDispatch`). Ids start
   * with the extension's name. `run` gets its parameters and the window's context.
   */
  action(action: WindowAction): void
  /** Run any action (window, app or machine) through the window's router, outside React. In components: `useDispatch`. */
  dispatch: Dispatch
  /**
   * Settings of this UI half, kept by the app (per user, not per machine) and shown in Settings → General. Keys are
   * named `<extension>.<key>`. Read and change them with `useAppSetting`.
   */
  appSettings(section: DeclaredSection): void
  /**
   * State of this extension, kept in the window: read and changed by its actions and components alike (`store.use()`
   * in a component). Named `<extension>.<key>`; `persist` keeps it across reloads.
   */
  store<T extends Json>(key: string, initial: T, options?: { persist?: boolean }): Store<T>
}

export type UiExtension = {
  /** The same name as the daemon half, if there is one; the UI uses it to tell whether a machine has that half. */
  name: string
  setup(superego: UiApi): void
}

/** Identity for type inference: `export default defineUiExtension({ name, setup(superego) { … } })`. */
export const defineUiExtension = (extension: UiExtension) => extension

/** Who registered something: an extension, and for a profile's UI, that profile on its machine (`profileScope`). */
type Owner = { extension: string; profile?: string }
type Owned<T> = T & { owner: Owner }

/** A thread as lookups see it: on a machine, maybe with a profile. */
export type Where = { machine: string; thread: ThreadInfo }

/** A profile's UI, as the registry tells profiles apart: by machine and folder (the same path on two machines is two). */
export const profileScope = (machine: string, profile: ProfileRef) => `${machine}\u0000${profile.dir}`
const scopeOf = (where: Where | undefined) => where?.thread.profile ? profileScope(where.machine, where.thread.profile) : undefined

/** Everything the app's extensions registered, in the order they were listed, each with its owner. */
export type Registry = {
  app: AppConfig
  extensions: string[]
  slots: { [S in SlotName]: Owned<{ component: ComponentType<SlotProps[S]>; order: number }>[] }
  /** `fold: false`: its calls show outside the fold of their run of work. */
  tools: Owned<{ name: string; component: ComponentType<ToolCallProps>; fold: boolean }>[]
  entries: Owned<{ kind: string; component: ComponentType<EntryProps> }>[]
  panes: Owned<PaneKind & { kind: string }>[]
  work: Owned<{ divide: (run: WorkRun) => WorkPart[] | undefined }>[]
  settings: Owned<{ ui: string; component: ComponentType<SettingsComponentProps> }>[]
  router: WindowRouter
  appSettings: Owned<DeclaredSection>[]
  /** Set up a profile's UI extensions on `machine`, after tearing down what that profile set up before. */
  installProfile(machine: string, profile: ProfileRef, extensions: UiExtension[]): void
  /** Changes whenever extensions are added or removed at runtime; `subscribe` to hear it. */
  version: number
  subscribe(listener: () => void): () => void
}

export function createRegistry(app: AppConfig, extensions: UiExtension[], core: (superego: UiApi) => void): Registry {
  const listeners = new Set<() => void>()
  /** The teardown of each extension set up, by owner (`<profile scope>/<name>`). */
  const teardowns = new Map<string, () => void>()
  const ownerKey = (owner: Owner) => `${owner.profile ?? ''}/${owner.extension}`
  const registry: Registry = {
    app, extensions: extensions.map((e) => e.name),
    slots: { 'sidebar': [], 'rail': [], 'thread.header': [], 'composer.above': [], 'thread.aside': [], 'editor.side': [], 'editor.bar': [], 'overlay': [] },
    tools: [], entries: [], panes: [], work: [], settings: [], router: createWindowRouter(), appSettings: [],
    version: 0,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
    installProfile(machine, profile, list) {
      const scope = profileScope(machine, profile)
      for (const [key, teardown] of [...teardowns]) if (key.startsWith(`${scope}/`)) teardown()
      for (const extension of list) {
        try { setUp(extension, scope) } catch (error) { console.error(`Profile extension ${extension.name} failed to start`, error) }
      }
      registry.version++
      for (const listener of listeners) listener()
    },
  }

  /** Set up one extension: everything it adds is owned by it, and its teardown takes all of it away again. */
  function setUp(extension: UiExtension, profile?: string) {
    if (!/^[a-z][a-z0-9-]*$/.test(extension.name)) throw new Error(`Extension name "${extension.name}" must be lowercase letters, digits and dashes`)
    const owner: Owner = { extension: extension.name, ...(profile ? { profile } : {}) }
    // A name is the extension's prefix: one of each among the app's, and a profile's can't take one of theirs.
    if (teardowns.has(ownerKey(owner)) || (profile && teardowns.has(`/${extension.name}`))) throw new Error(`An extension named ${extension.name} is already set up`)
    const undo: (() => void)[] = []
    const add = <T,>(list: Owned<T>[], item: T) => {
      const entry = { ...item, owner } as Owned<T>
      list.push(entry)
      undo.push(() => { const at = list.indexOf(entry); if (at >= 0) list.splice(at, 1) })
      return entry
    }
    /** One of a kind per scope: a second registration of the same name is refused (the first stays), with a warning. */
    const unique = <T extends Record<K, string>, K extends keyof T>(list: Owned<T>[], key: K, item: T, what: string) => {
      const taken = list.find((e) => e[key] === item[key] && e.owner.profile === profile)
      if (taken) return console.warn(`Extension ${extension.name}: ${what} ${item[key]} is already drawn by ${taken.owner.extension}; keeping that one`)
      add(list, item)
    }
    const api: UiApi = {
      app,
      slot(slot, component, options) {
        // A profile's UI draws in its threads' slots; the sidebar and rail are the app's.
        if (profile && (slot === 'sidebar' || slot === 'rail')) return console.warn(`Profile extension ${extension.name} can't fill the ${slot}`)
        const list = registry.slots[slot] as Owned<{ component: ComponentType<SlotProps[typeof slot]>; order: number }>[]
        add(list, { component: component as never, order: options?.order ?? 100 })
        list.sort((a, b) => a.order - b.order)
      },
      tool: (name, component, options) => unique(registry.tools, 'name', { name, component, fold: options?.fold !== false }, 'tool'),
      entry: (kind, component) => unique(registry.entries, 'kind', { kind, component }, 'entry kind'),
      work(divide) {
        if (profile) return console.warn(`Profile extension ${extension.name}: dividing work from a profile's UI isn't supported yet`)
        add(registry.work, { divide })
      },
      settings: (ui, component) => unique(registry.settings, 'ui', { ui, component }, 'settings section'),
      pane: (kind, pane) => unique(registry.panes, 'kind', { ...pane, kind }, 'pane kind'),
      dispatch: (id, params, options) => registry.router.dispatch(id, params, { source: extension.name, ...options }),
      action(action) {
        if (profile) return console.warn(`Profile extension ${extension.name}: actions from a profile's UI aren't supported yet`)
        if (extension.name !== 'core' && !action.id.startsWith(`${extension.name}.`)) throw new Error(`Extension ${extension.name} must name its actions "${extension.name}.<name>", not "${action.id}"`)
        undo.push(registry.router.register(action))
      },
      appSettings(section) {
        if (profile) return console.warn(`Profile extension ${extension.name}: app settings from a profile's UI aren't supported yet`)
        for (const setting of section.settings) {
          if (extension.name !== 'core' && !setting.key.startsWith(`${extension.name}.`)) throw new Error(`Extension ${extension.name} must name its settings "${extension.name}.<key>", not "${setting.key}"`)
        }
        add(registry.appSettings, section)
      },
      store(key, initial, options) {
        if (!key.startsWith(`${extension.name}.`)) throw new Error(`Extension ${extension.name} must name its state "${extension.name}.<key>", not "${key}"`)
        return createStore(key, initial, options)
      },
    }
    const teardown = () => {
      for (const step of undo.splice(0).reverse()) step()
      teardowns.delete(ownerKey(owner))
    }
    teardowns.set(ownerKey(owner), teardown)
    try { extension.setup(api) } catch (error) { teardown(); throw error }
  }

  setUp({ name: 'core', setup: core })
  for (const extension of extensions) setUp(extension)
  return registry
}

const RegistryContext = createContext<Registry | undefined>(undefined)
export const RegistryProvider = ({ registry, children }: { registry: Registry; children: ReactNode }) =>
  <RegistryContext.Provider value={registry}>{children}</RegistryContext.Provider>

export function useRegistry(): Registry {
  const registry = useContext(RegistryContext)
  if (!registry) throw new Error('superego hooks need mountApp')
  return registry
}

/** The app this UI belongs to. */
export const useApp = () => useRegistry().app

/** What `where` sees of `list`: the app's, and its own profile's (only that profile's, on that machine). */
const seen = <T,>(list: Owned<T>[], where: Where | undefined) => {
  const scope = scopeOf(where)
  return list.filter((entry) => !entry.owner.profile || entry.owner.profile === scope)
}

/** The one of `list` that `where` sees by `match`: its profile's own first, else the app's. */
function lookUp<T>(list: Owned<T>[], where: Where | undefined, match: (entry: T) => boolean): Owned<T> | undefined {
  const found = seen(list, where).filter(match)
  return found.find((entry) => entry.owner.profile) ?? found[0]
}

/** Draw every component in `slot`, with `props`. */
export function Slot<S extends SlotName>({ name, props }: { name: S; props: SlotProps[S] }) {
  const registry = useRegistry()
  useSyncExternalStore(registry.subscribe, () => registry.version)
  const { machine, thread } = props as { machine?: MachineEntry; thread?: ThreadInfo }
  const entries = seen(registry.slots[name] as Owned<{ component: ComponentType<SlotProps[S]>; order: number }>[], machine && thread ? { machine: machine.id, thread } : undefined)
  return <>{entries.map(({ component: Component, owner }, index) => <Component key={`${owner.profile ?? ''}/${owner.extension}-${index}`} {...props} />)}</>
}

/** How calls to the tool `name` are drawn for `where`, if an extension draws them. */
export const toolView = (registry: Registry, name: string, where: Where) => lookUp(registry.tools, where, (t) => t.name === name)?.component

/** Whether calls to the tool `name` show outside the fold of their run, for `where` (an extension said `fold: false`). */
export const unfoldedTool = (registry: Registry, name: string, where: Where) => lookUp(registry.tools, where, (t) => t.name === name)?.fold === false

/** How entries of `kind` are drawn for `where`, if an extension draws them. */
export const entryView = (registry: Registry, kind: string, where: Where) => lookUp(registry.entries, where, (e) => e.kind === kind)?.component

/** The component under the settings section that names `ui`, on `target` (a machine, or 'app'). */
export const settingsView = (registry: Registry, ui: string, target: string) =>
  registry.settings.find((s) => s.ui === ui && (!s.owner.profile || s.owner.profile.startsWith(`${target}\u0000`)))?.component

/** A run of work in parts, as the first extension that divides it says; else whole. */
export function divideWork(registry: Registry, run: WorkRun): WorkPart[] {
  for (const { divide } of registry.work) {
    try {
      const parts = divide(run)
      if (parts) return parts
    } catch (error) { console.error('Dividing work failed', error) }
  }
  return [{ blocks: run.blocks }]
}

/** The pane kind `kind` as `where` sees it: its profile's own first, else the app's. */
export const paneKind = (registry: Registry, kind: string, where: Where): PaneKind | undefined => lookUp(registry.panes, where, (p) => p.kind === kind)

/** A pane's title: its own, else its kind's. */
export function paneTitle(registry: Registry, pane: Pane, where: Where): string {
  const named = paneKind(registry, pane.kind, where)?.title
  return pane.title ?? (typeof named === 'function' ? named(pane) : named) ?? pane.kind
}

/**
 * The pane kind a file opens in, for a thread: its profile's kind that takes the file, else any other that does
 * besides the editor, else the editor, which takes anything.
 */
export function fileKind(registry: Registry, where: Where, path: string): string {
  const found = seen(registry.panes, where).filter((p) => p.opens?.(path))
  return (found.find((p) => p.owner.profile) ?? found.find((p) => p.kind !== 'editor'))?.kind ?? 'editor'
}

/** The pane kind a folder opens in, for a thread: its profile's that shows folders, else any other; none, if none does. */
export function folderKind(registry: Registry, where: Where): string | undefined {
  const found = seen(registry.panes, where).filter((p) => p.folders)
  return (found.find((p) => p.owner.profile) ?? found[0])?.kind
}

/** The panes a thread's menu offers: the app's and its profile's that open without params. */
export function paneMenu(registry: Registry, where: Where): { kind: string; title: string }[] {
  const kinds = [...new Set(seen(registry.panes, where).map((p) => p.kind))]
  return kinds.flatMap((kind) => {
    const found = paneKind(registry, kind, where)
    if (!found?.menu) return []
    return [{ kind, title: (typeof found.title === 'function' ? found.title({ id: '', kind }) : found.title) ?? kind }]
  })
}
