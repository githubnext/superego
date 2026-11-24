// What a machine says of its data views, checked where it lands: here, in the window. The daemon that declares them
// checks them too, but a remote machine, or one of another version, is not this window's to trust. A declaration that
// isn't what a data view can be (the wrong shape, too big, another extension's names, a place there isn't) is left
// out, with a word to the console, and never throws into the shell; one bad view doesn't take the machine's others with
// it. What a view shows is blocks, checked whole where they're drawn (`<Blocks>`).
import { DATA_ICONS, DATA_PLACES, type DataIcon, type DataPlace, type DataViewInfo } from '@superego/protocol'

/** How much a machine may declare: past these, the rest is left out. */
export const LIMITS = {
  /** Data views one machine declares. */
  views: 200,
  /** Profiles one view is of. */
  profiles: 64,
  /** An id, title, extension or source name. */
  name: 200,
  /** A profile's folder, a view's `about`. */
  path: 4096,
} as const

const EXTENSION = /^[a-z][a-z0-9-]*$/

const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const name = (value: unknown) => typeof value === 'string' && value.length > 0 && value.length <= LIMITS.name ? value : undefined
const owned = (value: unknown, extension: string) => {
  const text = name(value)
  return text && text.startsWith(`${extension}.`) && text.length > extension.length + 1 && !/\s/.test(text) ? text : undefined
}
const place = (value: unknown): value is DataPlace => DATA_PLACES.includes(value as DataPlace)
const icon = (value: unknown): value is DataIcon => DATA_ICONS.includes(value as DataIcon)
/** A default or narrow place: one, several, or `false`. */
const placing = (value: unknown): DataPlace | DataPlace[] | false | undefined =>
  value === false || place(value) ? value : Array.isArray(value) && value.length <= DATA_PLACES.length && value.every(place) ? value : undefined

/**
 * The data views `machine` sent, as far as they can be views: each of one of its extensions (`has`) and named for it,
 * its source that extension's, in places there are, a profile's only where a profile's go; and no more than `LIMITS`.
 * What can't be is in `dropped`, each with why.
 */
export function checkDataViews(raw: unknown, has: (extension: string) => boolean): { views: DataViewInfo[]; dropped: string[] } {
  const views: DataViewInfo[] = []
  const dropped: string[] = []
  if (raw === null || raw === undefined) return { views, dropped }
  if (!Array.isArray(raw)) return { views, dropped: ['the list of views isn’t a list'] }
  if (raw.length > LIMITS.views) dropped.push(`${raw.length - LIMITS.views} views past the first ${LIMITS.views}`)
  for (const [i, value] of raw.slice(0, LIMITS.views).entries()) {
    const label = isObject(value) && name(value.id) ? value.id as string : `view ${i}`
    const problem = (why: string) => { dropped.push(`${label}: ${why}`) }
    if (!isObject(value)) { problem('isn’t a declaration'); continue }
    const extension = name(value.extension)
    if (!extension || !EXTENSION.test(extension)) { problem('names no extension'); continue }
    if (!has(extension)) { problem(`is of ${extension}, which the machine doesn’t have on`); continue }
    const id = owned(value.id, extension)
    if (!id) { problem(`must be named "${extension}.<name>"`); continue }
    const title = name(value.title)
    if (!title) { problem('needs a title'); continue }
    if (value.context !== 'window' && value.context !== 'thread') { problem('needs a context, window or thread'); continue }
    const context = value.context
    if (Array.isArray(value.profiles) && (!value.profiles.length || value.profiles.length > LIMITS.profiles
      || !value.profiles.every((dir) => typeof dir === 'string' && dir.length > 0 && dir.length <= LIMITS.path))) { problem('names its profiles wrong'); continue }
    if (value.profiles !== undefined && !Array.isArray(value.profiles)) { problem('names its profiles wrong'); continue }
    const profiles = value.profiles as string[] | undefined
    if (!Array.isArray(value.fits) || !value.fits.length || value.fits.length > DATA_PLACES.length) { problem('fits no place'); continue }
    const bad = value.fits.find((p) => !place(p) || (context === 'window' && p === 'pane'))
    if (bad !== undefined) { problem(`can’t be drawn in ${String(bad).slice(0, 40)}`); continue }
    // A profile's show only in its threads: never a sidebar.
    const fits = profiles ? (value.fits as DataPlace[]).filter((p) => p !== 'sidebar') : value.fits as DataPlace[]
    if (!fits.length) { problem('fits no place a profile’s view is drawn in'); continue }
    const source = value.value !== undefined ? 'value' : 'method'
    if ((value.value === undefined) === (value.method === undefined)) { problem('needs one source: a value or a method'); continue }
    const from = owned(value[source], extension)
    if (!from) { problem(`must read a value or method of ${extension}’s`); continue }
    if (value.icon !== undefined && !icon(value.icon)) { problem('has no such icon'); continue }
    const fallback = placing(value.default), narrow = placing(value.narrow)
    if (value.default !== undefined && fallback === undefined) { problem('has a default that isn’t a place'); continue }
    if (value.narrow !== undefined && narrow === undefined) { problem('has a narrow place that isn’t a place'); continue }
    if (value.order !== undefined && !(typeof value.order === 'number' && Number.isFinite(value.order))) { problem('has an order that isn’t a number'); continue }
    if (value.about !== undefined && !(typeof value.about === 'string' && value.about.length <= LIMITS.path)) { problem('says what it shows wrong'); continue }
    // One declaration of an id per profile (or none) on a machine.
    const scope = profiles?.join('\n')
    if (views.some((v) => v.id === id && v.profiles?.join('\n') === scope)) { problem('is declared twice'); continue }
    views.push({
      id, extension, title, context, fits, [source]: from,
      ...(value.icon !== undefined ? { icon: value.icon as DataIcon } : {}),
      ...(fallback !== undefined ? { default: fallback } : {}), ...(narrow !== undefined ? { narrow } : {}),
      ...(value.order !== undefined ? { order: value.order as number } : {}),
      ...(value.about !== undefined ? { about: value.about as string } : {}),
      ...(profiles ? { profiles: [...profiles] } : {}),
    })
  }
  return { views, dropped }
}

/** Say what a machine sent that was left out, once each, on the console. */
const said = new Set<string>()
export function warnDropped(machine: string, what: string, dropped: string[]) {
  for (const why of dropped) {
    const line = `${machine}: ${what}: ${why}`
    if (said.has(line)) continue
    if (said.size > 1000) said.clear()
    said.add(line)
    console.warn(`Data view left out — ${line}`)
  }
}
