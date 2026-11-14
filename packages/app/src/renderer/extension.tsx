// The UI half of an extension: `<pkg>/ui`, listed in the app's renderer entry. It declares views (which the layout puts
// in the shell's places: see layout.ts), fills named slots where behaviour decides the place, draws
// tool calls and entries in the transcript, adds pane kinds, custom settings components and actions (with keys), and
// completions and what's drawn with a sent message to the composer. It hears what happens in the window (a thread's
// status changing, the thread shown changing, the window's focus) through `on`.
// Components reach everything else (machines, threads, selection, live values, calls) through the hooks this package
// exports.
//
// Everything an extension registers is owned by it: the registry keeps who added each thing, and an extension's
// teardown removes all of it at once. A profile's UI is owned by that profile on its machine too, and draws only in
// that profile's threads there.
import { createContext, Fragment, useContext, useEffect, useMemo, useState, useSyncExternalStore, type AnchorHTMLAttributes, type ComponentType, type ReactNode } from 'react'
import { contractProblem } from '@superego/protocol'
import type { AppConfig, DataViewInfo, DeclaredSection, ExtensionAbout, Json, Pane, ProfileRef, ProviderRejection, SectionInfo, SettingsSnapshot, Status, ThreadInfo } from '@superego/protocol'
import type { MachineEntry } from '../shared.ts'
import type { Selection } from './state.tsx'
import { createWindowRouter, type Dispatch, type WindowAction, type WindowContext, type WindowRouter } from './actions.tsx'
import { useSettings, watched } from './client.ts'
import { createStore, type Store } from './local-state.ts'
import { isLayout, LAYOUT, PLACES, resolveLayout, THREAD_PLACES, type Layout, type Place, type Placed, type Placement } from './layout.ts'
import type { CompletionProvider, CompletionWord, SentWith } from './composer.ts'
import { dataIcon, DataViewBody } from './data-views.tsx'

/**
 * Where an extension can put UI by itself: places whose occupant behaviour decides, so the layout doesn't move them (a
 * question card sits on the composer it asks for).
 */
export type BehaviourSlot =
  /** Among the chips that say where a thread works, after the title's: a branch, say. Draw a `titlebar__chip`. */
  | 'thread.crumb'
  /** Above the composer: things waiting on the user, suggestions. */
  | 'composer.above'
  /** Beside a file being edited: a file tree, an outline. `open` shows another file there (`beside`: in a pane of its own). */
  | 'editor.side'
  /** In a file editor's bar: small buttons. */
  | 'editor.bar'
  /** Always there, over everything: an extension's own dialogs (a quick open), drawn while it wants them. */
  | 'overlay'

/**
 * Slots that are places now: `slot()` with one of these declares a view (`<extension>.<slot>`) that the layout puts
 * there by default. `superego.view` says more (a title, an icon, other places it fits).
 */
const VIEW_SLOTS = { 'sidebar': 'space', 'rail': 'rail', 'footer': 'drawer', 'thread.header': 'header', 'thread.aside': 'aside' } as const satisfies Record<string, Place>
type ViewSlot = keyof typeof VIEW_SLOTS

/** Where `slot()` can put UI: a behaviour slot, or one of the places it used to name (see `VIEW_SLOTS`). */
export type SlotName = BehaviourSlot | ViewSlot

/** What a slot beside a file editor gets: the file, and a way to show another. */
export type EditorSlotProps = { machine: MachineEntry; thread: ThreadInfo; path: string; open(path: string, options?: { beside?: boolean }): void }

export type SlotProps = {
  'sidebar': Record<string, never>
  'rail': Record<string, never>
  'footer': Record<string, never>
  'thread.header': { machine: MachineEntry; thread: ThreadInfo }
  'thread.crumb': { machine: MachineEntry; thread: ThreadInfo }
  'composer.above': { machine: MachineEntry; thread: ThreadInfo }
  'thread.aside': { machine: MachineEntry; thread: ThreadInfo }
  'editor.side': EditorSlotProps
  'editor.bar': EditorSlotProps
  'overlay': Record<string, never>
}

/** What a view needs to be drawn: nothing but the window, or a thread. */
export type ViewContext = 'window' | 'thread'

/**
 * What a view is drawn with: the place it's in, and for a thread view the thread (in a pane, the pane's; in a space,
 * the one shown).
 */
export type ViewProps<C extends ViewContext = ViewContext> = C extends 'thread'
  ? { place: Place; machine: MachineEntry; thread: ThreadInfo }
  : { place: Place }

/** What a space draws in the rail instead of the button that opens it: whether it's the open one, and a way to show it or not. */
export type SpaceRailProps = { open: boolean; show(open?: boolean): void }

/**
 * A view: UI an extension offers, which the layout puts in places (see layout.ts). `fits` says which places it can be
 * drawn in; `default` where it goes unless the user's layout says otherwise (none: offered, not placed).
 */
export type View<C extends ViewContext = ViewContext> = {
  title: string
  icon?: ComponentType<{ size?: number; 'aria-hidden'?: boolean }>
  /** `thread`: drawn only where there's a thread (aside, pane, header; in a space, the one shown). */
  context: C
  /** The places it can be drawn in. A `thread` view that fits `pane` is a pane kind too, of its id. */
  fits: Place[]
  default?: Placement
  /** On a phone or narrow window, where it goes by default instead (unset: as wide). */
  narrow?: Placement
  /** Where it goes by default while no view is in `space`: what stands in for a sidebar (the core's thread picker). */
  withoutSpaces?: Placement
  /** Order among the views in a place (100 when unset; then as registered); the user's layout comes first. */
  order?: number
  component: ComponentType<ViewProps<C>>
  /** As a `space`: what it draws in the rail instead of a button with its icon (a list folded into dots). */
  rail?: ComponentType<SpaceRailProps>
  /** As a pane: its width to start with, as a share of the row. */
  width?: number
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

/**
 * A field of the New thread dialog: what it asks, on the machine and in the folder picked. Its value goes to
 * `thread.create` as `options[<extension>]`, for the extension's `creating` hook; undefined sends nothing.
 */
export type NewThreadFieldProps = { machine: MachineEntry; cwd: string; value: Json | undefined; onChange(value: Json | undefined): void }

export type NewThreadField = {
  component: ComponentType<NewThreadFieldProps>
  /** Its value for a thread started beside `thread` (like it, ⌘N): undefined, none. */
  from?(thread: ThreadInfo): Json | undefined
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
/** A link's attributes besides where it goes, what it says and its title. */
export type LinkAttributes = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href' | 'children' | 'title'>

export type LinkProps = {
  href: string
  children: ReactNode
  /** It's inline code that reads as something (a path), not a Markdown link. */
  code: boolean
  /** The link's own title, if it gave one. */
  title?: string
  /** Its other attributes, as the HTML gave them (`class`, `id`, `aria-*`): for a drawing of it as a link to keep. */
  attributes?: LinkAttributes
  where: LinkWhere
  /** Follow it, as a click does (`beside`: ⌘-click); resolves to why it couldn't, if it couldn't. */
  open(beside: boolean): Promise<string | undefined>
}

/**
 * Links of a kind, claimed: what they look like in Markdown and what following one does (a click, or ⌃O's list).
 * `[[Note#Heading|alias]]` comes as `wikilink:Note#Heading` (each part URI-encoded; `parseWikilink` takes it apart), its
 * alias as its text. Asked in turn: a thread's profile's, then the app's extensions', then the core's (files, web pages).
 */
export type LinkHandler = {
  /**
   * Which: a scheme (`'thread:'`), a pattern of the href, or a test that sees inline code too (`kind: 'code'`, its text
   * as `href`) and where the link is.
   */
  match: string | RegExp | ((href: string, kind: 'link' | 'code', where: LinkWhere) => boolean)
  /**
   * The scheme its links are of (`'thread'`), when `match` is a pattern or a test: HTML files keep links of the schemes
   * handlers claim, and drop others they don't know. A `match` of `'scheme:'` says it already.
   */
  scheme?: string
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

/** What the window tells extensions as it happens (`superego.on`). */
export type WindowEvents = {
  /**
   * A thread's status changed: it was `before`, it's `thread.status` now. `before` is undefined the first time the
   * window sees the thread (as it loads, or a new one). Not for threads that go without the extension listening.
   */
  'thread.status': { machine: string; thread: ThreadInfo; before: Status['state'] | undefined }
  /** The thread shown changed; `selection` undefined when none is. */
  'select': { selection: Selection | undefined; before: Selection | undefined }
  /** The window got or lost the keyboard focus. */
  'focus': { focused: boolean }
  /** The window was shown or hidden: another tab in front, minimised, the screen locked. */
  'visibility': { visible: boolean }
  /**
   * A machine's provider rejected its credentials: once as it happens (not for one rejected before the window
   * opened), however many threads it stops. `rejection.threads` are those waiting so far.
   */
  'auth.rejected': { machine: string; rejection: ProviderRejection }
}
export type WindowEvent = keyof WindowEvents

/** The window as it is now, for listeners: whether it has the focus and shows, and the thread it shows. */
export type WindowState = {
  focused: boolean
  visible: boolean
  selection: Selection | undefined
  /** The thread shown, as the window has it (archived and Ego's too). */
  thread: ThreadInfo | undefined
}

export type UiApi = {
  app: AppConfig
  /**
   * A view, `<extension>.<name>`: UI that the layout puts in the places it fits (a space in the rail, beside the thread,
   * the pane menu, the title bar), by default where `default` says. The user's layout (`app.layout`) can move or hide
   * it. A profile's views fit only the places that show a thread, and only its own threads.
   */
  view<C extends ViewContext>(id: string, view: View<C>): void
  /**
   * A component in a place in the window, in `order`. In `sidebar`, `rail`, `footer`, `thread.aside` and
   * `thread.header`, it's a view of that place (`<extension>.<slot>`, see `view`), placed there by default.
   */
  slot<S extends SlotName>(slot: S, component: ComponentType<SlotProps[S]>, options?: { order?: number }): void
  /**
   * Hear what happens in the window (see `WindowEvents`): a thread's status changing, the thread shown changing, the
   * window's focus and visibility. Listening stops at teardown, or with the function returned. `window` is how things
   * are now.
   */
  on<E extends WindowEvent>(event: E, listener: (event: WindowEvents[E]) => void): () => void
  window: Readonly<WindowState>
  /** One of the app's settings as it is now (`useAppSetting` in components). */
  appSetting<T extends Json>(key: string): T | undefined
  /**
   * How calls to the tool `name` look (of the extension's daemon half, or any other): described (a `ToolRow`: icon,
   * verbs, subject, body), or drawn whole by a component of its own. `fold: false` keeps them out of the fold a run of
   * work closes into: they show under it, open, as what the agent showed you (images, say).
   */
  tool(name: string, view: ComponentType<ToolCallProps> | ToolRow, options?: { fold?: boolean }): void
  entry(kind: string, component: ComponentType<EntryProps>): void
  /**
   * Claim links of a kind (`thread:`, files, web pages): how they look in Markdown and what following one does. A
   * profile's are asked first, then the app's extensions' (threads'), then the core's (files, web pages).
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
   * A field in the New thread dialog, shown while the machine picked has this extension: what it's set to goes to
   * `thread.create` as `options[<extension>]`, which its daemon half's `creating` hook reads. One per extension.
   */
  newThreadField(field: NewThreadField): void
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
type Owner = { extension: string; optional: boolean; profile?: string; data?: true }
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
  slots: { [S in BehaviourSlot]: Owned<{ component: ComponentType<SlotProps[S]>; order: number }>[] }
  /**
   * The views declared, by id (`<extension>.<name>`): where each goes is the layout's. A machine's data view
   * (`dataViews`) is one too, drawn by the core, with the machines that have it (`machines`).
   */
  views: Owned<View & { id: string; machines?: string[] }>[]
  /** The data views each machine declares (its daemon extensions' `superego.view`), by machine. */
  dataViews: Record<string, DataViewInfo[]>
  /** Take the data views `machine` declares now (none: it's gone, or switched them off). */
  setDataViews(machine: string, views: DataViewInfo[]): void
  /** Drawn by a `component`, or described by a `row`. `fold: false`: its calls show outside the fold of their run of work. */
  tools: Owned<{ name: string; component?: ComponentType<ToolCallProps>; row?: ToolRow; fold: boolean }>[]
  entries: Owned<{ kind: string; component: ComponentType<EntryProps> }>[]
  links: Owned<LinkHandler>[]
  panes: Owned<PaneKind & { kind: string }>[]
  work: Owned<{ divide: (run: WorkRun) => WorkPart[] | undefined }>[]
  settings: Owned<{ ui: string; component: ComponentType<SettingsComponentProps> }>[]
  /** The New thread dialog's fields, by the extension each is of (its `options` key). */
  newThreadFields: Owned<NewThreadField & { name: string }>[]
  router: WindowRouter
  appSettings: Owned<DeclaredSection>[]
  completions: Owned<CompletionProvider<any>>[]
  sentWith: Owned<SentWith>[]
  listeners: Owned<{ event: WindowEvent; listener: (event: never) => void }>[]
  /** The window as it is now: the shell keeps it, through `emit`. */
  window: WindowState
  /**
   * Tell listeners what happened, after updating `window` to match. `thread.status` reaches only listeners whose
   * extension the thread has (and a profile's, only its own threads); a listener that throws is logged and skipped.
   */
  emit<E extends WindowEvent>(event: E, payload: WindowEvents[E]): void
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
    app, extensions: extensions.map(({ name, title, description, required, version, api, capabilities }) => ({
      name, ...(title ? { title } : {}), ...(description ? { description } : {}), ...(required ? { required } : {}),
      ...(version ? { version } : {}), ...(api ? { api } : {}), ...(capabilities?.length ? { capabilities } : {}),
    })),
    slots: { 'thread.crumb': [], 'composer.above': [], 'editor.side': [], 'editor.bar': [], 'overlay': [] },
    views: [], dataViews: {}, tools: [], entries: [], links: [], panes: [], work: [], settings: [], newThreadFields: [], router: createWindowRouter(), appSettings: [], completions: [], sentWith: [], listeners: [],
    window: {
      focused: typeof document === 'undefined' || document.hasFocus(),
      visible: typeof document === 'undefined' || document.visibilityState !== 'hidden',
      selection: undefined, thread: undefined,
    },
    emit(event, payload) {
      if (event === 'focus') registry.window.focused = (payload as WindowEvents['focus']).focused
      if (event === 'visibility') registry.window.visible = (payload as WindowEvents['visibility']).visible
      if (event === 'select') registry.window.selection = (payload as WindowEvents['select']).selection
      const where = event === 'thread.status' ? payload as WindowEvents['thread.status'] : undefined
      const hearing = registry.listeners.filter((l) => l.event === event)
      for (const { listener } of where ? seenIn(hearing, where) : hearing) {
        try { (listener as (payload: unknown) => void)(payload) } catch (error) { console.error(`A ${event} listener failed`, error) }
      }
    },
    version: 0,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
    setDataViews(machine, views) {
      if (JSON.stringify(registry.dataViews[machine] ?? []) === JSON.stringify(views)) return
      registry.dataViews = { ...registry.dataViews, [machine]: views }
      placeDataViews()
      registry.version++
      for (const listener of listeners) listener()
    },
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
    // One whose versions don't read, or that needs an extension API this window isn't, is refused before it runs.
    const problem = contractProblem(extension)
    if (problem) throw new Error(problem)
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
    /** A view, checked: a profile's fit only the places that show one of its threads. */
    const declare = (id: string, view: View) => {
      if (view.fits.some((place) => !PLACES.includes(place))) console.warn(`Extension ${extension.name}: view ${id} fits a place there isn't (${view.fits.join(', ')})`)
      const fits = profile ? view.fits.filter((place) => THREAD_PLACES.includes(place)) : view.fits
      if (!fits.length) return console.warn(`Profile extension ${extension.name}: view ${id} fits no place a profile's UI draws in`)
      unique(registry.views, 'id', { ...view, fits, id }, 'view')
    }
    const api: UiApi = {
      app,
      view(id, view) {
        own(id, 'views')
        declare(id, view as View)
        // A thread view that fits a pane is a pane kind too, of its id: opened from the pane menu while it's placed there.
        if (view.context === 'thread' && view.fits.includes('pane')) {
          const Component = view.component as ComponentType<ViewProps<'thread'>>
          unique(registry.panes, 'kind', {
            kind: id, title: view.title, component: ({ machine, thread }: PaneProps) => <Component place="pane" machine={machine} thread={thread} />,
            ...(view.icon ? { icon: view.icon } : {}), ...(view.width ? { width: view.width } : {}),
          }, 'pane kind')
        }
      },
      slot(slot, component, options) {
        if (slot in VIEW_SLOTS) {
          const place = VIEW_SLOTS[slot as ViewSlot]
          const base = `${extension.name}.${slot}`
          const taken = registry.views.filter((v) => v.owner === owner && (v.id === base || v.id.startsWith(`${base}.`))).length
          const Component = component as ComponentType<object>
          return declare(`${base}${taken ? `.${taken + 1}` : ''}`, {
            title: extension.title ?? extension.name, context: THREAD_PLACES.includes(place) ? 'thread' : 'window', fits: [place], default: place,
            ...(options?.order !== undefined ? { order: options.order } : {}),
            component: ({ place: _place, ...props }: ViewProps) => <Component {...props} />,
          })
        }
        // A profile's UI draws in its threads' slots; the overlay is the app's, with no thread.
        if (profile && slot === 'overlay') return console.warn(`Profile extension ${extension.name} can't fill the ${slot}`)
        const list = registry.slots[slot as BehaviourSlot] as Owned<{ component: ComponentType<never>; order: number }>[]
        add(list, { component: component as never, order: options?.order ?? 100 })
        list.sort((a, b) => a.order - b.order)
      },
      on(event, listener) {
        const entry = add(registry.listeners, { event, listener: listener as (event: never) => void })
        return () => { const at = registry.listeners.indexOf(entry); if (at >= 0) registry.listeners.splice(at, 1) }
      },
      get window() { return registry.window },
      appSetting: (key) => watched<SettingsSnapshot>('app', 'settings.watch', {})?.values[key] as never,
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
      pane(kind, pane) {
        unique(registry.panes, 'kind', { ...pane, kind }, 'pane kind')
        // Offered in the pane menu: a view of the pane menu, of the kind's name, placed there by default.
        if (pane.menu) {
          const title = typeof pane.title === 'function' ? pane.title({ id: '', kind }) ?? kind : pane.title
          declare(kind, { title, ...(pane.icon ? { icon: pane.icon } : {}), context: 'thread', fits: ['pane'], default: 'pane', component: () => null })
        }
      },
      newThreadField(field) {
        // The dialog has no thread yet: a profile's UI has nowhere to draw.
        if (profile) return console.warn(`Profile extension ${extension.name}: New thread fields from a profile's UI aren't supported yet`)
        unique(registry.newThreadFields, 'name', { ...field, name: extension.name }, 'New thread field')
      },
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

  /**
   * The machines' data views, as views: one per id however many machines have it (a profile's, one per profile on
   * each machine), after the extensions' own; one an extension's UI declares already is theirs. Made again as a
   * machine's change.
   */
  function placeDataViews() {
    const drop = <T,>(list: Owned<T>[]) => { for (let i = list.length - 1; i >= 0; i--) if (list[i]!.owner.data) list.splice(i, 1) }
    drop(registry.views)
    drop(registry.panes)
    for (const [machine, infos] of Object.entries(registry.dataViews)) {
      for (const info of infos) {
        for (const profile of info.profiles?.map((dir) => profileScope(machine, { dir } as ProfileRef)) ?? [undefined]) {
          const same = registry.views.find((v) => v.id === info.id && v.owner.profile === profile)
          if (same) {
            if (same.owner.data && !same.machines!.includes(machine)) same.machines!.push(machine)
            else if (!same.owner.data) console.warn(`Data view ${info.id} on ${machine}: ${same.owner.extension}'s UI declares it already; keeping that one`)
            continue
          }
          const owner: Owner = { extension: info.extension, optional: !profile, ...(profile ? { profile } : {}), data: true }
          const icon = dataIcon(info.icon)
          const component = (props: ViewProps) => <DataViewBody id={info.id} {...props} />
          registry.views.push({
            id: info.id, title: info.title, ...(icon ? { icon } : {}), context: info.context, fits: info.fits,
            ...(info.default !== undefined ? { default: info.default } : {}), ...(info.narrow !== undefined ? { narrow: info.narrow } : {}),
            ...(info.order !== undefined ? { order: info.order } : {}), component, machines: [machine], owner,
          })
          // A pane kind of its id, unless one (a UI half's, with no view of the id) is drawn already.
          if (info.context === 'thread' && info.fits.includes('pane') && !registry.panes.some((p) => p.kind === info.id && p.owner.profile === profile)) {
            registry.panes.push({ kind: info.id, title: info.title, ...(icon ? { icon } : {}), component: ({ machine, thread }: PaneProps) => <DataViewBody id={info.id} place="pane" machine={machine} thread={thread} />, owner })
          }
        }
      }
    }
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
export function Slot<S extends BehaviourSlot>({ name, props }: { name: S; props: SlotProps[S] }) {
  const registry = useRegistry()
  useSyncExternalStore(registry.subscribe, () => registry.version)
  const { machine, thread } = props as { machine?: MachineEntry; thread?: ThreadInfo }
  const entries = seenIn(registry.slots[name] as Owned<{ component: ComponentType<SlotProps[S]> }>[], machine && thread ? { machine: machine.id, thread } : undefined)
  return <>{entries.map(({ component: Component, owner }, index) => <Component key={`${owner.profile ?? ''}/${owner.extension}-${index}`} {...props} />)}</>
}

// ── Views in places ──────────────────────────────────────────────────────────────────────────────────────────────────

/** Whether the window is phone-narrow: no rail, the space a drawer, the narrow layout. */
export function useNarrow() {
  const query = '(max-width: 599px)'
  const [narrow, setNarrow] = useState(() => matchMedia(query).matches)
  useEffect(() => {
    const list = matchMedia(query)
    const change = () => setNarrow(list.matches)
    list.addEventListener('change', change)
    return () => list.removeEventListener('change', change)
  }, [])
  return narrow
}

/** The user's layout (`app.layout`), as stored; anything not shaped as one is none. */
export const layoutOf = (value: Json | undefined): Layout | undefined => isLayout(value) ? value : undefined

/**
 * The views `where` sees (a thread's places), one of each id, as its own scope declares it: its profile's (that profile
 * on that machine) over the app's, a data view only from its machine, none of an optional extension its thread goes
 * without. Without `where` (the window's places), the app's. An id is a view's name, one in the layout whatever the
 * scope; what it is, where it fits and goes by default are its declaration's here.
 */
export function scopedViews(registry: Registry, where?: Where): Registry['views'] {
  // A data view shows a thread only from that thread's machine: another's has nothing to say of it.
  const on = (view: Registry['views'][number]) => !where || !view.machines || view.machines.includes(where.machine)
  const byId = new Map<string, Registry['views'][number]>()
  for (const view of seenIn(registry.views, where)) {
    if (!on(view)) continue
    const had = byId.get(view.id)
    if (!had || (!had.owner.profile && view.owner.profile)) byId.set(view.id, view)
  }
  return [...byId.values()]
}

/** Where every view `where` sees goes, place by place (see `scopedViews`): resolved from those, so each is there once. */
export const placedFor = (registry: Registry, layout: Layout | undefined, { narrow = false, where }: { narrow?: boolean; where?: Where | undefined } = {}): Placed =>
  resolveLayout(scopedViews(registry, where), layout, { narrow })

/** Where every view goes now for `where` (the window's, without), place by place: the views' defaults and the user's layout, narrow on a phone. */
export function useLayout(where?: Where): { placed: Placed; narrow: boolean } {
  const registry = useRegistry()
  const version = useSyncExternalStore(registry.subscribe, () => registry.version)
  const stored = useSettings('app', true)?.values[LAYOUT]
  const narrow = useNarrow()
  const key = JSON.stringify(stored ?? null)
  const scope = where ? `${where.machine}\u0000${where.thread.profile?.dir ?? ''}\u0000${where.thread.without?.join() ?? ''}` : ''
  const placed = useMemo(() => placedFor(registry, layoutOf(stored), { narrow, where }), [version, key, narrow, scope])
  return { placed, narrow }
}

/** The views in `place` for `where` (see `scopedViews`), in the layout's order; `placed` resolved for the same `where`. */
export function viewsIn(registry: Registry, placed: Placed, place: Place, where?: Where) {
  const views = new Map(scopedViews(registry, where).map((view) => [view.id, view]))
  return placed[place].flatMap((id) => views.get(id) ?? [])
}

/** Draw the views in a place: a thread's (`machine`, `thread`), or the window's; each in its `frame`, if given (its menu). */
export function PlacedViews({ place, machine, thread, frame }: {
  place: Place; machine?: MachineEntry; thread?: ThreadInfo; frame?: (view: View & { id: string }, drawn: ReactNode) => ReactNode
}) {
  const registry = useRegistry()
  const where = machine && thread ? { machine: machine.id, thread } : undefined
  const { placed } = useLayout(where)
  // A view that needs a thread isn't drawn without one.
  return <>{viewsIn(registry, placed, place, where).filter((view) => view.context === 'window' || where).map((view) => {
    const Component = view.component as ComponentType<ViewProps>
    const drawn = <Component place={place} {...(machine && thread ? { machine, thread } : {})} />
    return <Fragment key={`${view.owner.profile ?? ''}/${view.id}`}>{frame ? frame(view, drawn) : drawn}</Fragment>
  })}</>
}

/** Whether `view` is in `place` now, and a way to put it there or take it out (toggled, unless `on` is given). */
export function usePlacement(view: string, place: Place): [boolean, (on?: boolean) => void] {
  const registry = useRegistry()
  const { placed, narrow } = useLayout()
  // The layer it's seen in: on a phone, the narrow one.
  const toggle = (on?: boolean) => void registry.router.dispatch('layout.place', { view, place, ...(on === undefined ? {} : { on }), ...(narrow ? { narrow } : {}) }, { source: 'layout' }).catch((error) => console.error(error))
  return [placed[place].includes(view), toggle]
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
  const seen = linksSeen(registry, where)
  const claims = ({ match }: LinkHandler) => typeof match === 'string' ? kind === 'link' && href.toLowerCase().startsWith(match.toLowerCase())
    // From the start each time: a /g or /y pattern remembers where it last matched.
    : match instanceof RegExp ? kind === 'link' && ((match.lastIndex = 0), match.test(href))
    : match(href, kind, where)
  const rank = (owner: Owner) => owner.profile ? 0 : owner.extension === 'core' ? 2 : 1
  return [...seen].sort((a, b) => rank(a.owner) - rank(b.owner)).find(claims)
}

/** The link handlers `where` has: its thread's profile's, and the app's but those of extensions the thread goes without. */
const linksSeen = (registry: Registry, where: LinkWhere) => seenIn(registry.links, where.machine && where.thread ? { machine: where.machine, thread: where.thread } : undefined)

/** The schemes `where`'s handlers claim by name (`ticket:` → `ticket`), for its HTML's links to keep. */
export const linkSchemes = (registry: Registry, where: LinkWhere) => [...new Set(linksSeen(registry, where).flatMap(({ match, scheme }) => [
  ...scheme ? [scheme.toLowerCase()] : [],
  ...typeof match === 'string' && /^[a-z][\w+.-]*:$/i.test(match) ? [match.slice(0, -1).toLowerCase()] : [],
]))]

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

/** The panes a thread's menu offers: the views the layout puts in `pane` that it has a kind of, in order. */
export function paneMenu(registry: Registry, placed: Placed, where: Where): { kind: string; title: string }[] {
  return viewsIn(registry, placed, 'pane', where).filter(({ id }) => paneKind(registry, id, where)).map(({ id, title }) => ({ kind: id, title }))
}
