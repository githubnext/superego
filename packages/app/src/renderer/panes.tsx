// Panes: views beside a thread. A thread keeps which are open and which has focus (pane.open, pane.focus, pane.close),
// so they follow it to every client; the agent opens them too (pane_open). Wide, they're laid out one of two ways (the
// app setting `app.panes.layout`, switched from the strip):
// - Scroll: the thread and its panes are a row of columns with room between, scrolled as Dinky's (and niri's)
//   scrolling layout is. Each column has its own width, a share of the row: the thread's half to start, a pane's its
//   kind's; the room after a column (the last one's too, at the row's end) is its handle, and the last column takes
//   what's left over until it's dragged. Past the edge the row scrolls, and the focused column scrolls just far enough
//   to show whole. The row runs a little past the last handle, so it's never at the window's edge.
// - Stack: the thread, and beside it one column its panes share, one in front at a time; the row never passes the
//   window's edge. The strip's tabs bring one to the front; so does its getting the focus (a click, ⌃Tab, ⌘⌥←/→, the
//   navigator, pane.focus from anywhere) and its opening. The thread's handle drags the line between the two.
// Either way, a pane can be maximized for a while: over the thread and the rest, which stay as they were under it (see
// maximized.ts). ⌃Tab moves the focus along. On a phone each column is the screen's width, and a swipe moves between them.
// Built in: editor and thread. Extensions and profiles add kinds with superego.pane(kind, …) (Changes is git's; a web
// page or an HTML file, browser's). A pane of a kind only an extension the thread goes without draws isn't shown.
import { createContext, Fragment, useContext, useEffect, useLayoutEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode, type RefObject } from 'react'
import { createPortal, flushSync } from 'react-dom'
import type { Pane, ThreadInfo } from '@superego/protocol'
import { ArrowRightIcon, CardsIcon, ChatTextIcon, ColumnsPlusRightIcon, CornersInIcon, CornersOutIcon, DotsThreeIcon, FileTextIcon, IconButton, Menu, SegmentedControl, XIcon, type SegmentedOption } from '@superego/ui'
import { PANE_LAYOUT, type PaneLayout } from '../shared/app-settings.ts'
import { useAppSetting } from './client.ts'
import type { PaneKind, PaneProps, UiApi } from './extension-api.ts'
import { useRegistry, whose } from './registry.tsx'
import { fileKind, paneKind, paneTitle, shownPanes } from './lookups.ts'
import { ViewScopeProvider } from './placement.tsx'
import { useNarrow } from './media.ts'
import { Contained } from './contained.tsx'
import { useLocalState } from './local-state.ts'
import { useAllThreads, useMachines } from './state.tsx'
import { ThreadBody } from './thread-body.tsx'
import { PaneMoveTo } from './view-menu.tsx'
import { FileEditor } from './file-editor.tsx'
import { BRING_FORWARD, focusRegion } from './focus.ts'
import { DEFAULT_SHARE, END, endShare, frontOf, GAP, roomFor, scrollWidths, stackWidths } from './pane-layout.ts'
import { maximizedPane, maximizedStore, restoresOn } from './maximized.ts'
import { useShortcut } from './keys.ts'
import { OverflowBox, OverflowRow, PRIORITY, useOverflowItem } from './overflow.tsx'
import { WebViewPane } from './web-view.tsx'

/** The strip's switch between the layouts. */
const LAYOUTS: SegmentedOption<PaneLayout>[] = [
  { value: 'scroll', label: 'Scroll panes', icon: ColumnsPlusRightIcon },
  { value: 'stack', label: 'Stack panes', icon: CardsIcon },
]

/** Where the strip goes, when the window has a place for it (the title bar); without one, it heads the columns. */
export const StripSlot = createContext<HTMLElement | null>(null)

export function ThreadPanes({ machine, thread, main }: { machine: PaneProps['machine']; thread: ThreadInfo; main: ReactNode }) {
  const registry = useRegistry()
  const dispatch = registry.router.dispatch
  const panes = shownPanes(registry, { machine: machine.id, thread })
  const where = { machine: machine.id, thread }
  const title = (pane: Pane) => paneTitle(registry, pane, where)
  // A pane of a view's kind can move to the other places the view fits, from its tab's ···.
  const isView = (pane: Pane) => registry.views.some((v) => v.id === pane.kind && v.fits.includes('pane'))
  const narrow = useNarrow()
  const [layout] = useAppSetting<PaneLayout>(PANE_LAYOUT)
  // On a phone each column is the screen's width either way.
  const stacked = layout === 'stack' && !narrow && panes.length > 0
  const row = useRef<HTMLDivElement>(null)
  const [scrolled, setScrolled] = useState(0)

  // The columns, left to right: the thread, then its panes, each by the key its width is kept under.
  const keys = ['thread', ...panes.map((pane) => pane.id)]
  const { rowWidth, widths, threadWidth, stackWidth, drag, reset } = useColumnWidths(row, {
    keys, stacked, narrow,
    kindShares: panes.map((pane) => paneKind(registry, pane.kind, where)?.width),
  })
  const widthOf = (pane: Pane) => widths[panes.indexOf(pane) + 1]!

  // The focused column: a pane, or (none, or one that closed) the thread.
  const focused = panes.find((p) => p.id === thread.pane)?.id

  // The pane in front of the stack, by thread, kept in this window (in either layout, for when it's stacked).
  const [fronts, setFronts] = useLocalState<Record<string, string>>('pane.front', {})
  const threadKey = `${machine.id}/${thread.id}`
  const ids = panes.map((pane) => pane.id)
  const front = frontOf(ids, fronts[threadKey], focused)
  const bringForward = (id: string) => setFronts((all) => all[threadKey] === id ? all : { ...all, [threadKey]: id })
  // A pane comes to the front as it gets the focus, here or from anywhere (pane.focus), and as it opens.
  useLayoutEffect(() => { if (focused) bringForward(focused) }, [focused])
  const known = useRef(ids)
  useLayoutEffect(() => {
    const opened = ids.filter((id) => !known.current.includes(id)).at(-1)
    known.current = ids
    if (opened) bringForward(opened)
  }, [ids.join()])
  // A pane maximized over the rest (see maximized.ts), while it lasts; forgotten once it doesn't, or the thread goes.
  // Wide only: on a phone each column is the screen's already.
  const stored = maximizedStore.use()
  const maximized = narrow ? undefined : maximizedPane(stored, threadKey, ids)
  const maximizedRef = useRef(maximized)
  maximizedRef.current = maximized
  useEffect(() => { if (stored && !maximized) maximizedStore.set(undefined) }, [stored, maximized])
  useEffect(() => () => maximizedStore.set(undefined), [])
  // Esc restores it, unless something in the pane took it (an editor's search, a terminal) or it's pressed in a dialog.
  useEffect(() => {
    if (!maximized) return
    const onKey = (event: KeyboardEvent) => {
      const at = event.target instanceof Element ? event.target : null
      if (!restoresOn(event, at === document.body || Boolean(at?.closest('.app__main')))) return
      event.preventDefault()
      maximizedStore.set(undefined)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [maximized])
  const maximize = (pane: Pane) => void dispatch('pane.maximize', { pane: pane.id }, { source: 'panes' })
  // One at the back the focus is going to (see focus.ts) comes to the front first, so it can take it; one under a
  // maximized pane, the layout restored.
  useEffect(() => {
    const el = row.current
    const bring = (event: Event) => {
      const id = (event.target as HTMLElement).dataset.column
      if (!id) return
      flushSync(() => {
        if (maximizedRef.current && id !== maximizedRef.current) maximizedStore.set(undefined)
        if (id !== 'thread') bringForward(id)
      })
    }
    el?.addEventListener(BRING_FORWARD, bring)
    return () => el?.removeEventListener(BRING_FORWARD, bring)
  }, [panes.length > 0])
  const columnOf = (id: string | undefined) => row.current?.querySelector<HTMLElement>(`[data-column="${id ?? 'thread'}"]`)
  // Brought into view as it gets the focus: just far enough to show it whole.
  useEffect(() => {
    columnOf(focused)?.scrollIntoView({ inline: 'nearest', block: 'nearest', behavior: 'smooth' })
  }, [focused, panes.length, rowWidth])

  const settled = useRef<ReturnType<typeof setTimeout>>(undefined)

  const focus = (pane?: string) => { if (pane !== focused) void dispatch('pane.focus', { thread: thread.id, ...(pane ? { pane } : {}) }, { machine: machine.id, source: 'panes' }) }
  // A click on a column's own parts that leaves the focus outside it, or on its title (which a click focuses): the
  // focus goes to what's used there, the editor's text or the page, as the keyboard takes it there. Shown as a click's
  // would be, unless the click came from the keyboard (⏎ on the title).
  const takeFocus = (event: React.MouseEvent<HTMLElement>) => {
    // A click in what the column portals out (its menu) isn't on the column: the menu keeps the focus.
    if (!event.currentTarget.contains(event.target as Node)) return
    const at = document.activeElement
    if (!event.currentTarget.contains(at) || at?.matches('.panes__label')) focusRegion(event.currentTarget, { visible: event.detail === 0 })
  }
  const close = (pane: Pane) => void dispatch('pane.close', { thread: thread.id, pane: pane.id }, { machine: machine.id, source: 'panes' })

  // How much of each column is in view, and on which side the rest are: for the strip. Stacked, the thread and the
  // pane in front are; the rest are behind. Maximized, only that pane is: the rest are under it.
  const starts = widths.map((_, i) => widths.slice(0, i).reduce((sum, w) => sum + w + GAP, 0))
  const shown = widths.map((w, i) => maximized ? Number(keys[i] === maximized) : stacked ? Number(i === 0 || keys[i] === front)
    : w ? Math.max(0, Math.min(starts[i]! + w, scrolled + rowWidth) - Math.max(starts[i]!, scrolled)) / w : 0)
  const side = (i: number) => shown[i]! >= 0.5 ? undefined : stacked || maximized ? 'behind' as const : starts[i]! < scrolled ? 'left' as const : 'right' as const

  const gap = (index: number) => !narrow && (
    <div className="panes__gap" onPointerDown={drag(index)} onDoubleClick={() => reset(index)} role="separator" aria-orientation="vertical"
      aria-label={`${index === 0 ? 'Thread' : title(panes[index - 1]!)} width`} title="Drag to resize, double-click to reset" />
  )
  const onScroll = () => {
    const el = row.current
    if (!el) return
    setScrolled(el.scrollLeft)
    // On a phone, a swipe that settles on a column gives it the focus.
    if (!narrow) return
    clearTimeout(settled.current)
    settled.current = setTimeout(() => {
      if (!rowWidth) return
      const index = Math.round(el.scrollLeft / rowWidth)
      focus(index === 0 ? undefined : panes[index - 1]?.id)
    }, 120)
  }
  // A tab in the strip: brings its column into view and gives it the focus.
  const show = (pane?: Pane) => {
    const column = columnOf(pane?.id)
    column?.scrollIntoView({ inline: 'nearest', block: 'nearest', behavior: 'smooth' })
    focus(pane?.id)
    if (column) focusRegion(column, { visible: false })
  }
  const [notes, setNotes] = useState<Record<string, ReactNode>>({})
  const noteFor = useRef(new Map<string, (note: ReactNode) => void>())
  const setNoteFor = (id: string) => {
    let set = noteFor.current.get(id)
    if (!set) noteFor.current.set(id, set = (note) => setNotes((all) => ({ ...all, [id]: note })))
    return set
  }
  // The thread's own tab, then each pane's, drawn as its kind says (its glyph, and whether its title is a file's name).
  const tabs: StripTab[] = [
    { id: undefined, label: 'Thread', kind: { icon: ChatTextIcon }, pane: undefined, width: widths[0]!, shown: shown[0]!, away: side(0) },
    ...panes.map((pane, i) => ({
      id: pane.id, label: title(pane), kind: paneKind(registry, pane.kind, where), pane, note: notes[pane.id], width: widths[i + 1]!, shown: shown[i + 1]!, away: side(i + 1),
    })),
  ]
  // The tab raised: the focused column's; stacked, the one in front once a pane opening covers the focused one.
  const current = stacked && focused && focused !== front ? front : focused

  return (
    <div className={`sheet ${panes.length ? 'has-panes' : ''}`}>
      {panes.length > 0 && <PaneStrip tabs={tabs} current={current} stacked={stacked} narrow={narrow} onShow={show} />}
      {/* Stacked, a grid: the thread, its handle, the panes on top of each other, the room at the end. */}
      <div className={`panes ${narrow ? 'panes--narrow' : ''} ${stacked ? 'panes--stack' : ''} ${maximized ? 'has-maximized' : ''}`} ref={row} onScroll={onScroll}
        style={stacked ? { gridTemplateColumns: `${threadWidth}px ${GAP}px ${stackWidth}px ${GAP}px` } : undefined}>
        {/* Focus moving into a column (a click, a key) makes it the focused one: the app and the keyboard agree. */}
        <div data-column="thread" tabIndex={-1} className={`panes__column panes__column--thread ${maximized ? 'is-covered' : ''}`} inert={Boolean(maximized)}
          style={{ width: widths[0] }} onPointerDownCapture={() => focus(undefined)} onFocusCapture={() => focus(undefined)}>{main}</div>
        {/* The gap after each column is its handle: drag it to make that one wider or narrower. */}
        {gap(0)}
        {panes.map((pane, index) => (
          <Fragment key={pane.id}>
          <PaneColumn pane={pane} title={title(pane)} focused={pane.id === focused} width={widthOf(pane)}
            behind={stacked && pane.id !== front && pane.id !== maximized} maximized={maximized === undefined ? undefined : pane.id === maximized}
            onFocus={() => focus(pane.id)} onClick={takeFocus} onClose={() => close(pane)} {...(narrow ? {} : { onMaximize: () => maximize(pane) })}
            view={isView(pane) ? { view: pane.kind, machine: machine.id, thread } : undefined}>
            <TabNote.Provider value={setNoteFor(pane.id)}><PaneBody machine={machine} thread={thread} pane={pane} /></TabNote.Provider>
          </PaneColumn>
          {/* Scrolled, its place in the row is kept while it's over the rest, so they stay where they were. */}
          {!stacked && pane.id === maximized && <div className="panes__kept" style={{ width: widthOf(pane) }} aria-hidden />}
          {!stacked && gap(index + 1)}
          </Fragment>
        ))}
        {stacked && <div className="panes__end" aria-hidden />}
        {!stacked && !narrow && panes.length > 0 && <div className="panes__tail" style={{ width: END }} aria-hidden />}
      </div>
    </div>
  )
}

/**
 * Each column's width in px, from the shares of the row kept in this window (by `keys`: the thread's, then each
 * pane's), and the dragging of the handle after each. Until it's dragged, a column takes its share: the thread's half,
 * a pane's its kind's (`kindShares`). The last one's share is kept apart (`<key>:end`): dragged from its own handle at
 * the end, it's its width while it is last; never dragged, it takes what's left over. Stacked, the thread's is the only
 * one: its panes' column takes the rest. On a phone each is the row's width.
 */
function useColumnWidths(row: RefObject<HTMLDivElement | null>, { keys, kindShares, stacked, narrow }: { keys: string[]; kindShares: (number | undefined)[]; stacked: boolean; narrow: boolean }) {
  const [shares, setShares] = useLocalState<Record<string, number>>('pane.widths', {})
  const [rowWidth, setRowWidth] = useState(0)
  const hasPanes = keys.length > 1
  useLayoutEffect(() => {
    const el = row.current
    if (!el) return
    const observer = new ResizeObserver(() => setRowWidth(el.clientWidth))
    observer.observe(el)
    setRowWidth(el.clientWidth)
    return () => observer.disconnect()
  }, [hasPanes])

  const last = stacked ? 1 : keys.length - 1
  const keyOf = (index: number) => index === last ? `${keys[index]}:end` : keys[index]!
  const shareOf = (index: number) => index === last ? shares[keyOf(index)] : shares[keys[index]!] ?? (index === 0 ? DEFAULT_SHARE : kindShares[index - 1] ?? DEFAULT_SHARE)
  // The room the columns share: the row less the gap after each (stacked, the thread's and the stack's).
  const room = narrow ? rowWidth : roomFor(rowWidth, stacked ? 2 : keys.length)
  const [threadWidth, stackWidth] = stackWidths(room, shares.thread)
  const widths = narrow ? keys.map(() => rowWidth)
    : stacked ? [threadWidth, ...keys.slice(1).map(() => stackWidth)]
    : scrollWidths(room, keys.map((_, i) => shareOf(i)))

  // The gap after a column resizes it (`index`): its share of the row, kept for next time. The last one's, dragged to
  // about what the others leave, takes that again; past it, it's wider and the row scrolls. A double click puts any
  // back as it was.
  const drag = (index: number) => (event: React.PointerEvent) => {
    if (event.button !== 0) return
    const startX = event.clientX
    const start = widths[index]!
    const key = keyOf(index)
    const used = widths.slice(0, last).reduce((sum, w) => sum + w, 0)
    const move = (e: PointerEvent) => {
      const width = start + e.clientX - startX
      const next = index === last ? endShare(width, room, used) : Math.min(0.85, Math.max(0.15, width / Math.max(1, room)))
      setShares(({ [key]: _, ...rest }) => next === undefined ? rest : { ...rest, [key]: next })
    }
    const root = document.documentElement
    const up = () => {
      root.classList.remove('is-resizing-columns')
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up)
    }
    root.classList.add('is-resizing-columns')
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    event.preventDefault()
    event.stopPropagation()
  }
  const reset = (index: number) => setShares(({ [keyOf(index)]: _, ...rest }) => rest)
  return { rowWidth, widths, threadWidth, stackWidth, drag, reset }
}

/** Whether a pane's title is a file's name, as its kind says. */
const isFile = (kind: Pick<PaneKind, 'file'> | undefined, pane: Pane | undefined) =>
  typeof kind?.file === 'function' ? Boolean(pane && kind.file(pane)) : Boolean(kind?.file)

/** A column's tab in the strip: the thread's (no `id`) or a pane's, and how much of its column is in view. */
type StripTab = {
  id: string | undefined; label: string; kind: Pick<PaneKind, 'icon' | 'file'> | undefined; pane: Pane | undefined
  /** What the pane says on its tab (see useTabNote). */
  note?: ReactNode
  /** Its column's width, and how much of it is in view (0–1). */
  width: number; shown: number
  /** Where its column is, when it's mostly out of view. */
  away: 'left' | 'right' | 'behind' | undefined
}

/**
 * The strip: a tab for the thread and each pane (`current` raised), bringing its column into view; wide, the row in
 * small (scrolled) and the switch between the layouts. In the title bar, where the window has a place for it.
 */
function PaneStrip({ tabs, current, stacked, narrow, onShow }: { tabs: StripTab[]; current: string | undefined; stacked: boolean; narrow: boolean; onShow(pane: Pane | undefined): void }) {
  const dispatch = useRegistry().router.dispatch
  const slot = useContext(StripSlot)
  const total = tabs.reduce((sum, tab) => sum + tab.width, 0) || 1
  const layout = (next: PaneLayout) => void dispatch('pane.layout', { layout: next }, { source: 'strip' }).catch((error) => console.error(error))
  // In the title bar, short of room, its parts give way (overflow.tsx): the map, then the switch, then the other tabs.
  const inBar = Boolean(slot)
  const mapRef = useOverflowItem('strip:map', inBar && { priority: PRIORITY.map })
  const strip = (
    <div className={`strip ${narrow ? 'strip--narrow' : ''}`} role="tablist" aria-label="The thread and its panes">
      {/* Stacked, the thread stands on its own beside the stack's tabs: one tablist still, in the same order. */}
      {(stacked ? [tabs.filter((tab) => !tab.id), tabs.filter((tab) => tab.id)] : [tabs]).map((group, i) => (
        <div key={i} className={`strip__tabs ${stacked && i === 0 ? 'strip__tabs--thread' : ''}`}>
          {group.map((tab) => <StripTabButton key={tab.id ?? 'thread'} tab={tab} focused={tab.id === current} inBar={inBar} onShow={onShow} />)}
        </div>
      ))}
      {!narrow && (
        <>
          {/* The row in small: each column a bar as wide as it is, the ones in view darker. */}
          {!stacked && (
            <span className="strip__map" aria-hidden ref={mapRef}>
              {tabs.map((tab, i) => <i key={i} className={tab.shown >= 0.5 ? 'is-in' : ''} style={{ width: Math.max(4, Math.round((tab.width / total) * 52)) }} />)}
            </span>
          )}
          <OverflowBox id="strip:layout" priority={PRIORITY.layout} className="strip__layout-item"
            row={<OverflowRow icon={stacked ? ColumnsPlusRightIcon : CardsIcon}>{stacked ? 'Scroll panes' : 'Stack panes'}</OverflowRow>}
            select={() => layout(stacked ? 'scroll' : 'stack')}>
            <SegmentedControl label="Pane layout" className="strip__layout" options={LAYOUTS} value={stacked ? 'stack' : 'scroll'} onChange={layout} />
          </OverflowBox>
        </>
      )}
    </div>
  )
  return slot ? createPortal(strip, slot) : strip
}

/** A column's tab: in the title bar, short of room, one not focused shrinks to its glyph, then goes to the ···. */
function StripTabButton({ tab, focused, inBar, onShow }: { tab: StripTab; focused: boolean; inBar: boolean; onShow(pane: Pane | undefined): void }) {
  const Icon = tab.kind?.icon
  // The whole of what the tab may cut short: a file's path, a page's address, or its title.
  const { path, url } = (tab.pane?.params ?? {}) as { path?: string; url?: string }
  const full = path ?? url ?? tab.label
  const ref = useOverflowItem(`tab:${tab.id ?? 'thread'}`, inBar && !focused && {
    priority: PRIORITY.tabs, compactAt: PRIORITY.tabsCompact, row: <OverflowRow icon={Icon}>{tab.label}</OverflowRow>,
  })
  return (
    <button ref={ref} type="button" role="tab" aria-selected={focused}
      className={`strip__tab ${focused ? 'is-focused' : tab.away ? 'is-away' : 'is-shown'}`}
      title={full}
      onClick={() => onShow(tab.pane)}>
      {Icon && <Icon size={14} aria-hidden />}
      <span className={`strip__label overflow-part ${isFile(tab.kind, tab.pane) ? 'strip__label--file' : ''}`}>{tab.label}</span>
      {tab.id && tab.note && <span className="strip__note overflow-part">{tab.note}</span>}
      {tab.away === 'right' && <ArrowRightIcon className="strip__away" size={11} aria-hidden />}
    </button>
  )
}

/** What a pane says on its tab in the strip (Changes: +3 −1), by pane. */
const TabNote = createContext<((note: ReactNode) => void) | null>(null)

/** Shown on the pane's tab in the strip, after its title. */
export function useTabNote(note: ReactNode, key: string) {
  const set = useContext(TabNote)
  useEffect(() => { set?.(note); return () => set?.(undefined) }, [key])
}

/** Where a pane's own header things go (a count, Refresh): beside its title, at the top of its column. */
const HeaderSlot = createContext<HTMLElement | null>(null)

/** Shown in the pane's header, beside its title, rather than in its body. */
export function PaneHeader({ children }: { children: ReactNode }) {
  const at = useContext(HeaderSlot)
  return at ? createPortal(children, at) : <div className="pane-bar">{children}</div>
}

/**
 * In a `PaneHeader`: a note that takes the room left, cut short to fit (a count, a path). `code`: in the monospace face;
 * `href`: a link, opened outside the app.
 */
export function PaneNote({ children, title, code, href }: { children: ReactNode; title?: string; code?: boolean; href?: string }) {
  if (href) return <a className="pane-header__note pane-header__url" title={title} href={href} target="_blank" rel="noreferrer">{children}</a>
  return code ? <code className="pane-header__note" title={title}>{children}</code> : <span className="pane-header__note" title={title}>{children}</span>
}

/** In a `PaneHeader`: a small button (Refresh, Reload). */
export const PaneButton = (props: Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className' | 'type'>) => <button type="button" className="pane-header__button" {...props} />

/** What a pane says in place of what it shows: Loading…, nothing here, or what went wrong. Centred in the pane. */
export const PaneMessage = ({ children }: { children: ReactNode }) => <div className="pane-empty">{children}</div>

/**
 * Marks a pane's head `data-scrolled` while what's right under it is scrolled up beneath it, for its shadow: the tab,
 * or a bar of the pane's own under it (an editor's path and modes). Whatever scrolls in a pane is the pane kind's own
 * (an editor, a list, a terminal), so it listens for scroll events on the way down (they don't bubble) and minds only a
 * scroller whose top meets the bottom of one of those: one further down (a code block, a file's sideways scroll) has
 * something between. Reads layout only when a scroll has already laid out, and only touches an attribute React doesn't
 * own (the tab's class changes with the focus).
 */
function useScrolledUnder(column: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const el = column.current
    if (!el) return
    const onScroll = (event: Event) => {
      const target = event.target
      if (!(target instanceof Element)) return
      const top = target.getBoundingClientRect().top
      const head = [...el.querySelectorAll(':scope > .panes__tab, :scope > .panes__body .pane-bar')]
        .find((bar) => Math.abs(bar.getBoundingClientRect().bottom - top) <= 1)
      head?.toggleAttribute('data-scrolled', target.scrollTop > 0)
    }
    el.addEventListener('scroll', onScroll, { capture: true, passive: true })
    return () => el.removeEventListener('scroll', onScroll, { capture: true })
  }, [column])
}

function PaneColumn({ pane, title, focused, width, behind, maximized, onFocus, onClick, onClose, onMaximize, view, children }: {
  pane: Pane; title: string; focused: boolean; width: number; behind: boolean
  /** Whether it's the one maximized, while one is (undefined: none is). */
  maximized: boolean | undefined
  onFocus(): void; onClick(event: React.MouseEvent<HTMLElement>): void; onClose(): void
  /** Maximize it, or restore it (wide only). */
  onMaximize?: () => void
  /** The view it shows, if it's one: what its menu moves elsewhere (see PaneMoveTo). */
  view?: { view: string; machine: string; thread: ThreadInfo }; children: ReactNode
}) {
  const [slot, setSlot] = useState<HTMLElement | null>(null)
  const column = useRef<HTMLDivElement>(null)
  useScrolledUnder(column)
  const keys = useShortcut('pane.maximize')
  const closeKeys = useShortcut('pane.closeFocused')
  const label = maximized ? 'Restore' : 'Maximize'
  // At the back of a stack, or under a maximized pane, it's kept (its page, its place in a file), out of sight and out
  // of reach.
  const covered = maximized === false
  return (
    <div ref={column} data-column={pane.id} tabIndex={-1} className={`panes__column ${behind ? 'is-behind' : ''} ${maximized ? 'is-maximized' : covered ? 'is-covered' : ''}`}
      inert={behind || covered} style={maximized ? undefined : { width }} onPointerDownCapture={onFocus} onFocusCapture={onFocus} onClick={onClick}>
      <div className={`panes__tab ${focused ? 'is-active' : ''}`}>
        <button className="panes__label" title={title} onDoubleClick={onMaximize}>{title}</button>
        <span className="panes__tools" ref={setSlot} />
        {/* The pane's menu: moving its view elsewhere, with what its buttons do. Only for a view that has somewhere to go. */}
        {view && <PaneMoveTo {...view} pane={pane.id} menu={(moveTo) => (
          <Menu.Root>
            <Menu.Trigger render={<IconButton label={`${title}: more`} className="view-menu__button" />}>
              <DotsThreeIcon size={16} weight="bold" aria-hidden />
            </Menu.Trigger>
            <Menu.Popup align="end" className="view-menu pane-menu">
              {onMaximize && <Menu.Item data-maximize hint={keys} onClick={onMaximize}>{label}</Menu.Item>}
              {moveTo}
              <Menu.Separator />
              <Menu.Item data-close hint={closeKeys} onClick={onClose}>Close</Menu.Item>
            </Menu.Popup>
          </Menu.Root>
        )} />}
        {onMaximize && (
          <button className="panes__maximize" aria-label={`${label} ${title}`} title={keys ? `${label} (${keys})` : label} onClick={onMaximize}>
            {maximized ? <CornersInIcon size={13} aria-hidden /> : <CornersOutIcon size={13} aria-hidden />}
          </button>
        )}
        <button className="panes__close" aria-label={`Close ${title}`} onClick={onClose}><XIcon size={12} aria-hidden /></button>
      </div>
      <div className="panes__body"><HeaderSlot.Provider value={slot}>{children}</HeaderSlot.Provider></div>
    </div>
  )
}

export function PaneBody({ machine, thread, pane }: PaneProps) {
  const registry = useRegistry()
  const kind = paneKind(registry, pane.kind, { machine: machine.id, thread })
  if (!kind) return <div className="pane-empty">No pane of kind “{pane.kind}” here{thread.profile ? '' : ' (a profile may add it)'}.</div>
  const Component = kind.component
  // A view open as a pane is drawn for its thread: its placement hooks read and change that thread's places. A web page
  // in it is kept for the pane, drawn or not (kept-web-views.ts).
  return (
    <ViewScopeProvider value={{ machine: machine.id, thread }}>
      <WebViewPane.Provider value={{ machine: machine.id, thread: thread.id, pane: pane.id }}>
        <Contained name={whose(kind, pane.kind)}><Component machine={machine} thread={thread} pane={pane} /></Contained>
      </WebViewPane.Provider>
    </ViewScopeProvider>
  )
}

// ── Built-in panes ──────────────────────────────────────────────────────────────────────────────────────────────

/** The file a pane shows, by name: its tab's title. */
const fileName = (pane: Pane) => (pane.params as { path?: string } | undefined)?.path?.split('/').at(-1)

export function registerBuiltInPanes(superego: UiApi) {
  superego.pane('editor', { title: (pane) => fileName(pane) ?? 'Editor', icon: FileTextIcon, file: true, component: EditorPane, fallback: true })
  superego.pane('thread', { title: 'Thread', icon: ChatTextIcon, component: ThreadPane })
}

const params = <T,>(pane: Pane) => (pane.params ?? {}) as T

/** A file in the thread's folder, to read and edit (see FileEditor). */
function EditorPane({ machine, thread, pane }: PaneProps) {
  const { path, line } = params<{ path?: string; line?: number }>(pane)
  const registry = useRegistry()
  const dispatch = registry.router.dispatch
  if (!path) return <div className="pane-empty">No file given.</div>
  // Another file from beside it (the file tree): shown here instead, or in a pane of its own beside (always, when another
  // kind takes that file).
  const open = (file: string, { beside }: { beside: boolean }) => {
    const kind = fileKind(registry, { machine: machine.id, thread }, file)
    if (!kind) return
    if (beside || kind !== pane.kind) void dispatch('pane.open', { thread: thread.id, kind, params: { path: file } }, { machine: machine.id, source: 'editor' })
    else void dispatch('pane.update', { thread: thread.id, pane: pane.id, params: { path: file } }, { machine: machine.id, source: 'editor' })
  }
  return <FileEditor key={path} machine={machine} thread={thread} path={path} {...(line ? { line } : {})} onOpenFile={open} />
}

/** Another thread, beside this one. */
function ThreadPane({ pane }: PaneProps) {
  const { thread: id, machine: machineId } = params<{ thread?: string; machine?: string }>(pane)
  const machines = useMachines()
  const threads = useAllThreads()
  const machine = machines.find((m) => m.id === (machineId ?? 'local'))
  const thread = machine && threads[machine.id]?.find((s) => s.id === id)
  if (!machine || !thread) return <div className="pane-empty">No thread {id ?? ''} here.</div>
  return <div className="thread-pane"><ThreadBody machine={machine} thread={thread} /></div>
}

