// Panes: views beside a thread. A thread keeps which are open and which has focus (pane.open, pane.focus, pane.close),
// so they follow it to every client; the agent opens them too (pane_open). Wide, they're laid out one of two ways (the
// app setting `app.panes.layout`, switched from the strip):
// - Scroll: the thread and its panes are a row of columns with room between, scrolled as Dinky's (and niri's)
//   scrolling layout is. Each column has its own width: the thread's half the row to start, a pane's its kind's share;
//   the room after a column (the last one's too, at the row's end) is its handle, and the last column takes what's
//   left over until it's dragged. Dragged, a width is kept with the thread (pane.resize), as a factor of the window's
//   width: the same proportions in any window, on any client. Past the edge the row scrolls, and the focused column
//   scrolls just far enough to show whole. The row runs a little past the last handle, so it's never at the window's edge. Unless it's turned
//   off (`app.panes.keepThread`, the strip's pin), the thread is kept in view: its column and handle stand still at the
//   row's start (sticky) while its panes scroll beside it, and a pane is brought into view beside it.
// - Stack: the thread, and beside it one column its panes share, one in front at a time; the row never passes the
//   window's edge. The strip's tabs bring one to the front; so does its getting the focus (a click, ⌃Tab, ⌘⌥←/→, the
//   navigator, pane.focus from anywhere) and its opening. The thread's handle drags the line between the two.
// Either way, a column (the thread's or a pane's) can be maximized for a while: over the rest, which stay as they were under it (see
// maximized.ts). ⌃Tab moves the focus along. A pane's tab dragged along the strip moves it among the others
// (pane.move, kept with the thread; ⌘⌥⇧←/→ too). On a phone each column is the screen's width, and a swipe moves between them.
// Built in: editor and thread. Extensions and profiles add kinds with superego.pane(kind, …) (Changes is git's; a web
// page or an HTML file, browser's). A pane of a kind only an extension the thread goes without draws isn't shown.
import { createContext, Fragment, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode, type RefObject } from 'react'
import { createPortal, flushSync } from 'react-dom'
import type { Pane, ThreadInfo } from '@superego/protocol'
import { ArrowRightIcon, autoFocusOnOpen, CardsIcon, ChatTextIcon, ColumnsPlusRightIcon, CornersInIcon, CornersOutIcon, DotsThreeIcon, FileTextIcon, IconButton, Menu, PushPinIcon, SegmentedControl, usePortalAttributes, XIcon, type SegmentedOption } from '@superego/ui'
import { PANE_KEEP_THREAD, PANE_LAYOUT, type PaneLayout } from '../shared/app-settings.ts'
import { has, useAppSetting } from './client.ts'
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
import { arranged, columnShares, DEFAULT_SHARE, dropIndex, END, endShare, frontOf, GAP, keptWidths, moved, placeAmong, roomFor, scrollWidths, slideOf, stackWidths, windowFactor, type SavedWidth } from './pane-layout.ts'
import { maximizedColumn, maximizedStore, restoresOn, THREAD_COLUMN } from './maximized.ts'
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

/**
 * Told the row of columns as it mounts, on a phone: the drawer's swipe edge goes in it (Shell.tsx), at its start, over
 * the thread's column, and scrolls out of the way with it as a pane comes in.
 */
export const SwipeEdgeRef = createContext<((row: HTMLElement | null) => void) | null>(null)

/**
 * How far each thread's row was scrolled when last seen, by `machine/thread`, kept in this window, and what it showed
 * then (`view`: the focused column, the panes, whether the thread was kept in view). The row is drawn afresh each time
 * the thread shows (back from Settings, from Ego's thread, from another thread): it comes back scrolled as it was left.
 */
const rowScrolls = new Map<string, { left: number; view: string }>()

export function ThreadPanes({ machine, thread, main }: { machine: PaneProps['machine']; thread: ThreadInfo; main: ReactNode }) {
  const registry = useRegistry()
  const dispatch = registry.router.dispatch
  const threadKey = `${machine.id}/${thread.id}`
  // In the thread's order; while a move from the strip is on its way to the thread, in the order asked for.
  const served = shownPanes(registry, { machine: machine.id, thread })
  const [asked, setAsked] = useState<{ thread: string; order: string[] }>()
  const panes = arranged(served, asked?.thread === threadKey ? asked.order : undefined)
  const servedOrder = served.map((pane) => pane.id).join()
  // Once the thread has it (or panes opened or closed meanwhile), the thread's own order again.
  useEffect(() => {
    if (asked && (asked.thread !== threadKey || panes === served || servedOrder === asked.order.join())) setAsked(undefined)
  }, [asked, threadKey, servedOrder])
  // A move or resize that failed, by column (the thread's, or a pane's): said on its tab until the next.
  const [failed, setFailed] = useState<{ column: string; message: string }>()
  const where = { machine: machine.id, thread }
  const title = (pane: Pane) => paneTitle(registry, pane, where)
  // A pane of a view's kind can move to the other places the view fits, from its tab's ···.
  const isView = (pane: Pane) => registry.views.some((v) => v.id === pane.kind && v.fits.includes('pane'))
  const swipeEdgeRef = useContext(SwipeEdgeRef)
  const narrow = useNarrow()
  const [layout] = useAppSetting<PaneLayout>(PANE_LAYOUT)
  // On a phone each column is the screen's width either way.
  const stacked = layout === 'stack' && !narrow && panes.length > 0
  // Scrolled and wide, the thread kept in view while its panes scroll beside it (unless that's turned off).
  const [keepThread] = useAppSetting<boolean>(PANE_KEEP_THREAD)
  const kept = keepThread !== false && !stacked && !narrow && panes.length > 0
  const row = useRef<HTMLDivElement>(null)
  const setRow = useCallback((element: HTMLDivElement | null) => { row.current = element; swipeEdgeRef?.(element) }, [swipeEdgeRef])
  const [scrolled, setScrolled] = useState(0)

  // The columns, left to right: the thread, then its panes, each by the key its width is kept under.
  const keys = [THREAD_COLUMN, ...panes.map((pane) => pane.id)]
  // Their widths kept with the thread (pane.resize), for every window: where the machine can keep them.
  const resize = (index: number, last: boolean, width: number | undefined) => {
    const column = keys[index]!
    const pane = panes[index - 1]
    setFailed(undefined)
    return dispatch('pane.resize', { thread: thread.id, ...(pane ? { pane: pane.id } : {}), ...(width === undefined ? {} : { width }), ...(last ? { last } : {}) }, { machine: machine.id, source: 'panes' })
      .catch((error: Error) => {
        console.error(`Resizing ${pane ? `pane ${pane.id}` : 'the thread'}`, error)
        setFailed({ column, message: `Couldn't keep its width: ${error.message}` })
        throw error
      })
  }
  const { rowWidth, widths, threadWidth, stackWidth, drag, reset } = useColumnWidths(row, {
    scope: threadKey, keys, stacked, narrow, kept,
    saved: [{ width: thread.width, lastWidth: thread.lastWidth }, ...panes.map((pane) => ({ width: pane.width, lastWidth: pane.lastWidth }))],
    defaults: panes.map((pane) => paneKind(registry, pane.kind, where)?.width ?? DEFAULT_SHARE),
    ...(has(machine, 'pane-resize') ? { save: resize } : {}),
  })
  const widthOf = (pane: Pane) => widths[panes.indexOf(pane) + 1]!

  // The focused column: a pane, or (none, or one that closed) the thread.
  const focused = panes.find((p) => p.id === thread.pane)?.id

  // The pane in front of the stack, by thread, kept in this window (in either layout, for when it's stacked).
  const [fronts, setFronts] = useLocalState<Record<string, string>>('pane.front', {})
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
  // A column maximized over the rest (see maximized.ts), while it lasts; forgotten once it doesn't, or the thread goes.
  // Wide only: on a phone each column is the screen's already.
  const stored = maximizedStore.use()
  const maximized = narrow ? undefined : maximizedColumn(stored, threadKey, ids)
  const threadMaximized = maximized === THREAD_COLUMN
  const maximizedRef = useRef(maximized)
  maximizedRef.current = maximized
  useEffect(() => { if (stored && !maximized) maximizedStore.set(undefined) }, [stored, maximized])
  useEffect(() => () => maximizedStore.set(undefined), [])
  // Esc restores it, unless something in the column took it (the prompt's, leaving it for the transcript) (an editor's search, a terminal) or it's pressed in a dialog.
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
  const maximize = (pane: Pane) => void dispatch('pane.maximize', { column: pane.id }, { source: 'panes' })
  // One at the back the focus is going to (see focus.ts) comes to the front first, so it can take it; one under a
  // maximized column, the layout restored.
  useEffect(() => {
    const el = row.current
    const bring = (event: Event) => {
      const id = (event.target as HTMLElement).dataset.column
      if (!id) return
      flushSync(() => {
        if (maximizedRef.current && id !== maximizedRef.current) maximizedStore.set(undefined)
        if (id !== THREAD_COLUMN) bringForward(id)
      })
    }
    el?.addEventListener(BRING_FORWARD, bring)
    return () => el?.removeEventListener(BRING_FORWARD, bring)
  }, [panes.length > 0])
  const columnOf = (id: string | undefined) => row.current?.querySelector<HTMLElement>(`[data-column="${id ?? 'thread'}"]`)
  // Brought into view as it gets the focus, and as it moves: just far enough to show it whole (beside the thread, kept
  // in view: the row's scroll-padding; the thread itself is in view already, and the panes stay as they are).
  const bringIntoView = (id: string | undefined) => {
    if (kept && !id) return
    columnOf(id)?.scrollIntoView({ inline: 'nearest', block: 'nearest', behavior: 'smooth' })
  }
  // Shown again, the row scrolled as it was left, as soon as its columns are laid out (the row measured): showing what
  // was in view then, the focused column as it was (even partly scrolled away). Shown for the first time in this
  // window, or with the focus or the panes changed meanwhile (an agent opened one), the focused column is brought in.
  const view = [focused, ids.join(), kept].join('|')
  const restored = useRef<string>(undefined)
  const asLeft = useRef(false)
  useLayoutEffect(() => {
    const el = row.current
    if (!el || !rowWidth || restored.current === threadKey) return
    restored.current = threadKey
    const left = rowScrolls.get(threadKey)
    if (!left || stacked) return
    el.scrollLeft = left.left
    setScrolled(el.scrollLeft)
    asLeft.current = left.view === view
  }, [rowWidth, threadKey])
  // Not before the row is measured: its columns aren't laid out yet.
  useEffect(() => {
    if (!rowWidth) return
    if (asLeft.current) asLeft.current = false
    else bringIntoView(focused)
  }, [focused, ids.join(), rowWidth, kept])
  // Opened with a pane focused, that pane takes the keyboard (the thread's prompt does otherwise, see composer-view.tsx).
  useEffect(() => { if (focused && autoFocusOnOpen()) focusRegion(columnOf(focused), { visible: false }) }, [])

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
  // A pane moved to `to` among those shown, from the strip: shown there at once, while the thread is told. Its place
  // among all the thread's panes is before the one shown there now (one of a kind not drawn here keeps its own).
  const move = (id: string, to: number) => {
    const order = moved(ids, id, to)
    if (order.join() === ids.join()) return
    const at = placeAmong((thread.panes ?? []).map((pane) => pane.id), ids, id, to)
    setAsked({ thread: threadKey, order })
    setFailed(undefined)
    dispatch('pane.move', { thread: thread.id, pane: id, to: at }, { machine: machine.id, source: 'strip' }).catch((error: Error) => {
      console.error(`Moving pane ${id}`, error)
      setAsked(undefined)
      setFailed({ column: id, message: `Couldn't move it: ${error.message}` })
    })
  }

  // How much of each column is in view, and on which side the rest are: for the strip. Stacked, the thread and the
  // pane in front are; the rest are behind. Maximized, only that column is: the rest are under it. Kept in view, the
  // thread always is, and the panes are in view only beside it (one scrolled under it is to the left).
  const starts = widths.map((_, i) => widths.slice(0, i).reduce((sum, w) => sum + w + GAP, 0))
  const from = scrolled + (kept ? widths[0]! + GAP : 0)
  const shown = widths.map((w, i) => maximized ? Number(keys[i] === maximized) : stacked || (kept && i === 0) ? Number(i === 0 || keys[i] === front)
    : w ? Math.max(0, Math.min(starts[i]! + w, scrolled + rowWidth) - Math.max(starts[i]!, from)) / w : 0)
  const side = (i: number) => shown[i]! >= 0.5 ? undefined : stacked || maximized ? 'behind' as const : starts[i]! < from ? 'left' as const : 'right' as const

  // The columns stay in the page in the order they opened, and are laid out in the thread's (`order`): a pane moved
  // keeps what moving it in the page would lose (the focus, a framed page).
  const placed = useRef<string[]>([])
  placed.current = [...placed.current.filter((id) => ids.includes(id)), ...ids.filter((id) => !placed.current.includes(id))]
  // The thread and its handle first; then each pane, its place kept while it's maximized, and its handle.
  const orderOf = (index: number, part: 0 | 1 | 2 = 0) => index === 0 ? part && 1 : 3 * index - 1 + part
  const gap = (index: number) => !narrow && (
    <div className={`panes__gap ${index === 0 ? 'panes__gap--thread' : ''} ${index < panes.length && (index === 0 || !stacked) ? 'is-between' : ''}`} style={{ order: orderOf(index, 2), ...(kept && index === 0 ? { left: widths[0] } : {}) }}
      onPointerDown={drag(index)} onDoubleClick={() => reset(index)} role="separator" aria-orientation="vertical"
      aria-label={`${index === 0 ? 'Thread' : title(panes[index - 1]!)} width`} title="Drag to resize, double-click to reset" />
  )
  const onScroll = () => {
    const el = row.current
    if (!el) return
    setScrolled(el.scrollLeft)
    if (restored.current === threadKey) rowScrolls.set(threadKey, { left: el.scrollLeft, view })
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
    bringIntoView(pane?.id)
    focus(pane?.id)
    if (column) focusRegion(column, { visible: false })
  }
  const [marks, setMarks] = useState<Record<string, TabMarks>>({})
  const marksFor = useRef(new Map<string, SetTabMark>())
  const setMarkFor = (id: string) => {
    let set = marksFor.current.get(id)
    if (!set) marksFor.current.set(id, set = (mark, value) => setMarks((all) => ({ ...all, [id]: { ...all[id], [mark]: value } })))
    return set
  }
  // The thread's own tab, then each pane's, drawn as its kind says (its glyph, and whether its title is a file's name).
  const tabs: StripTab[] = [
    { id: undefined, label: 'Thread', kind: { icon: ChatTextIcon }, pane: undefined, width: widths[0]!, shown: shown[0]!, away: side(0),
      ...(failed?.column === THREAD_COLUMN ? { failed: failed.message } : {}) },
    ...panes.map((pane, i) => ({
      id: pane.id, label: title(pane), kind: paneKind(registry, pane.kind, where), pane, note: marks[pane.id]?.note, glyph: marks[pane.id]?.glyph, width: widths[i + 1]!, shown: shown[i + 1]!, away: side(i + 1),
      ...(failed?.column === pane.id ? { failed: failed.message } : {}),
    })),
  ]
  // The tab raised: the focused column's; stacked, the one in front once a pane opening covers the focused one.
  const current = stacked && focused && focused !== front ? front : focused

  return (
    <div className={`sheet ${panes.length ? 'has-panes' : ''}`}>
      {panes.length > 0 && <PaneStrip tabs={tabs} current={current} stacked={stacked} kept={kept} narrow={narrow} onShow={show} onClose={close}
        {...(has(machine, 'pane-move') ? { onMove: (id: string, to: number) => { flushSync(() => move(id, to)); show(panes.find((p) => p.id === id)) } } : {})} />}
      {/* Stacked, a grid: the thread, its handle, the panes on top of each other, the room at the end. */}
      {/* Kept in view, the thread and its handle stand still at the start (sticky) and the panes pass under them: the
          row's scroll-padding shows one brought into view beside them. */}
      <div className={`panes ${narrow ? 'panes--narrow' : ''} ${stacked ? 'panes--stack' : ''} ${kept ? 'panes--keep' : ''} ${kept && scrolled > 0 ? 'is-scrolled' : ''} ${maximized ? 'has-maximized' : ''}`}
        ref={setRow} onScroll={onScroll}
        style={stacked ? { gridTemplateColumns: `${threadWidth}px ${GAP}px ${stackWidth}px ${GAP}px` } : kept ? { scrollPaddingLeft: widths[0]! + GAP } : undefined}>
        {/* Focus moving into a column (a click, a key) makes it the focused one: the app and the keyboard agree. */}
        <div data-column={THREAD_COLUMN} tabIndex={-1} className={`panes__column panes__column--thread ${threadMaximized ? 'is-maximized' : maximized ? 'is-covered' : ''}`}
          inert={Boolean(maximized) && !threadMaximized} style={threadMaximized ? undefined : { width: widths[0] }}
          onPointerDownCapture={() => focus(undefined)} onFocusCapture={() => focus(undefined)}>{main}</div>
        {/* Scrolled, its place in the row is kept while it's over the rest, so they stay where they were. */}
        {!stacked && threadMaximized && <div className="panes__kept" style={{ width: widths[0] }} aria-hidden />}
        {/* The gap after each column is its handle: drag it to make that one wider or narrower. */}
        {gap(0)}
        {placed.current.map((id) => {
          const index = ids.indexOf(id)
          const pane = panes[index]!
          return (
          <Fragment key={pane.id}>
          <PaneColumn pane={pane} title={title(pane)} focused={pane.id === focused} width={widthOf(pane)} order={orderOf(index + 1)} last={!stacked && index === panes.length - 1}
            behind={stacked && pane.id !== front && pane.id !== maximized} maximized={maximized === undefined ? undefined : pane.id === maximized}
            onFocus={() => focus(pane.id)} onClick={takeFocus} onClose={() => close(pane)} {...(narrow ? {} : { onMaximize: () => maximize(pane) })}
            view={isView(pane) ? { view: pane.kind, machine: machine.id, thread } : undefined}>
            <TabMark.Provider value={setMarkFor(pane.id)}><PaneBody machine={machine} thread={thread} pane={pane} /></TabMark.Provider>
          </PaneColumn>
          {/* Scrolled, its place in the row is kept while it's over the rest, so they stay where they were. */}
          {!stacked && pane.id === maximized && <div className="panes__kept" style={{ width: widthOf(pane), order: orderOf(index + 1, 1) }} aria-hidden />}
          {!stacked && gap(index + 1)}
          </Fragment>
          )
        })}
        {stacked && <div className="panes__end" aria-hidden />}
        {!stacked && !narrow && panes.length > 0 && <div className="panes__tail" style={{ width: END, order: orderOf(panes.length + 1) }} aria-hidden />}
      </div>
    </div>
  )
}

/**
 * Each column's width in px, from the widths the thread keeps (`saved`, by `keys`: the thread's, then each pane's; see
 * columnShares), and the dragging of the handle after each. Until it's dragged, a column takes its default: the
 * thread's half of the room, a pane's its kind's (`defaults`). The last one's is kept apart (`lastWidth`): dragged
 * from its own handle at the end, it's its width while it is last; never dragged, it takes what's left over. With the
 * thread kept in view (`kept`), no pane is wider than what's in view beside it (see keptWidths). Stacked, the thread's
 * is the only one: its panes' column takes the rest. On a phone each is the row's width.
 *
 * A drag is shown as it goes and handed to `save` as it ends (a factor of the window's width; none: the default
 * again), shown so until the thread has it (or saving fails). `scope` names the thread: a drag shows only on its own.
 */
function useColumnWidths(row: RefObject<HTMLDivElement | null>, { scope, keys, saved, defaults, stacked, narrow, kept, save }: {
  scope: string; keys: string[]; saved: SavedWidth[]; defaults: number[]; stacked: boolean; narrow: boolean; kept: boolean
  save?: (index: number, last: boolean, width: number | undefined) => Promise<unknown>
}) {
  const [rowWidth, setRowWidth] = useState(0)
  const [windowWidth, setWindowWidth] = useState(() => window.innerWidth)
  const hasPanes = keys.length > 1
  useLayoutEffect(() => {
    const el = row.current
    if (!el) return
    // The window resizing resizes the row: both are read as it does.
    const measure = () => { setRowWidth(el.clientWidth); setWindowWidth(window.innerWidth) }
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    measure()
    return () => observer.disconnect()
  }, [hasPanes])

  // The width being dragged, or dragged and on its way to the thread: by column, and whether it's the last one's.
  const [draft, setDraft] = useState<{ scope: string; column: string; last: boolean; width: number | undefined }>()
  const dragging = useRef(false)
  const live = draft?.scope === scope ? draft : undefined
  const savedOf = (index: number): SavedWidth => {
    const column = saved[index] ?? {}
    return live && keys[index] === live.column ? { ...column, [live.last ? 'lastWidth' : 'width']: live.width } : column
  }
  // Once the thread has it (or the column's gone, or another thread is shown), what the thread keeps again.
  const served = live && saved[keys.indexOf(live.column)]
  const arrived = served && served[live.last ? 'lastWidth' : 'width'] === live.width
  useEffect(() => {
    if (draft && !dragging.current && (!live || !keys.includes(live.column) || arrived)) setDraft(undefined)
  }, [draft, live, arrived, keys.join()])

  const last = stacked ? 1 : keys.length - 1
  // The room the columns share: the row less the gap after each (stacked, the thread's and the stack's).
  const room = narrow ? rowWidth : roomFor(rowWidth, stacked ? 2 : keys.length)
  const shares = columnShares(keys.map((_, i) => savedOf(i)), [DEFAULT_SHARE, ...defaults], last, windowWidth, room)
  const [threadWidth, stackWidth] = stackWidths(room, shares[0])
  const widths = narrow ? keys.map(() => rowWidth)
    : stacked ? [threadWidth, ...keys.slice(1).map(() => stackWidth)]
    : (kept ? keptWidths : scrollWidths)(room, shares)

  // Kept with the thread, a factor of the window's width; shown so meanwhile. Saving failed, what the thread keeps again.
  const keep = (index: number, width: number | undefined) => {
    const next = { scope, column: keys[index]!, last: index === last, width }
    setDraft(next)
    // `save` says what went wrong itself (on the column's tab): here, only what's shown goes back.
    save?.(index, next.last, width).catch(() => setDraft((now) => now === next ? undefined : now))
  }
  // The gap after a column resizes it (`index`), kept for next time as a factor of the window's width. The last one's,
  // dragged to about what the others leave, takes that again; past it, it's wider and the row scrolls. Shown as it's
  // dragged, kept once it's let go. A double click puts any back as it was.
  const drag = (index: number) => (event: React.PointerEvent) => {
    if (event.button !== 0) return
    const startX = event.clientX
    const start = widths[index]!
    const used = widths.slice(0, last).reduce((sum, w) => sum + w, 0)
    const column = keys[index]!
    const isLast = index === last
    let width: number | undefined = savedOf(index)[isLast ? 'lastWidth' : 'width']
    let moved = false
    dragging.current = true
    const move = (e: PointerEvent) => {
      const px = start + e.clientX - startX
      const share = index === last ? endShare(px, room, used) : Math.min(0.85, Math.max(0.15, px / Math.max(1, room)))
      width = share === undefined ? undefined : windowFactor(share * room, windowWidth)
      moved = true
      setDraft({ scope, column, last: isLast, width })
    }
    const root = document.documentElement
    const up = () => {
      root.classList.remove('is-resizing-columns')
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up)
      dragging.current = false
      if (moved) keep(index, width)
    }
    root.classList.add('is-resizing-columns')
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    event.preventDefault()
    event.stopPropagation()
  }
  const reset = (index: number) => keep(index, undefined)
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
  /** What it shows in place of its kind's glyph (see useTabGlyph). */
  glyph?: ReactNode
  /** Its column's width, and how much of it is in view (0–1). */
  width: number; shown: number
  /** Where its column is, when it's mostly out of view. */
  away: 'left' | 'right' | 'behind' | undefined
  /** Why moving or resizing it last failed, as said on it. */
  failed?: string
}

/**
 * The strip: a tab for the thread and each pane (`current` raised), bringing its column into view; wide, the row in
 * small (scrolled) and the switch between the layouts. In the title bar, where the window has a place for it. A pane's
 * tab drags along it to move the pane (`onMove`, its place among the panes; none where the machine can't).
 */
function PaneStrip({ tabs, current, stacked, kept, narrow, onShow, onClose, onMove }: {
  tabs: StripTab[]; current: string | undefined; stacked: boolean; kept: boolean; narrow: boolean; onShow(pane: Pane | undefined): void; onClose(pane: Pane): void
  onMove?: (pane: string, to: number) => void
}) {
  const dispatch = useRegistry().router.dispatch
  const slot = useContext(StripSlot)
  const total = tabs.reduce((sum, tab) => sum + tab.width, 0) || 1
  const layout = (next: PaneLayout) => void dispatch('pane.layout', { layout: next }, { source: 'strip' }).catch((error) => console.error(error))
  const keep = () => void dispatch('pane.keepThread', { keep: !kept }, { source: 'strip' }).catch((error) => console.error(error))
  // In the title bar, short of room, its parts give way (overflow.tsx): the map, then the switch, then the other tabs.
  const inBar = Boolean(slot)
  const paneIds = tabs.flatMap((tab) => tab.id ?? [])
  const mapRef = useOverflowItem('strip:map', inBar && { priority: PRIORITY.map })
  const strip = (
    <div className={`strip ${narrow ? 'strip--narrow' : ''}`} role="tablist" aria-label="The thread and its panes">
      {/* Stacked, the thread stands on its own beside the stack's tabs: one tablist still, in the same order. */}
      {(stacked ? [tabs.filter((tab) => !tab.id), tabs.filter((tab) => tab.id)] : [tabs]).map((group, i) => (
        <div key={i} className={`strip__tabs ${stacked && i === 0 ? 'strip__tabs--thread' : ''}`}>
          {group.map((tab) => <StripTabButton key={tab.id ?? 'thread'} tab={tab} focused={tab.id === current} inBar={inBar} onShow={onShow} onClose={onClose}
            {...(onMove && tab.id ? { onDrag: (event: React.PointerEvent<HTMLButtonElement>) => dragTab(event, (to, shown) => onMove(tab.id!, placeAmong(paneIds, shown, tab.id!, to))) } : {})} />)}
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
          {/* Scrolled, the pin keeping the thread in view. */}
          {!stacked && (
            <OverflowBox id="strip:keep" priority={PRIORITY.keepThread} className="strip__keep-item"
              row={<OverflowRow icon={PushPinIcon}>{kept ? 'Let thread scroll' : 'Keep thread in view'}</OverflowRow>}>
              <IconButton label="Keep thread in view" aria-pressed={kept} className={`strip__keep ${kept ? 'is-on' : ''}`} onClick={keep}>
                <PushPinIcon size={14} weight={kept ? 'fill' : 'regular'} aria-hidden />
              </IconButton>
            </OverflowBox>
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
function StripTabButton({ tab, focused, inBar, onShow, onClose, onDrag }: {
  tab: StripTab; focused: boolean; inBar: boolean; onShow(pane: Pane | undefined): void; onClose(pane: Pane): void; onDrag?: (event: React.PointerEvent<HTMLButtonElement>) => void
}) {
  const Icon = tab.kind?.icon
  // The whole of what the tab may cut short: a file's path, a page's address, or its title.
  const { path, url } = (tab.pane?.params ?? {}) as { path?: string; url?: string }
  const full = path ?? url ?? tab.label
  const ref = useOverflowItem(`tab:${tab.id ?? 'thread'}`, inBar && !focused && {
    priority: PRIORITY.tabs, compactAt: PRIORITY.tabsCompact, row: <OverflowRow icon={Icon}>{tab.label}</OverflowRow>,
  })
  return (
    <button ref={ref} type="button" role="tab" aria-selected={focused} data-pane={tab.id}
      className={`strip__tab ${focused ? 'is-focused' : tab.away ? 'is-away' : 'is-shown'} ${tab.failed ? 'is-failed' : ''}`}
      title={tab.failed ? `${tab.label}: ${tab.failed}` : full}
      onPointerDown={onDrag} onClick={() => onShow(tab.pane)}
      // A middle click closes a pane's tab, as in a browser; on the thread's it does nothing (and doesn't autoscroll).
      onMouseDown={(event) => { if (event.button === 1) event.preventDefault() }}
      onAuxClick={(event) => { if (event.button === 1 && tab.pane) onClose(tab.pane) }}>
      {tab.glyph ?? (Icon && <Icon size={14} aria-hidden />)}
      <span className={`strip__label overflow-part ${isFile(tab.kind, tab.pane) ? 'strip__label--file' : ''}`}>{tab.label}</span>
      {tab.id && tab.note && <span className="strip__note overflow-part">{tab.note}</span>}
      {tab.away === 'right' && <ArrowRightIcon className="strip__away" size={11} aria-hidden />}
    </button>
  )
}

/** How far a tab goes before it's dragged rather than clicked. */
const DRAG_THRESHOLD = 4

/**
 * A pane's tab dragged along the strip, from a press on it: past DRAG_THRESHOLD it follows the pointer (along the
 * pane tabs, no further) and the others slide aside to show where it'd go; let go, `drop` gets its place among the
 * tabs shown (`shown`, their panes, it among them), the click that follows doesn't count, and it settles into its
 * place. Esc, or the press cut short, puts it back. Under that, a click as any. Styled from the page (data-*, inline
 * transforms), not React: nothing's drawn again while the pointer moves, and what React draws meanwhile is left be.
 */
function dragTab(event: React.PointerEvent<HTMLButtonElement>, drop: (to: number, shown: string[]) => void) {
  if (event.button !== 0 || event.pointerType === 'touch') return
  const tab = event.currentTarget
  const strip = tab.closest<HTMLElement>('.strip')
  // A pane's tab in the title bar's ··· isn't in the strip to drag along.
  const tabs = [...strip?.querySelectorAll<HTMLElement>('.strip__tab[data-pane]') ?? []].filter((el) => !el.hasAttribute('data-out'))
  const from = tabs.indexOf(tab)
  if (!strip || from < 0) return
  // Where each is laid out, apart from where it's slid to (a tab still settling from the last drag).
  const slots = tabs.map((el) => ({ left: el.offsetLeft, width: el.offsetWidth }))
  const self = slots[from]!
  const size = self.width + (parseFloat(getComputedStyle(tab.parentElement!).columnGap) || 0)
  const least = slots[0]!.left - self.left
  const most = slots.at(-1)!.left + slots.at(-1)!.width - (self.left + self.width)
  const startX = event.clientX
  const root = document.documentElement
  let started = false
  let to = from
  const place = (el: HTMLElement, x: number) => { el.style.transform = x ? `translateX(${x}px)` : '' }

  const move = (e: PointerEvent) => {
    const dx = e.clientX - startX
    if (!started) {
      if (Math.abs(dx) < DRAG_THRESHOLD) return
      started = true
      for (const el of tabs) el.removeAttribute('data-settling')
      strip.setAttribute('data-dragging', '')
      tab.setAttribute('data-dragged', '')
      root.classList.add('is-dragging-tab')
    }
    const x = Math.min(most, Math.max(least, dx))
    place(tab, x)
    to = dropIndex(slots, from, x)
    tabs.forEach((el, i) => { if (i !== from) place(el, slideOf(i, from, to, size)) })
  }
  const finish = (commit: boolean) => {
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', up)
    window.removeEventListener('pointercancel', cancel)
    window.removeEventListener('keydown', key, true)
    window.removeEventListener('blur', cancel)
    if (!started) return
    root.classList.remove('is-dragging-tab')
    // The click the release makes isn't one.
    const swallow = (e: MouseEvent) => { e.stopPropagation(); e.preventDefault() }
    window.addEventListener('click', swallow, { capture: true, once: true })
    setTimeout(() => window.removeEventListener('click', swallow, { capture: true }))
    const at = tab.getBoundingClientRect().left
    if (commit && to !== from) {
      // In their new places at once: the others where they'd slid to, and this one from where it was let go.
      strip.removeAttribute('data-dragging')
      for (const el of tabs) place(el, 0)
      drop(to, tabs.map((el) => el.dataset.pane!))
    } else {
      for (const el of tabs) if (el !== tab) place(el, 0)
    }
    tab.removeAttribute('data-dragged')
    place(tab, 0)
    // It settles into its place: from where it was let go, eased.
    place(tab, at - tab.getBoundingClientRect().left)
    void tab.offsetWidth
    tab.setAttribute('data-settling', '')
    place(tab, 0)
    const done = () => { tab.removeAttribute('data-settling'); if (!strip.querySelector('[data-dragged]')) strip.removeAttribute('data-dragging') }
    tab.addEventListener('transitionend', done, { once: true })
    setTimeout(done, 250)
  }
  const up = () => finish(true)
  const cancel = () => finish(false)
  const key = (e: KeyboardEvent) => {
    if (e.key !== 'Escape' || !started) return
    e.preventDefault()
    e.stopPropagation()
    cancel()
  }
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', up)
  window.addEventListener('pointercancel', cancel)
  window.addEventListener('keydown', key, true)
  window.addEventListener('blur', cancel)
}

/** What a pane shows on its tab in the strip: a note after its title (Changes: +3 −1), a glyph in place of its kind's (a spinner). */
type TabMarks = { note?: ReactNode; glyph?: ReactNode }
type SetTabMark = (mark: keyof TabMarks, value: ReactNode) => void
const TabMark = createContext<SetTabMark | null>(null)

/** Shown on the pane's tab in the strip, after its title, until `key` changes or the pane goes. */
export function useTabNote(note: ReactNode, key: string) {
  const set = useContext(TabMark)
  useEffect(() => { set?.('note', note); return () => set?.('note', undefined) }, [key])
}

/**
 * Shown on the pane's tab in the strip in place of its kind's glyph (14px: a `Glyph`, a spinner while it loads), until
 * `key` changes or the pane goes; none (null) for its kind's own.
 */
export function useTabGlyph(glyph: ReactNode, key: string) {
  const set = useContext(TabMark)
  useEffect(() => { set?.('glyph', glyph ?? undefined); return () => set?.('glyph', undefined) }, [key])
}

/** Where a pane's own header things go (a count, Refresh): beside its title, at the top of its column. */
const HeaderSlot = createContext<HTMLElement | null>(null)

/** Shown in the pane's header, beside its title, rather than in its body. */
export function PaneHeader({ children }: { children: ReactNode }) {
  const at = useContext(HeaderSlot)
  // Portalled out of the pane's tree: still marked as what drew it is (a profile's), so its styles reach.
  const marked = usePortalAttributes()
  return at ? createPortal(Object.keys(marked).length ? <span className="profile-scope" {...marked}>{children}</span> : children, at) : <div className="pane-bar">{children}</div>
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

function PaneColumn({ pane, title, focused, width, order, last, behind, maximized, onFocus, onClick, onClose, onMaximize, view, children }: {
  pane: Pane; title: string; focused: boolean; width: number; behind: boolean
  /** Its place in the row (CSS `order`), and whether it's the last one scrolled. */
  order: number; last: boolean
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
    <div ref={column} data-column={pane.id} tabIndex={-1} className={`panes__column ${behind ? 'is-behind' : ''} ${last ? 'is-last' : ''} ${maximized ? 'is-maximized' : covered ? 'is-covered' : ''}`}
      inert={behind || covered} style={maximized ? { order } : { width, order }} onPointerDownCapture={onFocus} onFocusCapture={onFocus} onClick={onClick}>
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
        <Contained name={whose(kind, pane.kind)} scope={kind.owner.profile}><Component machine={machine} thread={thread} pane={pane} /></Contained>
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

/** A file of the thread's, in its folder or anywhere on its machine, to read and edit (see FileEditor). */
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

/**
 * Another thread, beside this one: on this thread's machine, or on the one `machine` names. That's the machine's own
 * id (as its hello says it), not this window's name for it: the pane is kept with the thread, for every window to show.
 */
function ThreadPane({ machine: here, pane }: PaneProps) {
  const { thread: id, machine: named } = params<{ thread?: string; machine?: string }>(pane)
  const machines = useMachines()
  const threads = useAllThreads()
  const machine = named === undefined ? here : machines.find((m) => m.machine?.id === named)
  if (!machine) return <div className="pane-empty">Not connected to the machine thread {id ?? ''} is on.</div>
  const thread = threads[machine.id]?.find((s) => s.id === id)
  if (!thread) return <div className="pane-empty">No thread {id ?? ''} on {machine.label}.</div>
  return <div className="thread-pane"><ThreadBody machine={machine} thread={thread} /></div>
}

