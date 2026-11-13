// The UI half of an extension: `<pkg>/ui`, listed in the app's renderer entry. It fills named slots in the shell, draws
// tool calls and entries in the transcript, adds pane kinds, custom settings components and actions (with keys), and
// completions and what's drawn with a sent message to the composer.
// Components reach everything else (machines, threads, selection, live values, calls) through the hooks this package
// exports.
//
// Everything an extension registers is owned by it: the registry keeps who added each thing, and an extension's
// teardown removes all of it at once. A profile's UI is owned by that profile on its machine too, and draws only in
// that profile's threads there.
import { createContext, useContext, useSyncExternalStore, type ComponentType, type ReactNode } from 'react'
import type { AppConfig, DeclaredSection, ExtensionAbout, Json, Pane, ProfileRef, SectionInfo, ThreadInfo } from '@superego/protocol'
import type { MachineEntry } from '../shared.ts'
import { createWindowRouter, type Dispatch, type WindowAction, type WindowContext, type WindowRouter } from './actions.tsx'
import { createStore, type Store } from './local-state.ts'
import type { CompletionProvider, CompletionWord, SentWith } from './composer.ts'

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
  /** It shows any file, given `{ path }`: a file no other kind `opens` opens in it (the core's editor). */
  fallback?: boolean
  /** It shows folders, given `{ path }` (in the thread's folder; `''` for the folder itself): a folder a thread names opens in it. */
  folders?: boolean
  /** It shows web pages, given `{ url }`: a web link a thread names opens in it, when asked to open beside. */
  urls?: boolean
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

/** How a tool call stands: not started, running, finished, or failed. */
export type ToolState = 'idle' | 'working' | 'done' | 'error'

/** A tool call as a row's parts see it: the call, and how it stands. */
export type ToolRowCall = ToolCallProps & { state: ToolState }

/**
 * How calls to a tool look, described rather than drawn: the core draws the row (a chevron, the icon, the verb, the
 * subject, its meta) and what it opens to. Each part left out, or returning `undefined`, is the core's default; `null`
 * from `subject` or `body` is nothing.
 */
export type ToolRow = {
  /** Its glyph (a wrench when unset); a spinner replaces it while it runs. */
  icon?: ComponentType<{ size?: number; className?: string; 'aria-hidden'?: boolean }>
  /** Done, working, failed: "Read", "Reading", "Read failed". Unset: the tool's name, and "<name> failed". */
  verbs?: [done: string, working: string, failed: string]
  /** What it acted on, after the verb. Text shows in the mono face (a path, a command); a node as itself (a thread). Default: its `command`, `path` or `pattern`, else its arguments. */
  subject?: (call: ToolRowCall) => ReactNode
  /** Lines it added and removed: shown in the row, and summed in its run's line and its turn's. */
  stat?: (call: ToolRowCall) => { added: number; removed: number } | undefined
  /** A little more at the row's end: "12 lines". */
  meta?: (call: ToolRowCall) => ReactNode
  /** What the row opens to. Default: its output (cut to a dozen lines, or the error it ended with). */
  body?: (call: ToolRowCall) => ReactNode
  /** Said of `count` calls in a run's line ("Read 2 files and ran a command"): "read 2 files". Default: "used <name>". */
  phrase?: (count: number) => string
  /** The file a call was about: a run whose weightiest kind is one such call names it ("Edited src/a.ts", its done verb). */
  file?: (args: Record<string, unknown>) => string | undefined
  /** Which kind a run's line leads with, and whose icon it shows: the heaviest (edits 4, writes 3, commands 2, reads 1; 0 when unset). */
  weight?: number
}

/**
 * Where a link is: the thread it's in (on its machine), and what that place can open. In a thread's messages and a file
 * shown beside one; elsewhere (a settings page, say) nothing but `{}`.
 */
export type LinkWhere = {
  machine?: string
  thread?: ThreadInfo
  /** Open a file or folder by the name the text gives it (from the thread's folder, or beside the file it's in); resolves to why it couldn't. */
  openFile?(name: string): Promise<string | undefined>
  /** Open a web page in a pane beside the thread; there only where some pane kind shows web pages. */
  openUrl?(url: string): void
}

/** A link a handler draws: where it goes, what it says (inline code, for `code`), and a way to follow it. */
export type LinkProps = {
  href: string
  children: ReactNode
  /** It's inline code that reads as something (a path), not a Markdown link. */
  code: boolean
  /** The link's own title, if it gave one. */
  title?: string
  where: LinkWhere
  /** Follow it, as a click does (`beside`: ⌘-click); resolves to why it couldn't, if it couldn't. */
  open(beside: boolean): Promise<string | undefined>
}

/**
 * Links of a kind, claimed: what they look like in Markdown and what following one does (a click, or ⌃O's list).
 * `[[wikilinks]]` come as `wikilink:<target, URI-encoded>`.
 */
export type LinkHandler = {
  /**
   * Which: a scheme (`'thread:'`), a pattern of the href, or a test that sees inline code too (`kind: 'code'`, its text
   * as `href`) and where the link is.
   */
  match: string | RegExp | ((href: string, kind: 'link' | 'code', where: LinkWhere) => boolean)
  /** Following one: resolves to why it couldn't, if it couldn't. `beside`: ⌘-click, or ⌘⏎ in the list. */
  open(href: string, how: LinkWhere & { beside: boolean; kind: 'link' | 'code' }): void | string | undefined | Promise<string | void | undefined>
  /** How it's drawn. Default: a link that follows it, struck through with why when it couldn't. */
  render?: ComponentType<LinkProps>
  /** Where it goes, in a line (⌃O's list). Default: the href. */
  target?(href: string, kind: 'link' | 'code'): string
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
   * How calls to the tool `name` look (of the extension's daemon half, or any other): described (a `ToolRow`: icon,
   * verbs, subject, body), or drawn whole by a component of its own. `fold: false` keeps them out of the fold a run of
   * work closes into: they show under it, open, as what the agent showed you (images, say).
   */
  tool(name: string, view: ComponentType<ToolCallProps> | ToolRow, options?: { fold?: boolean }): void
  entry(kind: string, component: ComponentType<EntryProps>): void
  /**
   * Claim links of a kind (`thread:`, files, web pages): how they look in Markdown and what following one does. A
   * profile's are asked first, then the app's extensions', then the core's (threads, files, web pages).
   */
  link(handler: LinkHandler): void
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
  /** The composer of a thread. */
  composer: {
    /**
     * Complete a word as it's typed (`$co` → `$commit`): the first provider that finds a word at the caret offers its
     * items in a menu over the box.
     */
    complete<W extends CompletionWord>(provider: CompletionProvider<W>): void
    /**
     * Draw what this extension put in sent messages (by a submit transform, its daemon half's) under each one, and
     * leave those blocks out of its text. Drawn for a thread that goes without the extension now too: it went then.
     */
    sentWith<T>(sent: SentWith<T>): void
  }
}

/**
 * A UI half: what the extension is (`ExtensionAbout`, the same as its daemon half's: spread one declaration into both),
 * and its setup. An optional extension's UI draws nothing for a thread that goes without it (`ThreadInfo.without`),
 * and its actions aren't offered while one is shown.
 */
export type UiExtension = ExtensionAbout & {
  setup(superego: UiApi): void
}

/** Identity for type inference: `export default defineUiExtension({ name, setup(superego) { … } })`. */
export const defineUiExtension = (extension: UiExtension) => extension

/**
 * Who registered something: an extension, whether it's optional (a thread can go without it), and for a profile's UI,
 * that profile on its machine (`profileScope`).
 */
type Owner = { extension: string; optional: boolean; profile?: string }
type Owned<T> = T & { owner: Owner }

/** A thread as lookups see it: on a machine, maybe with a profile. */
export type Where = { machine: string; thread: ThreadInfo }

/** A profile's UI, as the registry tells profiles apart: by machine and folder (the same path on two machines is two). */
export const profileScope = (machine: string, profile: ProfileRef) => `${machine}\u0000${profile.dir}`
const scopeOf = (where: Where | undefined) => where?.thread.profile ? profileScope(where.machine, where.thread.profile) : undefined

/** Everything the app's extensions registered, in the order they were listed, each with its owner. */
export type Registry = {
  app: AppConfig
  /** What the app's extensions are, as each declares itself: told to every machine, so UI-only ones are known there. */
  extensions: ExtensionAbout[]
  slots: { [S in SlotName]: Owned<{ component: ComponentType<SlotProps[S]>; order: number }>[] }
  /** Drawn by a `component`, or described by a `row`. `fold: false`: its calls show outside the fold of their run of work. */
  tools: Owned<{ name: string; component?: ComponentType<ToolCallProps>; row?: ToolRow; fold: boolean }>[]
  entries: Owned<{ kind: string; component: ComponentType<EntryProps> }>[]
  links: Owned<LinkHandler>[]
  panes: Owned<PaneKind & { kind: string }>[]
  work: Owned<{ divide: (run: WorkRun) => WorkPart[] | undefined }>[]
  settings: Owned<{ ui: string; component: ComponentType<SettingsComponentProps> }>[]
  router: WindowRouter
  appSettings: Owned<DeclaredSection>[]
  completions: Owned<CompletionProvider<any>>[]
  sentWith: Owned<SentWith>[]
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
    app, extensions: extensions.map(({ name, title, description, required }) => ({ name, ...(title ? { title } : {}), ...(description ? { description } : {}), ...(required ? { required } : {}) })),
    slots: { 'sidebar': [], 'rail': [], 'thread.header': [], 'composer.above': [], 'thread.aside': [], 'editor.side': [], 'editor.bar': [], 'overlay': [] },
    tools: [], entries: [], links: [], panes: [], work: [], settings: [], router: createWindowRouter(), appSettings: [], completions: [], sentWith: [],
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
    // The core's and a profile's own aren't the machine's to turn off; a bundled extension is, unless it's required.
    const owner: Owner = { extension: extension.name, optional: !profile && extension.name !== 'core' && !extension.required, ...(profile ? { profile } : {}) }
    // A name is the extension's prefix: one of each among the app's, and a profile's can't take one of theirs.
    if (teardowns.has(ownerKey(owner)) || (profile && teardowns.has(`/${extension.name}`))) throw new Error(`An extension named ${extension.name} is already set up`)
    const undo: (() => void)[] = []
    const add = <T,>(list: Owned<T>[], item: T) => {
      const entry = { ...item, owner } as Owned<T>
      list.push(entry)
      undo.push(() => { const at = list.indexOf(entry); if (at >= 0) list.splice(at, 1) })
      return entry
    }
    /** A name of its own: `<extension>` or `<extension>.<more>` (the core's are any). */
    const own = (name: string, what: string) => {
      if (extension.name !== 'core' && name !== extension.name && !name.startsWith(`${extension.name}.`)) throw new Error(`Extension ${extension.name} must name its ${what} "${extension.name}.<name>", not "${name}"`)
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
        // A profile's UI draws in its threads' slots; the sidebar, the rail and the overlay are the app's, with no thread.
        if (profile && (slot === 'sidebar' || slot === 'rail' || slot === 'overlay')) return console.warn(`Profile extension ${extension.name} can't fill the ${slot}`)
        const list = registry.slots[slot] as Owned<{ component: ComponentType<SlotProps[typeof slot]>; order: number }>[]
        add(list, { component: component as never, order: options?.order ?? 100 })
        list.sort((a, b) => a.order - b.order)
      },
      tool: (name, view, options) => unique(registry.tools, 'name', { name, ...(isComponent(view) ? { component: view } : { row: view }), fold: options?.fold !== false }, 'tool'),
      entry(kind, component) {
        own(kind, 'entry kinds')
        unique(registry.entries, 'kind', { kind, component }, 'entry kind')
      },
      link: (handler) => { add(registry.links, handler) },
      work(divide) {
        if (profile) return console.warn(`Profile extension ${extension.name}: dividing work from a profile's UI isn't supported yet`)
        add(registry.work, { divide })
      },
      settings(ui, component) {
        own(ui, 'settings sections')
        unique(registry.settings, 'ui', { ui, component }, 'settings section')
      },
      pane: (kind, pane) => unique(registry.panes, 'kind', { ...pane, kind }, 'pane kind'),
      dispatch: (id, params, options) => registry.router.dispatch(id, params, { source: extension.name, ...options }),
      action(action) {
        if (profile) return console.warn(`Profile extension ${extension.name}: actions from a profile's UI aren't supported yet`)
        if (extension.name !== 'core' && !action.id.startsWith(`${extension.name}.`)) throw new Error(`Extension ${extension.name} must name its actions "${extension.name}.<name>", not "${action.id}"`)
        // Not offered while a thread that goes without this extension is shown.
        const { when } = action
        const has = (c: WindowContext) => !(owner.optional && c.selection && c.threadOf(c.selection)?.without?.includes(owner.extension))
        undo.push(registry.router.register(owner.optional ? { ...action, when: (c) => has(c) && (when?.(c) ?? true) } : action))
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
        // A profile's is kept apart for each profile on each machine: the same profile folder elsewhere is another.
        return createStore(profile ? `profile.${encodeURIComponent(profile)}.${key}` : key, initial, options)
      },
      composer: {
        complete: (provider) => { add(registry.completions, provider as CompletionProvider<any>) },
        sentWith: (sent) => { add(registry.sentWith, sent as SentWith) },
      },
    }
    const teardown = () => {
      for (const step of undo.splice(0).reverse()) step()
      teardowns.delete(ownerKey(owner))
    }
    teardowns.set(ownerKey(owner), teardown)
    try { extension.setup(api) } catch (error) { teardown(); throw error }
  }

  setUp({ name: 'core', required: true, setup: core })
  for (const extension of extensions) setUp(extension)
  return registry
}

/** A component (a function, or `memo`/`forwardRef`'s object) rather than a `ToolRow`. */
const isComponent = (view: ComponentType<ToolCallProps> | ToolRow): view is ComponentType<ToolCallProps> =>
  typeof view === 'function' || '$$typeof' in view

const RegistryContext = createContext<Registry | undefined>(undefined)
export const RegistryProvider = ({ registry, children }: { registry: Registry; children: ReactNode }) =>
  <RegistryContext.Provider value={registry}>{children}</RegistryContext.Provider>

export function useRegistry(): Registry {
  const registry = useContext(RegistryContext)
  if (!registry) throw new Error('superego hooks need mountApp')
  return registry
}

/** The registry, where there is one (Markdown drawn outside the app has none). */
export const useOptionalRegistry = () => useContext(RegistryContext)

/** The app this UI belongs to. */
export const useApp = () => useRegistry().app

/**
 * What `where` sees of `list`: the app's, but not those of optional extensions its thread goes without; and its own
 * profile's (only that profile's, on that machine).
 */
export const seenIn = <T,>(list: Owned<T>[], where: Where | undefined) => {
  const scope = scopeOf(where)
  const without = where?.thread.without
  return list.filter(({ owner }) => owner.profile ? owner.profile === scope : !(owner.optional && without?.includes(owner.extension)))
}

/** The composer's completion providers for `where`, in the order registered. */
export const completionsIn = (registry: Registry, where: Where) => seenIn(registry.completions, where)

/**
 * What draws sent messages' blocks for `where`: those of the app's extensions (even one its thread goes without now,
 * since it went with the message then), and its own profile's.
 */
export const sentWithIn = (registry: Registry, where: Where) => {
  const scope = scopeOf(where)
  return registry.sentWith.filter(({ owner }) => !owner.profile || owner.profile === scope)
}

/** The one of `list` that `where` sees by `match`: its profile's own first, else the app's. */
function lookUp<T>(list: Owned<T>[], where: Where | undefined, match: (entry: T) => boolean): Owned<T> | undefined {
  const found = seenIn(list, where).filter(match)
  return found.find((entry) => entry.owner.profile) ?? found[0]
}

/** Draw every component in `slot`, with `props`. */
export function Slot<S extends SlotName>({ name, props }: { name: S; props: SlotProps[S] }) {
  const registry = useRegistry()
  useSyncExternalStore(registry.subscribe, () => registry.version)
  const { machine, thread } = props as { machine?: MachineEntry; thread?: ThreadInfo }
  const entries = seenIn(registry.slots[name] as Owned<{ component: ComponentType<SlotProps[S]>; order: number }>[], machine && thread ? { machine: machine.id, thread } : undefined)
  return <>{entries.map(({ component: Component, owner }, index) => <Component key={`${owner.profile ?? ''}/${owner.extension}-${index}`} {...props} />)}</>
}

/** How calls to the tool `name` are drawn for `where`, if an extension draws them whole. */
export const toolView = (registry: Registry, name: string, where: Where) => lookUp(registry.tools, where, (t) => t.name === name)?.component

/** How calls to the tool `name` are described for `where`: what an extension (or the core) said, else nothing (the defaults). */
export const toolRow = (registry: Registry, name: string, where: Where): ToolRow => lookUp(registry.tools, where, (t) => t.name === name)?.row ?? {}

/** Whether calls to the tool `name` show outside the fold of their run, for `where` (an extension said `fold: false`). */
export const unfoldedTool = (registry: Registry, name: string, where: Where) => lookUp(registry.tools, where, (t) => t.name === name)?.fold === false

/**
 * The handler that claims `href` (a link's, or inline code's text) for `where`: its profile's first, then the app's
 * extensions' in order, then the core's.
 */
export function linkHandler(registry: Registry, href: string, kind: 'link' | 'code', where: LinkWhere): LinkHandler | undefined {
  const seen = seenIn(registry.links, where.machine && where.thread ? { machine: where.machine, thread: where.thread } : undefined)
  const claims = ({ match }: LinkHandler) => typeof match === 'string' ? kind === 'link' && href.toLowerCase().startsWith(match.toLowerCase())
    : match instanceof RegExp ? kind === 'link' && match.test(href)
    : match(href, kind, where)
  const rank = (owner: Owner) => owner.profile ? 0 : owner.extension === 'core' ? 2 : 1
  return [...seen].sort((a, b) => rank(a.owner) - rank(b.owner)).find(claims)
}

/** How entries of `kind` are drawn for `where`, if an extension draws them. */
export const entryView = (registry: Registry, kind: string, where: Where) => lookUp(registry.entries, where, (e) => e.kind === kind)?.component

/** The component under the settings section that names `ui`, on `target` (a machine, or 'app'): a profile's there first, as lookups take it. */
export function settingsView(registry: Registry, ui: string, target: string) {
  const found = registry.settings.filter((s) => s.ui === ui && (!s.owner.profile || s.owner.profile.startsWith(`${target}\u0000`)))
  return (found.find((s) => s.owner.profile) ?? found[0])?.component
}

/** A run of work in parts, as the first extension (that `where` has) that divides it says; else whole. */
export function divideWork(registry: Registry, where: Where, run: WorkRun): WorkPart[] {
  for (const { divide } of seenIn(registry.work, where)) {
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
 * The pane kind a file opens in, for a thread: its profile's kind that takes the file, else any other that does, else
 * one that takes any file (`fallback`, its profile's first); none, if nothing here shows files.
 */
export function fileKind(registry: Registry, where: Where, path: string): string | undefined {
  const seen = seenIn(registry.panes, where)
  const first = (list: typeof seen) => (list.find((p) => p.owner.profile) ?? list[0])?.kind
  return first(seen.filter((p) => !p.fallback && p.opens?.(path))) ?? first(seen.filter((p) => p.fallback))
}

/** The pane kind a folder opens in, for a thread: its profile's that shows folders, else any other; none, if none does. */
export function folderKind(registry: Registry, where: Where): string | undefined {
  const found = seenIn(registry.panes, where).filter((p) => p.folders)
  return (found.find((p) => p.owner.profile) ?? found[0])?.kind
}

/** The pane kind a web page opens in, for a thread: its profile's that shows web pages, else any other; none, if none does. */
export function urlKind(registry: Registry, where: Where): string | undefined {
  const found = seenIn(registry.panes, where).filter((p) => p.urls)
  return (found.find((p) => p.owner.profile) ?? found[0])?.kind
}

/**
 * The panes a thread shows: all it has open but those of a kind only an extension it goes without draws. They're kept
 * with the thread, and show again once it has that extension back.
 */
export function shownPanes(registry: Registry, where: Where): Pane[] {
  const gone = (kind: string) => !paneKind(registry, kind, where) && registry.panes.some((p) => p.kind === kind && p.owner.optional && where.thread.without?.includes(p.owner.extension))
  return (where.thread.panes ?? []).filter((pane) => !gone(pane.kind))
}

/** The panes a thread's menu offers: the app's and its profile's that open without params. */
export function paneMenu(registry: Registry, where: Where): { kind: string; title: string }[] {
  const kinds = [...new Set(seenIn(registry.panes, where).map((p) => p.kind))]
  return kinds.flatMap((kind) => {
    const found = paneKind(registry, kind, where)
    if (!found?.menu) return []
    return [{ kind, title: (typeof found.title === 'function' ? found.title({ id: '', kind }) : found.title) ?? kind }]
  })
}
