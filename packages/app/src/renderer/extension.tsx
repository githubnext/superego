// The UI half of an extension: `<pkg>/ui`, listed in the app's renderer entry. It fills named slots in the shell, draws
// tool calls and entries in the transcript, adds custom settings components and actions (with keys). Components reach
// everything else (machines, threads, selection, live values, calls) through the hooks this package exports.
import { createContext, useContext, useSyncExternalStore, type ComponentType, type ReactNode } from 'react'
import type { AppConfig, DeclaredSection, Pane, SectionInfo, ThreadInfo } from '@superego/protocol'
import type { MachineEntry } from '../shared.ts'
import { createWindowRouter, type Dispatch, type WindowAction, type WindowRouter } from './actions.tsx'

/** Where an extension can put UI. */
export type SlotName =
  /** The column left of the thread: thread lists, machine trees. With nothing here, the shell shows a compact picker. */
  | 'sidebar'
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
  'thread.header': { machine: MachineEntry; thread: ThreadInfo }
  'composer.above': { machine: MachineEntry; thread: ThreadInfo }
  'thread.aside': { machine: MachineEntry; thread: ThreadInfo }
  'editor.side': EditorSlotProps
  'editor.bar': EditorSlotProps
  'overlay': Record<string, never>
}

/** A tool call in the transcript. `result` is there once it finished; `live` while it runs. */
/** What a pane is drawn with: where it is, and its own params. */
export type PaneProps = { machine: MachineEntry; thread: ThreadInfo; pane: Pane }
/** A kind of pane: its default tab title and what draws it. */
/** A kind of pane. `title` names its tab when the pane wasn't given one: fixed, or from the pane (its params, say). */
export type PaneKind = {
  title: string | ((pane: Pane) => string | undefined)
  component: ComponentType<PaneProps>
  /** Offered in the thread's pane menu: it shows something without being given params. */
  menu?: boolean
  /** Files it shows, given `{ path }`: a file opened from the thread opens in the first kind that takes it. */
  opens?: (path: string) => boolean
  /** It shows folders, given `{ path }` (in the thread's folder; `''` for the folder itself): a folder a thread names opens in it. */
  folders?: boolean
  /** Its width to start with, as a share of the row (0.5 when unset); dragging its edge changes it for that pane. */
  width?: number
}

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
  /** Draw calls to the tool `name` (of the extension's daemon half, or any other). */
  tool(name: string, component: ComponentType<ToolCallProps>): void
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
}

export type UiExtension = {
  /** The same name as the daemon half, if there is one; the UI uses it to tell whether a machine has that half. */
  name: string
  setup(superego: UiApi): void
}

/** Identity for type inference: `export default defineUiExtension({ name, setup(superego) { … } })`. */
export const defineUiExtension = (extension: UiExtension) => extension

/** Everything the app's extensions registered, in the order they were listed. */
export type Registry = {
  app: AppConfig
  extensions: string[]
  /** `profile`: the folder of the profile whose UI added it; it draws only for that profile's threads. */
  slots: { [S in SlotName]: { component: ComponentType<SlotProps[S]>; order: number; extension: string; profile?: string }[] }
  tools: Map<string, ComponentType<ToolCallProps>>
  /** Pane kinds; `profile`: the folder of the profile that added it. */
  panes: Map<string, (PaneKind & { profile?: string })[]>
  entries: Map<string, ComponentType<EntryProps>>
  work: ((run: WorkRun) => WorkPart[] | undefined)[]
  settings: Map<string, ComponentType<SettingsComponentProps>>
  router: WindowRouter
  appSettings: DeclaredSection[]
  /** Add a profile's UI extensions at runtime (replacing what that profile added before). */
  installProfile(profile: string, extensions: UiExtension[]): void
  /** Changes whenever extensions are added at runtime; `subscribe` to hear it. */
  version: number
  subscribe(listener: () => void): () => void
}

export function createRegistry(app: AppConfig, extensions: UiExtension[], core: (superego: UiApi) => void): Registry {
  const registry: Registry = {
    app, extensions: extensions.map((e) => e.name),
    slots: { 'sidebar': [], 'thread.header': [], 'composer.above': [], 'thread.aside': [], 'editor.side': [], 'editor.bar': [], 'overlay': [] },
    tools: new Map(), panes: new Map(), entries: new Map(), work: [], settings: new Map(), router: createWindowRouter(), appSettings: [],
    version: 0,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
    installProfile(profile, list) {
      for (const slot of Object.keys(registry.slots) as SlotName[]) {
        ;(registry.slots[slot] as { profile?: string }[]).splice(0, Infinity, ...(registry.slots[slot] as { profile?: string }[]).filter((e) => e.profile !== profile))
      }
      for (const [kind, entries] of registry.panes) registry.panes.set(kind, entries.filter((e) => e.profile !== profile))
      for (const extension of list) {
        try { extension.setup(api(extension.name, profile)) } catch (error) { console.error(`Profile extension ${extension.name} failed to start`, error) }
      }
      registry.version++
      for (const listener of listeners) listener()
    },
  }
  const listeners = new Set<() => void>()
  const api = (extension: string, profile?: string): UiApi => ({
    app,
    slot(slot, component, options) {
      // A profile's UI draws in its threads' slots; the sidebar is the app's.
      if (profile && slot === 'sidebar') return console.warn(`Profile extension ${extension} can't fill the sidebar`)
      const list = registry.slots[slot] as Registry['slots'][typeof slot]
      list.push({ component: component as never, order: options?.order ?? 100, extension, ...(profile ? { profile } : {}) })
      list.sort((a, b) => a.order - b.order)
    },
    tool: (name, component) => { registry.tools.set(name, component) },
    entry: (kind, component) => { registry.entries.set(kind, component) },
    work(divide) {
      if (profile) return console.warn(`Profile extension ${extension}: dividing work from a profile's UI isn't supported yet`)
      registry.work.push(divide)
    },
    settings: (ui, component) => { registry.settings.set(ui, component) },
    pane(kind, pane) {
      const list = (registry.panes.get(kind) ?? []).filter((entry) => entry.profile !== profile)
      registry.panes.set(kind, [...list, { ...pane, ...(profile ? { profile } : {}) }])
    },
    dispatch: (id, params, options) => registry.router.dispatch(id, params, { source: extension, ...options }),
    action(action) {
      if (profile) return console.warn(`Profile extension ${extension}: actions from a profile's UI aren't supported yet`)
      if (extension !== 'core' && !action.id.startsWith(`${extension}.`)) throw new Error(`Extension ${extension} must name its actions "${extension}.<name>", not "${action.id}"`)
      registry.router.router.register({ ...action, runs: 'window' })
    },
    appSettings(section) {
      if (profile) return console.warn(`Profile extension ${extension}: app settings from a profile's UI aren't supported yet`)
      for (const setting of section.settings) {
        if (extension !== 'core' && !setting.key.startsWith(`${extension}.`)) throw new Error(`Extension ${extension} must name its settings "${extension}.<key>", not "${setting.key}"`)
      }
      registry.appSettings.push(section)
    },
  })
  core(api('core'))
  for (const extension of extensions) {
    if (!/^[a-z][a-z0-9-]*$/.test(extension.name)) throw new Error(`Extension name "${extension.name}" must be lowercase letters, digits and dashes`)
    extension.setup(api(extension.name))
  }
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

/** Draw every component in `slot`, with `props`. */
export function Slot<S extends SlotName>({ name, props }: { name: S; props: SlotProps[S] }) {
  const registry = useRegistry()
  useSyncExternalStore(registry.subscribe, () => registry.version)
  // A profile's extensions draw only for that profile's threads.
  const profile = (props as { thread?: ThreadInfo }).thread?.profile?.dir
  const entries = (registry.slots[name] as { component: ComponentType<SlotProps[S]>; extension: string; profile?: string }[])
    .filter((entry) => !entry.profile || entry.profile === profile)
  return <>{entries.map(({ component: Component, extension, profile }, index) => <Component key={`${profile ?? ''}${extension}-${index}`} {...props} />)}</>
}

/** A run of work in parts, as the first extension that divides it says; else whole. */
export function divideWork(registry: Registry, run: WorkRun): WorkPart[] {
  for (const divide of registry.work) {
    try {
      const parts = divide(run)
      if (parts) return parts
    } catch (error) { console.error('Dividing work failed', error) }
  }
  return [{ blocks: run.blocks }]
}

/** The pane kind `kind` as `thread` sees it: its profile's own first, else the app's. */
export function paneKind(registry: Registry, kind: string, thread: ThreadInfo): PaneKind | undefined {
  const entries = registry.panes.get(kind) ?? []
  return entries.find((e) => e.profile && e.profile === thread.profile?.dir) ?? entries.find((e) => !e.profile)
}

/** The pane kinds `thread` can open that `take` something: the app's, and its profile's (marked). */
function takers(registry: Registry, thread: ThreadInfo, take: (kind: PaneKind) => boolean) {
  return [...registry.panes.entries()].flatMap(([kind, entries]) => entries
    .filter((e) => take(e) && (!e.profile || e.profile === thread.profile?.dir)).map((e) => ({ kind, profile: Boolean(e.profile) })))
}

/**
 * The pane kind a file opens in, for a thread: its profile's kind that takes the file, else any other that does
 * besides the editor, else the editor, which takes anything.
 */
export function fileKind(registry: Registry, thread: ThreadInfo, path: string): string {
  const found = takers(registry, thread, (e) => Boolean(e.opens?.(path)))
  return (found.find((t) => t.profile) ?? found.find((t) => t.kind !== 'editor'))?.kind ?? 'editor'
}

/** The pane kind a folder opens in, for a thread: its profile's that shows folders, else any other; none, if none does. */
export function folderKind(registry: Registry, thread: ThreadInfo): string | undefined {
  const found = takers(registry, thread, (e) => Boolean(e.folders))
  return (found.find((t) => t.profile) ?? found[0])?.kind
}

/** The panes a thread's menu offers: the built-in ones and its profile's that open without params. */
export function paneMenu(registry: Registry, thread: ThreadInfo): { kind: string; title: string }[] {
  return [...registry.panes.keys()].flatMap((kind) => {
    const found = paneKind(registry, kind, thread)
    if (!found?.menu) return []
    return [{ kind, title: (typeof found.title === 'function' ? found.title({ id: '', kind }) : found.title) ?? kind }]
  })
}
