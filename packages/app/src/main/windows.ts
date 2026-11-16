// The app's windows, as they are kept between launches: each by an id of its own (its state in the window's storage is
// kept under it, see local-state.ts) and where it was on the screen, the one last in front first. A launch reopens them
// all, as they were left. Closing a window forgets it, unless it's the last one open (the app reopens it as it was, from
// the Dock or the menu bar, or at the next launch) or the app is quitting (every window open then comes back).
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export type Bounds = { x: number; y: number; width: number; height: number }
export type WindowEntry = { id: string; bounds?: Bounds }

const isBounds = (value: unknown): value is Bounds => typeof value === 'object' && value !== null &&
  (['x', 'y', 'width', 'height'] as const).every((key) => Number.isFinite((value as Record<string, unknown>)[key]))

/** A window's id, as a window's storage keys carry it. */
const isWindowId = (value: unknown): value is string => typeof value === 'string' && /^[a-z0-9-]{1,40}$/.test(value)

export class WindowList {
  readonly #path: string
  /** Every window kept, open or not, the one last in front first. */
  #entries: WindowEntry[] = []
  readonly #open = new Set<string>()
  /** Closing these keeps them: the app is quitting, or putting every window away at once. */
  readonly #keep = new Set<string>()
  #quitting = false
  #saving: ReturnType<typeof setTimeout> | undefined

  constructor(path: string) {
    this.#path = path
    try {
      const raw = JSON.parse(readFileSync(path, 'utf8')) as { windows?: unknown }
      const seen = new Set<string>()
      for (const entry of Array.isArray(raw.windows) ? raw.windows : []) {
        const id = (entry as { id?: unknown })?.id
        if (!isWindowId(id) || seen.has(id)) continue
        seen.add(id)
        const bounds = (entry as { bounds?: unknown }).bounds
        this.#entries.push({ id, ...(isBounds(bounds) ? { bounds } : {}) })
      }
    } catch { /* none kept yet, or unreadable: a launch opens one new window */ }
  }

  /** The windows to reopen (none open now), the one last in front first. */
  closed(): WindowEntry[] { return this.#entries.filter((e) => !this.#open.has(e.id)) }
  /** Every window's id, open or kept: the windows' storage is kept for these alone. */
  ids(): string[] { return this.#entries.map((e) => e.id) }
  /** The open windows' ids, the one last in front first. */
  recent(): string[] { return this.#entries.filter((e) => this.#open.has(e.id)).map((e) => e.id) }

  /**
   * A window opens: one kept (by `id`), where it was among the others, else a new one, in front. `first`: no other
   * was open, which makes it the app's first window (onboarding shows there only).
   */
  open(id?: string): { id: string; first: boolean } {
    const first = this.#open.size === 0
    let entry = id ? this.#entries.find((e) => e.id === id) : undefined
    if (!entry) {
      entry = { id: id ?? randomUUID().slice(0, 8) }
      this.#entries = [entry, ...this.#entries]
    }
    this.#open.add(entry.id)
    this.#keep.delete(entry.id)
    this.#save()
    return { id: entry.id, first }
  }

  focused(id: string) {
    const entry = this.#entries.find((e) => e.id === id)
    if (!entry || this.#entries[0] === entry) return
    this.#entries = [entry, ...this.#entries.filter((e) => e !== entry)]
    this.#save()
  }

  /** Where a window is now: saved a moment later, once it stops moving. */
  moved(id: string, bounds: Bounds) {
    const entry = this.#entries.find((e) => e.id === id)
    if (!entry) return
    entry.bounds = bounds
    clearTimeout(this.#saving)
    this.#saving = setTimeout(() => this.#save(), 500)
    this.#saving.unref?.()
  }

  /** Closing these keeps them, to come back as they were (the app puts every window away). */
  keep(ids: Iterable<string>) { for (const id of ids) this.#keep.add(id) }
  /** The app is quitting: every window closing from now on is kept. */
  quitting() { this.#quitting = true }

  /** A window closed: forgotten, unless the app is quitting, it was put away, or it was the last one open. */
  close(id: string) {
    if (!this.#open.delete(id)) return
    const kept = this.#quitting || this.#keep.delete(id) || this.#open.size === 0
    if (!kept) this.#entries = this.#entries.filter((e) => e.id !== id)
    this.#save()
  }

  #save() {
    clearTimeout(this.#saving)
    this.#saving = undefined
    try {
      mkdirSync(dirname(this.#path), { recursive: true })
      const temp = `${this.#path}.${process.pid}.tmp`
      writeFileSync(temp, `${JSON.stringify({ windows: this.#entries }, null, 2)}\n`)
      renameSync(temp, this.#path)
    } catch (error) { console.error('windows.json:', error) }
  }
}

/**
 * `bounds` as a window can take them on these screens: kept while enough of its title bar is on one to drag it by,
 * else only its size, for the system to place (a screen it was on is gone).
 */
export function placeOn(bounds: Bounds, screens: Bounds[]): Partial<Bounds> {
  const visible = screens.some((s) => {
    const wide = Math.min(bounds.x + bounds.width, s.x + s.width) - Math.max(bounds.x, s.x)
    const high = Math.min(bounds.y + 40, s.y + s.height) - Math.max(bounds.y, s.y)
    return wide >= 80 && high >= 20
  })
  return visible ? bounds : { width: bounds.width, height: bounds.height }
}
