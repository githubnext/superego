// The layout as text: `<data dir>/layout.json`, the app setting `app.layout` as a file to edit by hand (Edit layout…, in
// ⌘K). Saving it applies at once, in every window. What doesn't read as a layout (bad JSON, a place there isn't, a place
// a view doesn't fit) is noted, and the last good layout stays; a view no window has now (an extension switched off, a
// machine away) is only noted, and kept for when it's back. Changes made in the window (⌘I, a view's Move to…) are
// written back to it, keeping the comments typed in it, unless it doesn't read: then it's left as typed. Its head is
// comments: what goes in it, and the views the windows declare, the places each fits (`superego layout` prints it too).
// Comments are whole lines starting with `//`.
import { readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { watchFiles } from '@superego/daemon/client'
import type { Json } from '@superego/protocol'
import type { SettingsRegistry } from '@superego/settings'
import { LAYOUT } from '../shared/app-settings.ts'
import { isComment, parseLayout, PLACES, type LayoutView } from '../shared/layout.ts'

export const LAYOUT_FILE = 'layout.json'

const HELP = [
  'Where the window\'s views go. Saved, it applies at once; a mistake is noted and the last good layout stays.',
  'Only what differs from the views\' defaults:',
  '  "place": { "<view>": "<place>" | ["<place>", …] | null },   null hides it',
  '  "order": { "<place>": ["<view>", …] },                       first to last; the rest after',
  '  "narrow": { "place": …, "order": … },                         on a phone, on top of the above',
  'For example: { "place": { "threads.details": "beside", "ego.button": null }, "order": { "pane": ["git.changes"] } }',
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

/**
 * The file's text past its head of comments, and a blank line after it: the head is the run of comments at the start
 * of a file that starts as one does. A file that doesn't is all body.
 */
export const bodyOf = (text: string) => {
  const lines = text.split('\n')
  if (lines[0]?.trim() !== `// ${HELP[0]}`) return text
  let at = lines.findIndex((line) => !isComment(line))
  if (at < 0) return ''
  if (!lines[at]!.trim()) at++
  return lines.slice(at).join('\n')
}

/** What a line of JSON is about, for keeping comments by it: its key, else its text. */
const anchorOf = (line: string) => /^\s*("(?:[^"\\]|\\.)*")\s*:/.exec(line)?.[1] ?? line.trim().replace(/,$/, '')

/**
 * `layout` as the body of the file, keeping the comments `body` has: each above the line it was above (by its key),
 * those of a line that's gone at the start, those after everything at the end.
 */
export function withComments(body: string, layout: Json | undefined): string {
  const json = JSON.stringify(layout ?? {}, null, 2).split('\n')
  const before = new Map<number, string[]>()
  const lost: string[] = []
  const trailing: string[] = []
  let block: string[] = []
  const used = new Set<number>()
  for (const line of body.split('\n')) {
    if (isComment(line)) { block.push(line.trim()); continue }
    if (!line.trim() || !block.length) continue
    const anchor = anchorOf(line)
    const at = json.findIndex((l, i) => !used.has(i) && anchorOf(l) === anchor)
    if (at < 0) lost.push(...block)
    else { used.add(at); before.set(at, [...before.get(at) ?? [], ...block]) }
    block = []
  }
  trailing.push(...block)
  const indent = (line: string) => /^\s*/.exec(line)![0]
  const lines = json.flatMap((line, i) => [...(before.get(i) ?? []).map((c) => indent(line) + c), line])
  return [...lost, ...lines, ...trailing].join('\n') + '\n'
}

const text = (layout: Json | undefined) => JSON.stringify(layout ?? {})

/**
 * Keep `layout.json` in `dir` and the setting `app.layout` in `settings` the same: the file read in as it's saved, the
 * setting written out as it changes. `changed` is told when what's noted about the file changes.
 */
export class LayoutFile {
  readonly path: string
  /** What's wrong with the file as last saved, if anything: the layout before it stays, and the file isn't written. */
  problem: string | undefined
  /** The views the file names that no window has now: applied all the same. */
  missing: string[] | undefined
  #settings: SettingsRegistry
  /** The views each window declares (by its id), listed at the head together. */
  #windows = new Map<number, LayoutView[]>()
  #views: LayoutView[] | undefined
  /** The file's text as last read or written, so our own writes aren't read back in. */
  #text: string | undefined
  /** The setting as the file last had it. */
  #applied: string
  #watcher: { close(): void } | undefined
  #timer: ReturnType<typeof setTimeout> | undefined
  #changed: () => void
  /** What's being done with the file now: reads and writes go one at a time (see `#serially`). */
  #queue: Promise<void> = Promise.resolve()

  constructor(dir: string, settings: SettingsRegistry, changed: () => void = () => {}) {
    this.path = join(dir, LAYOUT_FILE)
    this.#settings = settings
    this.#changed = changed
    this.#applied = text(settings.get(LAYOUT))
    settings.onChange(() => { if (text(settings.get(LAYOUT)) !== this.#applied) void this.#serially(() => this.#write()) })
  }

  /**
   * Run `work` once what's before it is done. A read in the middle of a write would find the file as it was before it,
   * take that for a newer save, and undo the window's change.
   */
  #serially(work: () => Promise<void>): Promise<void> {
    const done = this.#queue.then(work)
    this.#queue = done.catch(() => {})
    return done
  }

  /** Read the file in (written first if there's none), and from then on as it's saved. */
  async start(): Promise<void> {
    await this.read()
    this.#watcher = watchFiles(join(this.path, '..'), [LAYOUT_FILE], () => {
      clearTimeout(this.#timer)
      this.#timer = setTimeout(() => void this.read(), 50)
    })
  }

  stop() { this.#watcher?.close(); clearTimeout(this.#timer) }

  /**
   * The views a window declares (`undefined`: it closed): every window's are listed at the file's head, and what
   * layouts in it are checked against.
   */
  setViews(window: number, views: LayoutView[] | undefined): Promise<void> {
    return this.#serially(() => this.#setViews(window, views))
  }

  async #setViews(window: number, views: LayoutView[] | undefined): Promise<void> {
    if (views) this.#windows.set(window, views)
    else this.#windows.delete(window)
    const all = new Map<string, LayoutView>()
    for (const list of this.#windows.values()) for (const view of list) if (!all.has(view.id)) all.set(view.id, view)
    const union = [...all.values()].sort((a, b) => a.id.localeCompare(b.id))
    if (JSON.stringify(union) === JSON.stringify(this.#views)) return
    this.#views = union
    const current = await readFile(this.path, 'utf8').catch(() => undefined)
    if (current === undefined) return this.#write()
    await this.#save(layoutHead(union) + '\n' + bodyOf(current))
    // Checked again: a view that's come may fit where the file puts it, one that's gone is noted. Unless the window
    // changed the layout since the file was read: that's newer, and is written out next.
    if (text(this.#settings.get(LAYOUT)) === this.#applied) await this.#apply(current)
  }

  /** The file as saved now: applied when it reads as a layout, noted when not. */
  read(): Promise<void> {
    return this.#serially(() => this.#read())
  }

  async #read(): Promise<void> {
    const current = await readFile(this.path, 'utf8').catch(() => undefined)
    if (current === undefined) return this.#write()
    if (current === this.#text) return
    this.#text = current
    await this.#apply(current)
  }

  async #apply(current: string): Promise<void> {
    const parsed = parseLayout(current, this.#views)
    this.#note('problem' in parsed ? parsed.problem : undefined, 'missing' in parsed ? parsed.missing : undefined)
    if ('problem' in parsed) return
    this.#applied = text(parsed.layout)
    if (this.#applied !== text(this.#settings.get(LAYOUT))) await this.#settings.set(LAYOUT, parsed.layout as Json)
  }

  #note(problem: string | undefined, missing: string[] | undefined) {
    if (problem === this.problem && JSON.stringify(missing) === JSON.stringify(this.missing)) return
    this.problem = problem
    this.missing = missing
    this.#changed()
  }

  /**
   * Write the setting out, keeping the comments typed in the body. Not while the file doesn't read: what's typed there
   * stays as it is, and applies over this once it does.
   */
  async #write(): Promise<void> {
    if (this.problem) return
    const current = await readFile(this.path, 'utf8').catch(() => undefined)
    // Saved since it was last read (and not yet heard of): what's saved is the newer change.
    if (current !== undefined && current !== this.#text) return this.#read()
    const layout = this.#settings.get(LAYOUT)
    this.#applied = text(layout)
    await this.#save(layoutHead(this.#views) + '\n' + withComments(current === undefined ? '' : bodyOf(current), layout))
    const parsed = parseLayout(this.#text!, this.#views)
    this.#note(undefined, 'missing' in parsed ? parsed.missing : undefined)
  }

  async #save(content: string): Promise<void> {
    this.#text = content
    const temp = `${this.path}.${process.pid}.tmp`
    await writeFile(temp, content)
    await rename(temp, this.path)
  }
}
