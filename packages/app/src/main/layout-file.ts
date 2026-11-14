// The layout as text: `<data dir>/layout.json`, the app setting `app.layout` as a file to edit by hand (Edit layout…, in
// ⌘K). Saving it applies at once, in every window. What doesn't read as a layout (bad JSON, a view no window knows, a
// place a view doesn't fit) is noted, and the last good layout stays. Changes made in the window (⌘I, a view's Move to…)
// are written back to it. Its head is comments: what goes in it, and the views the windows declare, the places each
// fits (`superego layout` prints it too). Comments are whole lines starting with `//`.
import { watch, type FSWatcher } from 'node:fs'
import { readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Json } from '@superego/protocol'
import type { SettingsRegistry } from '@superego/settings'
import { isLayout, LAYOUT, PLACES, type Layout, type Place } from '../renderer/layout.ts'

/** A view as the window tells the file of it: enough to list it, and to check a layout naming it. */
export type LayoutView = { id: string; title: string; fits: Place[]; default?: Place | Place[] | false | null; narrow?: Place | Place[] | false | null }

export const LAYOUT_FILE = 'layout.json'

const HELP = [
  'Where the window\'s views go. Saved, it applies at once; a mistake is noted and the last good layout stays.',
  'Only what differs from the views\' defaults:',
  '  "place": { "<view>": "<place>" | ["<place>", …] | null },   null hides it',
  '  "order": { "<place>": ["<view>", …] },                       first to last; the rest after',
  '  "narrow": { "place": …, "order": … },                         on a phone, on top of the above',
  'For example: { "place": { "threads.details": "aside", "ego.button": null }, "order": { "pane": ["git.changes"] } }',
  `Places: ${PLACES.join(', ')}.`,
]

const placements = (p: LayoutView['default']) => !p ? 'none' : Array.isArray(p) ? p.join(' + ') : p

/** The comments at the file's head: what it holds, and the views there are. */
export function layoutHead(views: readonly LayoutView[] | undefined): string {
  const lines = [...HELP]
  if (views?.length) {
    const width = Math.max(...views.map((v) => v.id.length))
    lines.push('', 'Views (fits; by default):')
    for (const v of [...views].sort((a, b) => a.id.localeCompare(b.id))) {
      lines.push(`  ${v.id.padEnd(width)}  ${v.fits.join(', ')}; ${placements(v.default)}${v.narrow !== undefined ? `, on a phone ${placements(v.narrow)}` : ''}  (${v.title})`)
    }
  }
  return lines.map((line) => line ? `// ${line}` : '//').join('\n') + '\n'
}

const isComment = (line: string) => line.trim().startsWith('//')

/** The file's text past its head of comments. */
const bodyOf = (text: string) => {
  const lines = text.split('\n')
  const at = lines.findIndex((line) => line.trim() && !isComment(line))
  return at < 0 ? '' : lines.slice(at).join('\n')
}

/**
 * The layout `text` holds, or what's wrong with it. With `views`, the ids it names and the places it puts them are
 * checked against them too.
 */
export function parseLayout(text: string, views?: readonly LayoutView[]): { layout: Layout } | { problem: string } {
  const json = text.split('\n').map((line) => isComment(line) ? '' : line).join('\n')
  if (!json.trim()) return { layout: {} }
  let value: Json
  try { value = JSON.parse(json) } catch (error) { return { problem: `Not JSON: ${(error as Error).message}` } }
  if (!isLayout(value)) return { problem: 'Not a layout: an object of "place", "order" and "narrow", with view ids and place names' }
  const problems: string[] = []
  const byId = new Map(views?.map((v) => [v.id, v]))
  const knownPlace = (place: string) => (PLACES as string[]).includes(place) || void problems.push(`no place "${place}"`)
  for (const layer of [value, value.narrow ?? {}]) {
    for (const [id, placed] of Object.entries(layer.place ?? {})) {
      const places = placed === null ? [] : Array.isArray(placed) ? placed : [placed]
      for (const place of places) if (knownPlace(place) && views && byId.has(id) && !byId.get(id)!.fits.includes(place)) problems.push(`${id} doesn't fit "${place}" (only ${byId.get(id)!.fits.join(', ')})`)
      if (views && !byId.has(id)) problems.push(`no view "${id}"`)
    }
    for (const [place, ids] of Object.entries(layer.order ?? {})) {
      knownPlace(place)
      if (views) for (const id of ids ?? []) if (!byId.has(id)) problems.push(`no view "${id}"`)
    }
  }
  return problems.length ? { problem: [...new Set(problems)].join('; ') } : { layout: value }
}

const text = (layout: Json | undefined) => JSON.stringify(layout ?? {})

/**
 * Keep `layout.json` in `dir` and the setting `app.layout` in `settings` the same: the file read in as it's saved, the
 * setting written out as it changes. `changed` is told when what's noted about the file changes.
 */
export class LayoutFile {
  readonly path: string
  /** What's wrong with the file as last saved, if anything: the layout before it stays. */
  problem: string | undefined
  #settings: SettingsRegistry
  #views: LayoutView[] | undefined
  /** The file's text as last read or written, so our own writes aren't read back in. */
  #text: string | undefined
  /** The setting as the file last had it. */
  #applied: string
  #watcher: FSWatcher | undefined
  #timer: ReturnType<typeof setTimeout> | undefined
  #changed: () => void

  constructor(dir: string, settings: SettingsRegistry, changed: () => void = () => {}) {
    this.path = join(dir, LAYOUT_FILE)
    this.#settings = settings
    this.#changed = changed
    this.#applied = text(settings.get(LAYOUT))
    settings.onChange(() => { if (text(settings.get(LAYOUT)) !== this.#applied) void this.#write() })
  }

  /** Read the file in (written first if there's none), and from then on as it's saved. */
  async start(): Promise<void> {
    await this.read()
    this.#watcher = watch(join(this.path, '..'), (_event, file) => {
      if (file !== LAYOUT_FILE) return
      clearTimeout(this.#timer)
      this.#timer = setTimeout(() => void this.read(), 50)
    })
  }

  stop() { this.#watcher?.close(); clearTimeout(this.#timer) }

  /** The views the window declares: listed at the file's head, and what layouts in it are checked against. */
  async setViews(views: LayoutView[]): Promise<void> {
    if (JSON.stringify(views) === JSON.stringify(this.#views)) return
    this.#views = views
    const current = await readFile(this.path, 'utf8').catch(() => undefined)
    if (current === undefined) return this.#write()
    await this.#save(layoutHead(views) + bodyOf(current))
  }

  /** The file as saved now: applied when it reads as a layout, noted when not. */
  async read(): Promise<void> {
    const current = await readFile(this.path, 'utf8').catch(() => undefined)
    if (current === undefined) return this.#write()
    if (current === this.#text) return
    this.#text = current
    const parsed = parseLayout(current, this.#views)
    this.#note('problem' in parsed ? parsed.problem : undefined)
    if ('problem' in parsed) return
    this.#applied = text(parsed.layout)
    if (this.#applied !== text(this.#settings.get(LAYOUT))) await this.#settings.set(LAYOUT, parsed.layout as Json)
  }

  #note(problem: string | undefined) {
    if (problem === this.problem) return
    this.problem = problem
    this.#changed()
  }

  /** Write the setting out, over whatever the file held. */
  async #write(): Promise<void> {
    const layout = this.#settings.get(LAYOUT)
    this.#applied = text(layout)
    this.#note(undefined)
    await this.#save(layoutHead(this.#views) + JSON.stringify(layout ?? {}, null, 2) + '\n')
  }

  async #save(content: string): Promise<void> {
    this.#text = content
    const temp = `${this.path}.${process.pid}.tmp`
    await writeFile(temp, content)
    await rename(temp, this.path)
  }
}
