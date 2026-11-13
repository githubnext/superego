// Panes: views beside a thread. A thread keeps which are open and which has focus (pane.open, pane.focus, pane.close),
// so they follow it to every client; the agent opens them too (open_pane). The thread and its panes are a row of
// columns with room between, scrolled as Dinky's (and niri's) scrolling layout is. Each column has its own width, a
// share of the row: the thread's half to start, a pane's its kind's; the room after a column (the last one's too, at
// the row's end) is its handle, and the last column takes what's left over until it's dragged. Past the edge the row
// scrolls, and the focused column scrolls just far enough to show whole. ⌃Tab moves the focus along. On a phone each
// column is the screen's width, and a swipe moves between them.
// Built in: editor and thread. Extensions and profiles add kinds with superego.pane(kind, …) (Changes is git's; a web
// page and an artifact, web-panes'). A pane of a kind only an extension the thread goes without draws isn't shown.
import { createContext, Fragment, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { Pane, ThreadInfo } from '@superego/protocol'
import { ArrowRightIcon, ChatTextIcon, FileTextIcon, XIcon } from '@superego/ui'
import { fileKind, paneKind, paneTitle, shownPanes, useRegistry, type PaneKind, type PaneProps, type UiApi } from './extension.tsx'
import { useLocalState } from './local-state.ts'
import { useAllThreads, useMachines } from './state.tsx'
import { PaneMenu, ThreadBody } from './ThreadView.tsx'
import { FileEditor } from './file-editor.tsx'
import { focusRegion } from './focus.ts'

const narrowQuery = '(max-width: 599px)'
/** A pane's width (a share of the row) until it's dragged, unless its kind says otherwise. */
const DEFAULT_SHARE = 0.5
/** Wide, the room after each column (the last too): its handle, to drag it wider or narrower. */
const GAP = 8
/** No column narrower than this, however many: the row scrolls instead. */
const MIN_COLUMN = 380

/** Where the strip goes, when the window has a place for it (the title bar); without one, it heads the columns. */
export const StripSlot = createContext<HTMLElement | null>(null)

export function ThreadPanes({ machine, thread, main }: { machine: PaneProps['machine']; thread: ThreadInfo; main: ReactNode }) {
  const registry = useRegistry()
  const dispatch = registry.router.dispatch
  const panes = shownPanes(registry, { machine: machine.id, thread })
  const [narrow, setNarrow] = useState(() => matchMedia(narrowQuery).matches)
  useEffect(() => {
    const list = matchMedia(narrowQuery)
    const change = () => setNarrow(list.matches)
    list.addEventListener('change', change)
    return () => list.removeEventListener('change', change)
  }, [])
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
    const at = document.activeElement
    if (!event.currentTarget.contains(at) || at?.matches('.panes__label')) focusRegion(event.currentTarget, { visible: event.detail === 0 })
  }
  const close = (pane: Pane) => void dispatch('pane.close', { id: thread.id, pane: pane.id }, { machine: machine.id, source: 'panes' })
  const where = { machine: machine.id, thread }
  const title = (pane: Pane) => paneTitle(registry, pane, where)

  // The room the columns share: the row less the gap after each.
  const room = narrow ? rowWidth : Math.max(0, rowWidth - GAP * (panes.length + 1))
  // The columns, left to right: the thread, then its panes, each by the key its width is kept under. The last one's
  // width is kept apart (`<key>:end`): dragged from its own handle at the end, it's its width while it is last.
  const keys = ['thread', ...panes.map((pane) => pane.id)]
  const last = keys.length - 1
  const shareOf = (key: string, index: number) => index === last
    ? shares[`${key}:end`]
    : shares[key] ?? (index === 0 ? DEFAULT_SHARE : paneKind(registry, panes[index - 1]!.kind, where)?.width ?? DEFAULT_SHARE)
  const widthFor = (share: number) => Math.min(room, Math.max(MIN_COLUMN, Math.round(share * room)))
  const widths = keys.map((key, i) => narrow ? rowWidth : widthFor(shareOf(key, i) ?? 0))
  // Unless dragged, the last column takes the room the others leave.
  const used = widths.slice(0, last).reduce((sum, w) => sum + w, 0)
  if (!narrow && shareOf(keys[last]!, last) === undefined) widths[last] = Math.max(MIN_COLUMN, room - used)
  const threadWidth = widths[0]!
  const widthOf = (pane: Pane) => widths[panes.indexOf(pane) + 1]!
  // How much of each column is in view, and on which side the rest are: for the strip.
  const starts = widths.map((_, i) => widths.slice(0, i).reduce((sum, w) => sum + w + GAP, 0))
  const shown = widths.map((w, i) => w ? Math.max(0, Math.min(starts[i]! + w, scrolled + rowWidth) - Math.max(starts[i]!, scrolled)) / w : 0)
  const side = (i: number) => shown[i]! >= 0.5 ? undefined : starts[i]! < scrolled ? 'left' : 'right'

  // The gap after a column resizes it (`index`): its share of the row, kept for next time. The last one's, dragged out
  // to the row's end, takes what's left again; a double click puts any back as it was.
  const keyOf = (index: number) => index === last ? `${keys[index]}:end` : keys[index]!
  const drag = (index: number) => (event: React.PointerEvent) => {
    if (event.button !== 0) return
    const startX = event.clientX
    const start = widths[index]!
    const key = keyOf(index)
    const move = (e: PointerEvent) => {
      const width = start + e.clientX - startX
      const fills = index === last && width >= room - used
      const next = Math.min(index === last ? 1 : 0.85, Math.max(0.15, width / Math.max(1, room)))
      setShares(({ [key]: _, ...rest }) => fills ? rest : { ...rest, [key]: next })
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
            <button key={tab.id ?? 'thread'} type="button" role="tab" aria-selected={tab.id === focused}
              className={`strip__tab ${tab.id === focused ? 'is-focused' : away ? 'is-away' : 'is-shown'}`}
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
          <span className="strip__map" aria-hidden>
            {widths.map((w, i) => <i key={i} className={shown[i]! >= 0.5 ? 'is-in' : ''} style={{ width: Math.max(4, Math.round((w / total) * 52)) }} />)}
          </span>
          <PaneMenu machine={machine} thread={thread} add />
        </>
      )}
    </div>
  )
  return (
    <div className={`sheet ${panes.length ? 'has-panes' : ''}`}>
      {stripSlot ? strip && createPortal(strip, stripSlot) : strip}
      <div className={`panes ${narrow ? 'panes--narrow' : ''}`} ref={row} onScroll={onScroll}>
        {/* Focus moving into a column (a click, a key) makes it the focused one: the app and the keyboard agree. */}
        <div data-column="thread" tabIndex={-1} className="panes__column panes__column--thread"
          style={{ width: threadWidth }} onPointerDownCapture={() => focus(undefined)} onFocusCapture={() => focus(undefined)}>{main}</div>
        {/* The gap after each column is its handle: drag it to make that one wider or narrower. */}
        {gap(0)}
        {panes.map((pane, index) => (
          <Fragment key={pane.id}>
          <PaneColumn pane={pane} title={title(pane)} focused={pane.id === focused} width={widthOf(pane)}
            onFocus={() => focus(pane.id)} onClick={takeFocus} onClose={() => close(pane)}>
            <TabNote.Provider value={setNoteFor(pane.id)}><PaneBody machine={machine} thread={thread} pane={pane} /></TabNote.Provider>
          </PaneColumn>
          {gap(index + 1)}
          </Fragment>
        ))}
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

function PaneColumn({ pane, title, focused, width, onFocus, onClick, onClose, children }: {
  pane: Pane; title: string; focused: boolean; width: number; onFocus(): void; onClick(event: React.MouseEvent<HTMLElement>): void; onClose(): void; children: ReactNode
}) {
  const [slot, setSlot] = useState<HTMLElement | null>(null)
  return (
    <div data-column={pane.id} tabIndex={-1} className="panes__column"
      style={{ width }} onPointerDownCapture={onFocus} onFocusCapture={onFocus} onClick={onClick}>
      <div className={`panes__tab ${focused ? 'is-active' : ''}`}>
        <button className="panes__label" title={title}>{title}</button>
        <span className="panes__tools" ref={setSlot} />
        <button className="panes__close" aria-label={`Close ${title}`} onClick={onClose}><XIcon size={12} aria-hidden /></button>
      </div>
      <div className="panes__body"><HeaderSlot.Provider value={slot}>{children}</HeaderSlot.Provider></div>
    </div>
  )
}

function PaneBody({ machine, thread, pane }: PaneProps) {
  const registry = useRegistry()
  const kind = paneKind(registry, pane.kind, { machine: machine.id, thread })
  if (!kind) return <div className="pane-empty">No pane of kind “{pane.kind}” here{thread.profile ? '' : ' (a profile may add it)'}.</div>
  const Component = kind.component
  return <Component machine={machine} thread={thread} pane={pane} />
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

