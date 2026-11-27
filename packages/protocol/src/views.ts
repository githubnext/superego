// Data-only views: UI a daemon half declares as data, which the window draws with its own components. No code of
// the extension's runs in the window, so a view from a remote machine or a project's profile needs no consent to run
// code there. What one shows is blocks (blocks.ts), the schema agents draw with: text, a list, a table, inputs, and
// buttons that run the extension's own actions on its machine, with that machine's authority. The window checks the
// declarations (packages/app data-view-check.ts) and the blocks (`blockErrors`) as they land.

/** The live value every daemon publishes its extensions' data views in (`value.watch`), as `DataViewInfo[]`. */
export const DATA_VIEWS = 'view.list'

/**
 * The core's live value of the user's global profiles loaded on a machine (`ProfileRef[]`, `global: true` in their
 * profile.ts): the window installs their UI as the app's.
 */
export const GLOBAL_PROFILES = 'profile.globals'

/**
 * The core's live value of the project profiles allowed to run on a machine (`profile.allow`), each by its folder and
 * the hash it was allowed at (`{ dir, hash }[]`): changed by an allow from anywhere (a window, the command line), so the
 * window loads a project's profile, and its spaces, as soon as it's allowed.
 */
export const PROFILES_ALLOWED = 'profile.allowed'

/** The places a data view can be drawn in: a sidebar (on a phone, the drawer), beside the thread, a pane. */
export type DataPlace = 'sidebar' | 'beside' | 'pane'
export const DATA_PLACES: DataPlace[] = ['sidebar', 'beside', 'pane']

/** The glyphs a data view can take, by name: its tab's, its place in the rail's. */
export const DATA_ICONS = ['list', 'table', 'folder', 'file', 'bell', 'check', 'gear', 'globe', 'sparkle', 'terminal', 'wrench', 'chats', 'archive', 'columns'] as const
export type DataIcon = (typeof DATA_ICONS)[number]

/**
 * A data view, as a daemon half declares it (`superego.view`). What it shows is blocks (`Block[]`; `[]` or null:
 * nothing yet), read from a live value of the extension's or a method of its:
 * - a `window` view (a sidebar): the value is the blocks; the method is called with `{}`
 * - a `thread` view (beside the thread, or a pane): the value is a scoped value, each thread's blocks in its
 *   scope (or a plain value holding each thread's by its id; the window watches only that thread's); the method is
 *   called with `{ thread }`
 * A method is read again as the thread moves on (a window view: as any thread on the machine does), and after one of
 * the view's buttons ran. Its buttons run this extension's actions (`<name>.<action>`, exposed to the UI), with their
 * `params` and the inputs' values by id; a thread view's say their thread in `params`. Blocks bind to nothing: to
 * change what it shows, set the value again (the inputs keep what the user typed).
 */
export type DataView = {
  title: string
  icon?: DataIcon
  context: 'window' | 'thread'
  /** The places it can be drawn in. A `window` view fits `sidebar` and `beside`; a `thread` view, `beside` and `pane`. */
  fits: DataPlace[]
  /** Where it goes unless the user's layout says otherwise; none: offered, not placed. */
  default?: DataPlace | DataPlace[] | false
  /** On a phone, where it goes by default instead. */
  narrow?: DataPlace | DataPlace[] | false
  /** Order among the views in a place (100 when unset). */
  order?: number
  /** Its blocks' source: a live value of this extension's (`<name>.<key>`), or a method of its. One of the two. */
  value?: string
  method?: string
  /** A `thread` view that fits `pane`: what it shows, for the agent's pane_open (unset: the agent isn't told of it). */
  about?: string
}

/** A data view as the window is told of it: its id, the extension it's of, and (a profile's) the profiles' folders. */
export type DataViewInfo = DataView & { id: string; extension: string; profiles?: string[] }

/** Why a data view's declaration can't be taken, if it can't: a message for the extension's author. */
export function dataViewProblem(view: DataView): string | undefined {
  if (!view.title) return 'needs a title'
  if (view.context !== 'window' && view.context !== 'thread') return 'needs a context, window or thread'
  if (!Array.isArray(view.fits) || !view.fits.length) return 'fits no place'
  // A sidebar is a section of the window's (where you pick what the main area shows), not about the thread shown.
  const bad = view.fits.find((p) => !DATA_PLACES.includes(p) || (view.context === 'window' ? p === 'pane' : p === 'sidebar'))
  if (bad) return `can't be drawn in ${bad}${view.context === 'window' ? ' (a window view fits sidebar and beside)' : ' (a thread view fits beside and pane)'}`
  if (Boolean(view.value) === Boolean(view.method)) return 'needs one source: a value or a method'
  if (view.icon && !DATA_ICONS.includes(view.icon)) return `has no icon ${view.icon}`
  return undefined
}
