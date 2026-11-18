// The window's title bar, short of room: what it holds gives way in one order, and what's gone is in a ··· menu at its
// end. The thread's title keeps up to TITLE_KEPT of its width, the strip's focused tab and the crumbs stay; the rest
// (the header's chips and buttons, the profile, pin and archive, the strip's other tabs and its switch) are items, each
// with a priority: the lowest goes first. A strip tab shrinks to its icon (`compactAt`) before it goes.
//
// Measured, not guessed: a ResizeObserver on the bar (the window resizing) and on each item (an extension's chip
// changing what it says), and each render of an item (`useOverflowItem`) or of the title. Each time, one read of what's
// laid out (the room left, how far the title's squeezed, each item's natural width: an item that's gone is still drawn,
// hidden and out of the flow, so it measures as it would be shown), then the attributes that say what's gone, written
// before the frame is drawn: no flicker. An item that's gone stays mounted where it was, hidden at the bar's end, under
// the ···: choosing its row clicks it there, so its menu or popover opens from the ···.
import { createContext, useContext, useLayoutEffect, useRef, useState, useSyncExternalStore, type ComponentType, type ReactNode } from 'react'
import { DotsThreeIcon, IconButton, Menu } from '@superego/ui'

/** How much of the title's width the bar keeps for it before the title truncates (all of it, when shorter). */
export const TITLE_KEPT = 320
/** The room an item needs beyond its width to come back, against a gap measured short. */
const FIT = 4

/**
 * Who goes first (the lowest): the strip's map, where the thread came from, extensions' chips, the header's views (the
 * last first), the strip's switch, the profile, archive, pin, rename; then the strip's other tabs shrink to icons, then
 * go; the pane opener last.
 */
export const PRIORITY = { map: 10, parent: 20, chips: 25, header: 30, layout: 40, profile: 50, archive: 60, pin: 64, rename: 68, tabsCompact: 80, tabs: 90, panes: 95 }

type Icon = ComponentType<{ size?: number; 'aria-hidden'?: boolean }>

export type OverflowItem = {
  /** Lower goes first. */
  priority: number
  /** Before it goes, at this priority, its `.overflow-part`s hide (a tab keeps its icon). */
  compactAt?: number
  /** Its row in the ··· menu, while it's gone: none for one that goes without (the strip's map). */
  row?: ReactNode
  /** Choosing its row: unless given, a click on the item's first control, where it stands hidden. */
  select?: () => void
}

type Entry = OverflowItem & { key: string; el: HTMLElement | null }

/** A step the bar takes to make room: an item gone, or a group shrunk. */
type Step = { priority: number; entry?: Entry; members?: Entry[] }

/** The width an item takes now, and would take shown, shrunk or gone. */
type Measure = { full: number; compact: number; parts: number; outer: number }

const gapOf = (el: Element | null): number => {
  if (!el) return 0
  const style = getComputedStyle(el)
  return style.display === 'contents' ? gapOf(el.parentElement) : parseFloat(style.columnGap) || 0
}

/** The bar's items and what's gone: one per window. */
export class Overflow {
  private bar: HTMLElement | null = null
  private more: HTMLElement | null = null
  private entries = new Map<string, Entry>()
  private moreWidth = 28
  private gone: string[] = []
  private listeners = new Set<() => void>()
  private scheduled = false
  private observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(() => this.update())
  version = 0

  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  setBar = (el: HTMLElement | null) => {
    if (this.bar) this.observer?.unobserve(this.bar)
    this.bar = el
    if (el) { this.observer?.observe(el); this.dirty() }
  }
  constructor() {
    // A font arriving changes what everything measures.
    if (typeof document !== 'undefined') document.fonts?.addEventListener('loadingdone', () => this.dirty())
  }
  setMore = (el: HTMLElement | null) => { this.more = el; this.dirty() }

  /**
   * An item's element and what it is, as it's drawn (none: it's gone from the page, or stays): each render, as what it
   * says may change its width or its row. Watched for its size changing between renders, unless it shrinks itself.
   */
  attach(key: string, item: OverflowItem | undefined, el: HTMLElement | null) {
    const had = this.entries.get(key)
    // An element no longer an item (gone from the page, or one that stays now: the focused tab) shows as it is.
    if (had?.el && (had.el !== el || !item)) {
      this.observer?.unobserve(had.el)
      had.el.removeAttribute('data-out')
      had.el.removeAttribute('data-compact')
    }
    if (!item || !el) {
      if (had) { this.entries.delete(key); this.dirty() }
      return
    }
    this.entries.set(key, { ...item, key, el })
    if (had?.el !== el && item.compactAt === undefined) this.observer?.observe(el)
    // An open menu shows its row as it is now.
    if (this.gone.includes(key)) this.emit()
    this.dirty()
  }

  /** An item's element, while it's in the bar. */
  elementOf = (key: string) => this.entries.get(key)?.el ?? undefined

  /** Measure again before the frame is drawn: after this commit's effects, once. */
  dirty() {
    if (this.scheduled) return
    this.scheduled = true
    queueMicrotask(() => { this.scheduled = false; this.update() })
  }

  /** The items gone, in the bar's order, with a row. */
  rows(): Entry[] {
    return this.gone.flatMap((key) => this.entries.get(key) ?? []).filter((e) => e.row !== undefined)
  }

  /** Choose a gone item's row: its own action, else a click on its first control (or on it, if it's one). */
  choose(key: string) {
    const entry = this.entries.get(key)
    if (!entry?.el) return
    if (entry.select) return entry.select()
    const control = controlOf(entry.el)
    if (control) control.click()
    else console.error(`The title bar's ${key} has nothing to click`)
  }

  private emit() { this.version++; for (const listener of this.listeners) listener() }

  update() {
    const bar = this.bar
    if (!bar?.isConnected) return
    const entries = [...this.entries.values()].filter((e): e is Entry & { el: HTMLElement } => Boolean(e.el && bar.contains(e.el)))

    // ── Read ──
    const barGap = gapOf(bar)
    if (this.more && !this.more.hidden) this.moreWidth = this.more.getBoundingClientRect().width
    const moreCost = this.moreWidth + barGap
    const crumb = bar.querySelector(':scope > .titlebar__crumb')
    const end = bar.querySelector(':scope > .app__titlebar-end')
    // The room left: the space between the crumbs and the end, and what the title has beyond what it keeps; less what
    // spills out of the crumbs (squeezed past the title, the rest of them) and out of the bar.
    const free = crumb && end ? end.getBoundingClientRect().left - crumb.getBoundingClientRect().right - barGap : 0
    const title = crumb?.querySelector<HTMLElement>('.thread__title')
    const titleRoom = title ? title.getBoundingClientRect().width - Math.min(title.scrollWidth, TITLE_KEPT) : 0
    const spill = (el: Element | null) => el ? Math.max(0, el.scrollWidth - el.clientWidth) : 0
    const slack = free + titleRoom - spill(crumb) - spill(bar)
    const measures = new Map<string, Measure>()
    // One that draws nothing (a view with nothing to say for this thread) isn't an item: there's nothing to move.
    const empty = new Set<string>()
    for (const e of entries) {
      const width = e.el.getBoundingClientRect().width
      if (!width) { empty.add(e.key); continue }
      const style = getComputedStyle(e.el)
      const outer = (parseFloat(style.marginLeft) || 0) + (parseFloat(style.marginRight) || 0) + gapOf(e.el.parentElement)
      let parts = 0
      if (e.compactAt !== undefined) {
        const inner = parseFloat(style.columnGap) || 0
        for (const part of e.el.querySelectorAll('.overflow-part')) parts += part.getBoundingClientRect().width + inner
      }
      const shrunk = e.el.hasAttribute('data-compact') && !e.el.hasAttribute('data-out')
      const compact = shrunk ? width : width - parts
      measures.set(e.key, { full: compact + parts, compact, parts, outer })
    }

    // ── Decide ──
    const order = (a: Entry, b: Entry) => a.el!.compareDocumentPosition(b.el!) & Node.DOCUMENT_POSITION_FOLLOWING ? 1 : -1
    const steps: Step[] = []
    const groups = new Map<number, Entry[]>()
    const items = entries.filter((e) => !empty.has(e.key))
    for (const e of items) if (e.compactAt !== undefined) groups.set(e.compactAt, [...groups.get(e.compactAt) ?? [], e])
    for (const [priority, members] of groups) steps.push({ priority, members })
    for (const e of items) steps.push({ priority: e.priority, entry: e })
    // By priority; a group shrinks before an item of the same goes; of items alike, the last in the bar goes first.
    steps.sort((a, b) => a.priority - b.priority || (a.members ? -1 : b.members ? 1 : order(a.entry!, b.entry!)))
    // What a step frees, with `taken` the steps taken besides: a group shrinking, its labels (of those still there); an
    // item going, its width as it is then (a tab shrunk first, its glyph) and the gap beside it.
    const outStep = new Map(steps.flatMap((step) => step.entry ? [[step.entry.key, step] as const] : []))
    const shrinkStep = new Map(steps.flatMap((step) => (step.members ?? []).map((e) => [e.key, step] as const)))
    const frees = (step: Step, taken: Set<Step>) => {
      if (step.members) return step.members.reduce((sum, e) => sum + (taken.has(outStep.get(e.key)!) ? 0 : measures.get(e.key)!.parts), 0)
      const m = measures.get(step.entry!.key)!
      const shrunk = shrinkStep.get(step.entry!.key)
      return (shrunk && taken.has(shrunk) ? m.compact : m.full) + m.outer
    }
    // The ··· takes its room while anything's in its menu.
    const more = (taken: Set<Step>) => [...taken].some((step) => step.entry?.row !== undefined) ? moreCost : 0

    // The room there'd be with every item back, from the room now: what's gone and shrunk takes its width again.
    let none = slack + (this.more && !this.more.hidden ? moreCost : 0)
    for (const e of items) {
      const m = measures.get(e.key)!
      if (e.el.hasAttribute('data-out')) none -= m.full + m.outer
      else if (e.el.hasAttribute('data-compact')) none -= m.parts
    }
    // Give way in order until there's room; then, of what went, take back the most wanted that still fit (a tab's
    // label gone may leave room for the pin, say). The same room always comes to the same bar.
    const taken = new Set<Step>()
    let room = none
    for (const step of steps) {
      if (room - more(taken) >= 0) break
      room += frees(step, taken)
      taken.add(step)
    }
    for (const step of [...taken].reverse()) {
      const rest = new Set(taken)
      rest.delete(step)
      const after = room - frees(step, rest)
      if (after - more(rest) >= FIT) { taken.delete(step); room = after }
    }

    // ── Write ──
    const goneNow = new Set<string>()
    const compactNow = new Set<string>()
    for (const step of taken) {
      if (step.entry) goneNow.add(step.entry.key)
      for (const e of step.members ?? []) compactNow.add(e.key)
    }
    for (const e of entries) {
      e.el.toggleAttribute('data-out', goneNow.has(e.key))
      e.el.toggleAttribute('data-compact', compactNow.has(e.key))
    }
    if (this.more) this.more.hidden = !more(taken)
    const gone = entries.filter((e) => goneNow.has(e.key)).sort((a, b) => -order(a, b)).map((e) => e.key)
    if (gone.join('\n') !== this.gone.join('\n')) { this.gone = gone; this.emit() }
  }
}

/** What a click on an item clicks: the item, if it's a control, else the first inside it. */
const controlOf = (el: HTMLElement) =>
  el.matches('button, a[href], [role="button"], [role="tab"]') ? el : el.querySelector<HTMLElement>('button, a[href], [role="button"], input, select')

const OverflowContext = createContext<Overflow | null>(null)
export const OverflowProvider = OverflowContext.Provider

/** The bar's items and what's gone, for the title bar's window (none on a phone, nor in a thread's sheet). */
export const useOverflow = () => useContext(OverflowContext)

/**
 * An item of the title bar: the ref for its element. Outside the bar (a phone's thread sheet) it's drawn as it is.
 * `item: false` makes it one that stays (the strip's focused tab).
 */
export function useOverflowItem(key: string, item: OverflowItem | false): (el: HTMLElement | null) => void {
  const overflow = useOverflow()
  const [el, setEl] = useState<HTMLElement | null>(null)
  useLayoutEffect(() => { overflow?.attach(key, item || undefined, el) })
  useLayoutEffect(() => () => overflow?.attach(key, undefined, null), [overflow, key])
  return setEl
}

/** An item of the title bar drawn in a box of its own: a chip, a view, a button. */
export function OverflowBox({ id, children, className = '', ...item }: OverflowItem & { id: string; children: ReactNode; className?: string }) {
  const ref = useOverflowItem(id, item)
  return <span ref={ref} className={`titlebar__item ${className}`}>{children}</span>
}

/** A row of the ··· menu: an icon and what it says. */
export function OverflowRow({ icon: Icon, children }: { icon?: Icon | undefined; children: ReactNode }) {
  return <span className="overflow-row">{Icon ? <Icon size={14} aria-hidden /> : <span className="overflow-row__blank" />}<span className="overflow-row__label">{children}</span></span>
}

/**
 * The text an item shows (of its part `of` matches, if given), as its row says it when it has nothing of its own to
 * say: "Title: what it shows" (just its title, when it shows nothing more).
 */
export function ShownText({ id, title, of }: { id: string; title?: string; of?: string }) {
  const overflow = useOverflow()
  const el = overflow?.elementOf(id)
  const text = ((of && el?.querySelector(of)) || el)?.textContent?.replace(/\s+/g, ' ').trim() ?? ''
  if (!title) return <>{text}</>
  return <>{text && text !== title ? `${title}: ${text}` : title}</>
}

/** The ··· at the title bar's end: a row for each item that's gone, choosing it as a click on the item would. */
export function OverflowMenu() {
  const overflow = useOverflow()
  useSyncExternalStore(overflow?.subscribe ?? noSubscribe, () => overflow?.version ?? 0)
  const pending = useRef<string>(undefined)
  if (!overflow) return null
  const rows = overflow.rows()
  return (
    <span ref={overflow.setMore} className="titlebar__more" hidden>
      <Menu.Root onOpenChangeComplete={(open) => {
        // Once the menu's gone and the focus is back: the item's own menu or popover opens where the ··· is.
        if (open || !pending.current) return
        const key = pending.current
        pending.current = undefined
        overflow.choose(key)
      }}>
        <Menu.Trigger render={<IconButton label="More" className="titlebar__more-button" />}>
          <DotsThreeIcon size={18} weight="bold" aria-hidden />
        </Menu.Trigger>
        <Menu.Popup align="end" className="overflow-menu">
          {/* One with nothing to click (a chip that only says something) is there to read. */}
          {rows.map((e) => <Menu.Item key={e.key} data-item={e.key} disabled={!e.select && !(e.el && controlOf(e.el))}
            onClick={() => { pending.current = e.key }}>{e.row}</Menu.Item>)}
        </Menu.Popup>
      </Menu.Root>
    </span>
  )
}

const noSubscribe = () => () => {}
