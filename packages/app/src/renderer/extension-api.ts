// The UI half of an extension, as its author writes it: `<pkg>/ui`, listed in the app's renderer entry. It declares
// views (which the layout puts in the shell's places: see shared/layout.ts), fills named slots where behaviour decides
// the place, draws tool calls and entries in the transcript, adds pane kinds, custom settings components and actions
// (with keys), and completions and what's drawn with a sent message to the composer. It hears what happens in the
// window (a thread's status changing, the thread shown changing, the window's focus) through `on`.
// Components reach everything else (machines, threads, selection, live values, calls) through the hooks this package
// exports. What the window does with it all: registry.tsx (who registered what), lookups.ts (what a thread sees of it)
// and placement.tsx (where views are drawn).
import type { AnchorHTMLAttributes, ComponentType, ReactNode } from 'react'
import type { AppConfig, DeclaredSection, ExtensionAbout, Json, Pane, ProviderRejection, SectionInfo, Status, ThreadInfo } from '@superego/protocol'
import type { MachineEntry } from '../shared/bridge.ts'
import type { Selection } from './state.tsx'
import type { SetupFound } from './Setup.tsx'
import type { Dispatch, WindowAction } from './actions.tsx'
import type { Store } from './local-state.ts'
import type { Place, Placement } from '../shared/layout.ts'
import type { CompletionProvider, CompletionWord, SentWith } from './composer.ts'
import type { ImageItem } from './images.tsx'
import type { Theme } from '@superego/ui/themes'

/**
 * Where an extension can put UI by itself: places whose occupant behaviour decides, so the layout doesn't move them (a
 * question card sits on the composer it asks for).
 */
export type BehaviourSlot =
  /** Among the chips that say where a thread works, after the title's: a branch, say. Draw a `header__chip`. */
  | 'header.chips'
  /**
   * After a thread's title in the sidebar's list: a small mark of something about it (its own branch, say). Draw a
   * `thread-badge`, an icon (about 12px) with a `title` for its tooltip; or nothing, as for most threads.
   */
  | 'thread.badge'
  /** Above the composer: things waiting on the user, suggestions. */
  | 'composer.above'
  /** In a thread's details (⌘I), after what the core says of it: what an extension knows of the thread. Draw a `<h5>` and a `<dl>`, or nothing. */
  | 'details.section'
  /** Beside a file being edited: a file tree, an outline. `open` shows another file there (`beside`: in a pane of its own). */
  | 'editor.side'
  /** In a file editor's bar: small buttons. */
  | 'editor.bar'
  /** Always there, over everything: an extension's own dialogs (a quick open), drawn while it wants them. */
  | 'overlay'
  /**
   * On first-run setup, among what was found on the machine: a `SetupRow` for what yours offers to run models with,
   * and `use` once it's ready (a profile new threads start with).
   */
  | 'onboarding'

/** What a slot beside a file editor gets: the file, and a way to show another. */
export type EditorSlotProps = { machine: MachineEntry; thread: ThreadInfo; path: string; open(path: string, options?: { beside?: boolean }): void }

/** What each slot's component is drawn with, by slot. */
export type SlotProps = {
  'header.chips': { machine: MachineEntry; thread: ThreadInfo }
  'thread.badge': { machine: MachineEntry; thread: ThreadInfo }
  'composer.above': { machine: MachineEntry; thread: ThreadInfo }
  'details.section': { machine: MachineEntry; thread: ThreadInfo }
  'editor.side': EditorSlotProps
  'editor.bar': EditorSlotProps
  'overlay': Record<string, never>
  'onboarding': { machine: MachineEntry; use(found: SetupFound): void }
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

/**
 * What a space draws in the rail instead of the button that opens it: whether it's the open one; whether the sidebar is
 * hidden, the open one then shown in the rail alone (with what it draws there while hidden, if anything: a list as
 * dots); and a way to show the sidebar (`show()`) or hide it (`show(false)`).
 */
export type SpaceRailProps = { open: boolean; sidebarHidden: boolean; show(open?: boolean): void }

/**
 * A view: UI an extension offers, which the layout puts in places. `fits` says which places it can be
 * drawn in; `default` where it goes unless the user's layout says otherwise (none: offered, not placed).
 */
export type View<C extends ViewContext = ViewContext> = {
  title: string
  icon?: ComponentType<{ size?: number; 'aria-hidden'?: boolean }>
  /** `thread`: drawn only where there's a thread (beside, pane, header; in a space, the one shown). */
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
  /**
   * In the `header`: what its row in the title bar's ··· menu says, after its icon, when the bar has no room for it: its
   * name and state, "Model: claude-opus-5-5". Choosing the row clicks the view as drawn (its menu or popover opens from
   * the ···). Unset: its title, and the text it shows.
   */
  menuItem?: ComponentType<ViewProps<C>>
  /** As a `space`: what it draws in the rail instead of a button with its icon (the sidebar hidden, a list as dots, say). */
  railButton?: ComponentType<SpaceRailProps>
  /**
   * In the rail: the action pressing its button runs (Ego's: open its thread). It makes the button one of the rail's
   * tabs, which ⌘1–⌘9 go to in order, before the spaces; its tooltip says its number (`useRailShortcut`).
   */
  action?: string
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
  /** Its title is a file's name (always, or for the panes it says): the strip shows it as one (cut from the start, in the mono face). */
  file?: boolean | ((pane: Pane) => boolean)
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
 * `thread.start` as `options[<extension>]`, for the extension's `starting` hook; undefined sends nothing.
 */
export type NewThreadFieldProps = { machine: MachineEntry; cwd: string; value: Json | undefined; onChange(value: Json | undefined): void }

/** A field of the New thread dialog (`newThreadField`): what draws it, and its value for a thread started beside another. */
export type NewThreadField = {
  component: ComponentType<NewThreadFieldProps>
  /** Its value for a thread started beside `thread` (like it, ⌘N): undefined, none. */
  from?(thread: ThreadInfo): Json | undefined
}

/**
 * A tool call in the transcript. `result` is there once it finished: its text (the output's, then what went wrong, as
 * the user reads it: without the harness's `<harness>[error] …</harness>` the model is shown it in), the harness's
 * other notes on it apart (`notes`: "Showing lines 1-2000 of 5000…", info or a warning), and the images the model was
 * shown: not their pixels, but where they are in the transcript (`entry`), their type and size, for the window to read
 * as they're shown (`image.read` on the machine, as a thumbnail or whole). `live` while it runs.
 */
export type ToolCallProps = {
  machine: MachineEntry
  thread: ThreadInfo
  call: { id: string; name: string; arguments: Record<string, unknown> }
  result?: { text: string; isError: boolean; details?: unknown; notes?: ToolNote[]; images?: ImageItem[] }
  /** `sleeping` or `waiting`: the call is parked, waiting on something outside it (a time, a signal, other tasks). */
  live?: { status: 'pending' | 'running' | 'sleeping' | 'waiting' | 'done'; output?: string; details?: unknown }
}

/** What the harness said of a tool call besides its output and errors (it was cut short, say). */
export type ToolNote = { severity: 'info' | 'warn'; message: string }

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
  /** This call's verb instead of `verbs`' (one cut off by a restart, say); `undefined`, `verbs`'. */
  verb?: (call: ToolRowCall) => ReactNode
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
  /**
   * Open a file or folder by the name the text gives it (from the thread's folder, or beside the file it's in); resolves
   * to why it couldn't. A link's name is looked up as Obsidian's are, by name too; `exact`, only as the path it is.
   */
  openFile?(name: string, options?: { exact?: boolean }): Promise<string | undefined>
  /**
   * What a path names here, exactly as given (beside the file it's in first), as known now: a file or folder, null for
   * nothing, undefined while that's being found out (the place is drawn again once it is).
   */
  file?(name: string): { path: string; folder?: boolean; line?: number } | null | undefined
  /** Open a web page in a pane beside the thread; there only where some pane kind shows web pages. */
  openUrl?(url: string): void
}

/** A link's attributes besides where it goes, what it says and its title. */
export type LinkAttributes = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href' | 'children' | 'title'>

/** A link a handler draws: where it goes, what it says (inline code, for `code`), and a way to follow it. */
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

/** What a settings section's own component gets (`settings`): whose settings (`APP`, or a machine's id), and the section. */
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
/** A thing that happens in the window, to hear with `on`: see `WindowEvents`. */
export type WindowEvent = keyof WindowEvents

/** The window as it is now, for listeners: whether it has the focus and shows, and the thread it shows. */
export type WindowState = {
  focused: boolean
  visible: boolean
  selection: Selection | undefined
  /** The thread shown, as the window has it (archived and Ego's too). */
  thread: ThreadInfo | undefined
  /** The machines the window reaches, connected or not. */
  machines: readonly MachineEntry[]
  /** Each machine's threads in use (by machine id), as the sidebar lists them. */
  threads: Readonly<Record<string, readonly ThreadInfo[] | undefined>>
}

/** What a UI half's `setup` gets (`superego`): ways to add to the window, for as long as the extension is set up. */
export type UiApi = {
  /** The app this window belongs to: its name and id. */
  app: AppConfig
  /**
   * Aborted when this extension is torn down (a profile's UI reloaded or revoked, the window closing), before what it
   * registered goes: for its own timers, listeners and fetches (`fetch(url, { signal })`, `addEventListener(…, { signal })`).
   */
  signal: AbortSignal
  /**
   * A view, `<extension>.<name>`: UI that the layout puts in the places it fits (a space in the rail, beside the thread,
   * the pane menu, the title bar), by default where `default` says. The user's layout (`app.layout`) can move or hide
   * it. A profile's views fit only the places that show a thread, and only its own threads.
   */
  view<C extends ViewContext>(id: string, view: View<C>): void
  /** A component in a slot whose place behaviour decides (`header.chips`, `composer.above`, the editor's, `overlay`), in `order`. */
  slot<S extends BehaviourSlot>(slot: S, component: ComponentType<SlotProps[S]>, options?: { order?: number }): void
  /**
   * Hear what happens in the window (see `WindowEvents`): a thread's status changing, the thread shown changing, the
   * window's focus and visibility. Listening stops at teardown, or with the function returned. `window` is how things
   * are now.
   */
  on<E extends WindowEvent>(event: E, listener: (event: WindowEvents[E]) => void): () => void
  /** The window as it is now. */
  window: Readonly<WindowState>
  /** One of the app's settings as it is now (`useAppSetting` in components). */
  appSetting<T extends Json>(key: string): T | undefined
  /**
   * How calls to the tool `name` look (of the extension's daemon half, or any other): described (a `ToolRow`: icon,
   * verbs, subject, body), or drawn whole by a component of its own. `fold: false` keeps them out of the fold a run of
   * work closes into: they show under it, open, as what the agent showed you (images, say). A name ending in `*` is a
   * prefix (`mcp__*`: every tool whose name starts so); a tool's own name wins over a prefix, and a longer prefix over a
   * shorter.
   */
  tool(name: string, view: ComponentType<ToolCallProps> | ToolRow, options?: { fold?: boolean }): void
  /** Draw transcript entries of `kind`, ones this extension's daemon half writes. */
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
   * `thread.start` as `options[<extension>]`, which its daemon half's `starting` hook reads. One per extension.
   */
  newThreadField(field: NewThreadField): void
  /**
   * A kind of pane: a view opened beside a thread (`pane.open`, or the agent's pane_open tool) with params of its own.
   * A profile's pane kinds exist in that profile's threads only.
   */
  pane(kind: string, pane: PaneKind): void
  /**
   * An action of this extension: dispatched by its keys, from the palette, from other code (`useDispatch`). Ids start
   * with the extension's name. `run` gets its parameters and the window's context.
   */
  action(action: WindowAction): void
  /**
   * Bring CSS: in the window while this extension is set up, gone at its teardown (or with the function returned). A
   * profile's applies only to what that profile draws (its panes, views, slots, tool rows, entries, links, and the menus,
   * popovers, dialogs and `PaneHeader` they open), on its machine: not to the window, nor to the same profile from
   * another machine. An app's extension's applies to the whole window.
   */
  style(css: string): () => void
  /**
   * A theme for code and the terminal (`Theme`: `{ id, name, appearance, syntax?, terminal?, accent? }`), offered in
   * Settings → Appearance's picker for its appearance, under this extension's name. Its id starts with the extension's
   * (`<extension>.<name>`). A theme that doesn't read throws, saying what's wrong. Chosen, it colours code, diffs and
   * the terminal everywhere in the window (a profile's theme too) and its accent unless the user chose one; the
   * window's own backgrounds, text and links only with Match window to theme on.
   */
  theme(theme: Theme): void
  /** Run any action (window, app or machine) through the window's router, outside React. In components: `useDispatch`. */
  dispatch: Dispatch
  /**
   * Settings of this UI half, kept by the app (per user, not per machine) and shown in Settings → General, or under
   * the section's `tab` (`'appearance'`, `'hotkeys'`). Keys are named `<extension>.<key>`. Read and change them with `useAppSetting`.
   */
  appSettings(section: DeclaredSection): void
  /**
   * State of this extension, kept in the window: read and changed by its actions and components alike (`store.use()`
   * in a component). Kept as `<extension>.<key>`: `store('open', …)` and `store('<extension>.open', …)` are the same
   * one. `persist` keeps it across reloads: for this window alone (the desktop app's windows each have their own), or
   * for every window of the app (`shared`: a notice dismissed, say).
   */
  store<T extends Json>(key: string, initial: T, options?: { persist?: boolean; shared?: boolean }): Store<T>
  /** The composer of a thread. */
  composer: {
    /**
     * Complete a word as it's typed (`$co` → `$commit`): the first provider that finds a word at the caret offers its
     * items in a menu over the box.
     */
    complete<W extends CompletionWord>(provider: CompletionProvider<W>): void
    /**
     * Draw what this extension put in sent messages (by a send transform, its daemon half's) under each one, and
     * leave those blocks out of its text. Drawn for a thread that goes without the extension now too: it went then.
     */
    sentWith<T>(sent: SentWith<T>): void
  }
}

/**
 * A UI half: what the extension is (`ExtensionAbout`, the same as its daemon half's: spread one declaration into both),
 * and its setup. An optional extension's UI draws nothing for a thread that goes without it (`ThreadInfo.without`),
 * and its actions aren't offered while one is shown. Nor does any UI half for a thread on a machine that runs its
 * extension at another major than its own `version` (see `speaks`).
 */
export type UiExtension = ExtensionAbout & {
  /** Set it up. May return a cleanup, run first at teardown: when its profile's UI reloads or is revoked. */
  setup(superego: UiApi): void | (() => void)
}

/** Identity for type inference: `export default defineUiExtension({ name, setup(superego) { … } })`. */
export const defineUiExtension = (extension: UiExtension) => extension
