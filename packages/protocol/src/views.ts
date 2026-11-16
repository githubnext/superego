// Data-only views: UI a daemon extension declares as data, which the window draws with its own components. No code of
// the extension's runs in the window, so a view from a remote machine or a project's profile needs no consent to run
// code there: it can show facts, a list, a table and Markdown, and offer buttons that run the machine's own actions,
// with that machine's authority. The window checks what it is sent as it lands (packages/app data-view-check.ts).
import type { Json } from './settings.ts'
import type { Status } from './status.ts'

/** The live value every daemon publishes its extensions' data views in (`value.watch`), as `DataViewInfo[]`. */
export const DATA_VIEWS = 'view.list'

/** The places a data view can be drawn in: a space (on a phone, the drawer), beside the thread, a pane. */
export type DataPlace = 'space' | 'beside' | 'pane'
export const DATA_PLACES: DataPlace[] = ['space', 'beside', 'pane']

/** The glyphs a data view, or a button in one, can take, by name. */
export const DATA_ICONS = ['list', 'table', 'folder', 'file', 'bell', 'check', 'gear', 'globe', 'sparkle', 'terminal', 'wrench', 'chats', 'archive', 'columns'] as const
export type DataIcon = (typeof DATA_ICONS)[number]

/**
 * A data view, as a daemon extension declares it (`superego.view`). Its content is a `ViewContent`, read from a live
 * value of the extension's or a method of its:
 * - a `window` view (a space): the value is the content; the method is called with `{}`
 * - a `thread` view (a space shows the selected thread): the value is a scoped value, each thread's content in its
 *   scope (or a plain value holding each thread's by its id; the window watches only that thread's); the method is
 *   called with `{ id }`
 * A method is read again as the thread moves on (a window view: as any thread on the machine does), and after one of
 * the view's buttons ran.
 */
export type DataView = {
  title: string
  icon?: DataIcon
  context: 'window' | 'thread'
  /** The places it can be drawn in. A `window` view fits only `space` and `beside`. */
  fits: DataPlace[]
  /** Where it goes unless the user's layout says otherwise; none: offered, not placed. */
  default?: DataPlace | DataPlace[] | false
  /** On a phone, where it goes by default instead. */
  narrow?: DataPlace | DataPlace[] | false
  /** Order among the views in a place (100 when unset). */
  order?: number
  /** Its content's source: a live value of this extension's (`<name>.<key>`), or a method of its. One of the two. */
  value?: string
  method?: string
  /** A `thread` view that fits `pane`: what it shows, for the agent's open_pane (unset: the agent isn't told of it). */
  about?: string
}

/** A data view as the window is told of it: its id, the extension it's of, and (a profile's) the profiles' folders. */
export type DataViewInfo = DataView & { id: string; extension: string; profiles?: string[] }

/**
 * A button in a data view: runs one of the machine's actions with `params`, as any client would (`action.run`).
 */
export type ViewAction = { title: string; action: string; params?: Json; icon?: DataIcon }

/** A row of a list: what it is, a line under it, a little at its end, how it stands, a thread it is, its buttons. */
export type ViewItem = {
  id?: string
  title: string
  subtitle?: string
  /** At the row's end, small: "5m", "+3". */
  detail?: string
  /** A status glyph before it, as threads have. */
  status?: Status['state']
  /** A thread on the same machine: the title is a link to it. */
  thread?: string
  actions?: ViewAction[]
}

/** What a data view shows, top to bottom: any of these, each left out when unset. */
export type ViewContent = {
  /** A line at the top: "2 running · 1 queued". */
  note?: string
  /** Label and value pairs, as thread details have. */
  facts?: { label: string; value: string }[]
  items?: ViewItem[]
  table?: { columns: string[]; rows: (string | number | null)[][] }
  markdown?: string
  /** Buttons at the foot. */
  actions?: ViewAction[]
  /** Said when there's nothing else to show. */
  empty?: string
}

/** Why a data view's declaration can't be taken, if it can't: a message for the extension's author. */
export function dataViewProblem(view: DataView): string | undefined {
  if (!view.title) return 'needs a title'
  if (view.context !== 'window' && view.context !== 'thread') return 'needs a context, window or thread'
  if (!Array.isArray(view.fits) || !view.fits.length) return 'fits no place'
  const bad = view.fits.find((p) => !DATA_PLACES.includes(p) || (view.context === 'window' && p === 'pane'))
  if (bad) return `can't be drawn in ${bad}${view.context === 'window' ? ' (a window view fits space and beside)' : ''}`
  if (Boolean(view.value) === Boolean(view.method)) return 'needs one source: a value or a method'
  if (view.icon && !DATA_ICONS.includes(view.icon)) return `has no icon ${view.icon}`
  return undefined
}
