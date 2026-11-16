// Panes: views beside a thread. A thread keeps which are open and which has focus (pane.open, pane.focus, pane.close),
// so they follow it to every client; the agent opens them too (open_pane). Wide, they're laid out one of two ways (the
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
// page and an artifact, web-panes'). A pane of a kind only an extension the thread goes without draws isn't shown.
import { createContext, Fragment, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal, flushSync } from 'react-dom'
import type { Pane, ThreadInfo } from '@superego/protocol'
import { ArrowRightIcon, CardsIcon, ChatTextIcon, ColumnsPlusRightIcon, CornersInIcon, CornersOutIcon, DotsThreeIcon, FileTextIcon, IconButton, Menu, SegmentedControl, XIcon, type SegmentedOption } from '@superego/ui'
import { PANE_LAYOUT, type PaneLayout } from '../shared.ts'
import { useAppSetting } from './client.ts'
import { fileKind, paneKind, paneTitle, shownPanes, useNarrow, useRegistry, ViewScopeProvider, whose, type PaneKind, type PaneProps, type UiApi } from './extension.tsx'
import { Contained } from './contained.tsx'
import { useLocalState } from './local-state.ts'
import { useAllThreads, useMachines } from './state.tsx'
import { PaneMenu, ThreadBody } from './ThreadView.tsx'
import { PaneMoveTo } from './view-menu.tsx'
import { FileEditor } from './file-editor.tsx'
import { BRING_FORWARD, focusRegion } from './focus.ts'
import { DEFAULT_SHARE, END, endShare, frontOf, GAP, roomFor, scrollWidths, stackWidths } from './pane-layout.ts'
import { maximizedPane, maximizedStore, restoresOn } from './maximized.ts'
import { useShortcut } from './keys.ts'

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
  // A pane of a view's kind can move to the other places the view fits, from its tab's ···.
  const isView = (pane: Pane) => registry.views.some((v) => v.id === pane.kind && v.fits.includes('pane'))
  const narrow = useNarrow()
  const [layout] = useAppSetting<PaneLayout>(PANE_LAYOUT)
  // On a phone each column is the screen's width either way.
  const stacked = layout === 'stack' && !narrow && panes.length > 0
  // Each pane's width, as a share of the row, by pane; kept in this window.
  const [shares, setShares] = useLocalState<Record<string, number>>('pane.widths', {})
  const row = useRef<HTMLDivElement>(null)
  const [rowWidth, setRowWidth] = useState(0)
  const [scrolled, setScrolled] = useState(0)
  useLayoutEffect(() => {
    const el = row.current
    if (!el) return
    const observer = new ResizeObserver(() => setRowWidth(el.clientWidth))
    observer.observe(el)
    setRowWidth(el.clientWidth)
    return () => observer.disconnect()
  }, [panes.length > 0])

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
  const maximize = (pane: Pane) => void dispatch('panes.maximize', { pane: pane.id }, { source: 'panes' })
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

  const focus = (pane?: string) => { if (pane !== focused) void dispatch('pane.focus', { id: thread.id, ...(pane ? { pane } : {}) }, { machine: machine.id, source: 'panes' }) }
  // A click on a column's own parts that leaves the focus outside it, or on its title (which a click focuses): the
  // focus goes to what's used there, the editor's text or the page, as the keyboard takes it there. Shown as a click's
  // would be, unless the click came from the keyboard (⏎ on the title).
  const takeFocus = (event: React.MouseEvent<HTMLElement>) => {
    // A click in what the column portals out (its menu) isn't on the column: the menu keeps the focus.
    if (!event.currentTarget.contains(event.target as Node)) return
    const at = document.activeElement
    if (!event.currentTarget.contains(at) || at?.matches('.panes__label')) focusRegion(event.currentTarget, { visible: event.detail === 0 })
  }
  const close = (pane: Pane) => void dispatch('pane.close', { id: thread.id, pane: pane.id }, { machine: machine.id, source: 'panes' })
  const where = { machine: machine.id, thread }
  const title = (pane: Pane) => paneTitle(registry, pane, where)

  // The columns, left to right: the thread, then its panes, each by the key its width is kept under. The last one's
  // width is kept apart (`<key>:end`): dragged from its own handle at the end, it's its width while it is last.
  // Stacked, the thread's is the only one: its panes' column takes the rest.
  const keys = ['thread', ...panes.map((pane) => pane.id)]
  const last = stacked ? 1 : keys.length - 1
  const shareOf = (key: string, index: number) => index === last
    ? shares[`${key}:end`]
    : shares[key] ?? (index === 0 ? DEFAULT_SHARE : paneKind(registry, panes[index - 1]!.kind, where)?.width ?? DEFAULT_SHARE)
  // The room the columns share: the row less the gap after each (stacked, the thread's and the stack's).
  const room = narrow ? rowWidth : roomFor(rowWidth, stacked ? 2 : keys.length)
  const [threadWidth, stackWidth] = stackWidths(room, shares.thread)
  const widths = narrow ? keys.map(() => rowWidth)
    : stacked ? [threadWidth, ...panes.map(() => stackWidth)]
    : scrollWidths(room, keys.map((key, i) => shareOf(key, i)))
  const widthOf = (pane: Pane) => widths[panes.indexOf(pane) + 1]!
  // How much of each column is in view, and on which side the rest are: for the strip. Stacked, the thread and the
  // pane in front are; the rest are behind. Maximized, only that pane is: the rest are under it.
  const starts = widths.map((_, i) => widths.slice(0, i).reduce((sum, w) => sum + w + GAP, 0))
  const shown = widths.map((w, i) => maximized ? Number(keys[i] === maximized) : stacked ? Number(i === 0 || keys[i] === front)
    : w ? Math.max(0, Math.min(starts[i]! + w, scrolled + rowWidth) - Math.max(starts[i]!, scrolled)) / w : 0)
  const side = (i: number) => shown[i]! >= 0.5 ? undefined : stacked || maximized ? 'behind' : starts[i]! < scrolled ? 'left' : 'right'

  // The gap after a column resizes it (`index`): its share of the row, kept for next time. The last one's, dragged to
  // about what the others leave, takes that again; past it, it's wider and the row scrolls. A double click puts any
  // back as it was.
  const keyOf = (index: number) => index === last ? `${keys[index]}:end` : keys[index]!
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
  const tabs: { id: string | undefined; label: string; kind: Pick<PaneKind, 'icon' | 'file'> | undefined; pane: Pane | undefined }[] = [
    { id: undefined, label: 'Thread', kind: { icon: ChatTextIcon }, pane: undefined },
    ...panes.map((pane) => ({ id: pane.id, label: title(pane), kind: paneKind(registry, pane.kind, where), pane })),
  ]
  const total = widths.reduce((sum, w) => sum + w, 0) || 1
  const stripSlot = useContext(StripSlot)
  // The tab raised: the focused column's; stacked, the one in front once a pane opening covers the focused one.
  const current = stacked && focused && focused !== front ? front : focused

  const strip = panes.length > 0 && (
    <div className={`strip ${narrow ? 'strip--narrow' : ''}`} role="tablist" aria-label="The thread and its panes">
      <div className="strip__tabs">
        {tabs.map((tab, i) => {
          const Icon = tab.kind?.icon
          const away = side(i)
          // The whole of what the tab may cut short: a file's path, a page's address, or its title.
          const { path, url } = (tab.pane?.params ?? {}) as { path?: string; url?: string }
          const full = path ?? url ?? tab.label
          return (
            <button key={tab.id ?? 'thread'} type="button" role="tab" aria-selected={tab.id === current}
              className={`strip__tab ${tab.id === current ? 'is-focused' : away ? 'is-away' : 'is-shown'}`}
              title={full}
              onClick={() => show(tab.pane)}>
              {Icon && <Icon size={14} aria-hidden />}
              <span className={`strip__label ${tab.kind?.file ? 'strip__label--file' : ''}`}>{tab.label}</span>
              {tab.id && notes[tab.id]}
              {away === 'right' && <ArrowRightIcon className="strip__away" size={11} aria-hidden />}
            </button>
          )
        })}
      </div>
      {!narrow && (
        <>
          {/* The row in small: each column a bar as wide as it is, the ones in view darker. */}
          {!stacked && (
            <span className="strip__map" aria-hidden>
              {widths.map((w, i) => <i key={i} className={shown[i]! >= 0.5 ? 'is-in' : ''} style={{ width: Math.max(4, Math.round((w / total) * 52)) }} />)}
            </span>
          )}
          <PaneMenu machine={machine} thread={thread} add />
          <SegmentedControl label="Pane layout" className="strip__layout" options={LAYOUTS} value={stacked ? 'stack' : 'scroll'}
            onChange={(next) => void dispatch('panes.layout', { layout: next }, { source: 'strip' })} />
        </>
      )}
    </div>
  )
  return (
    <div className={`sheet ${panes.length ? 'has-panes' : ''}`}>
      {stripSlot ? strip && createPortal(strip, stripSlot) : strip}
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
  const keys = useShortcut('panes.maximize')
  const closeKeys = useShortcut('panes.close')
  const label = maximized ? 'Restore' : 'Maximize'
  // At the back of a stack, or under a maximized pane, it's kept (its page, its place in a file), out of sight and out
  // of reach.
  const covered = maximized === false
  return (
    <div data-column={pane.id} tabIndex={-1} className={`panes__column ${behind ? 'is-behind' : ''} ${maximized ? 'is-maximized' : covered ? 'is-covered' : ''}`}
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
  // A view open as a pane is drawn for its thread: its placement hooks read and change that thread's places.
  return <ViewScopeProvider value={{ machine: machine.id, thread }}><Contained name={whose(kind, pane.kind)}><Component machine={machine} thread={thread} pane={pane} /></Contained></ViewScopeProvider>
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
    if (beside || kind !== pane.kind) void dispatch('pane.open', { id: thread.id, kind, params: { path: file } }, { machine: machine.id, source: 'editor' })
    else void dispatch('pane.update', { id: thread.id, pane: pane.id, params: { path: file } }, { machine: machine.id, source: 'editor' })
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

