// Panes: views beside a thread. A thread keeps which are open and which has focus (pane.open, pane.focus, pane.close),
// so they follow it to every client; the agent opens them too (open_pane). The thread and its panes are a row of
// columns (cards, with room around and between), scrolled as Dinky's (and niri's) scrolling layout is. Each column has
// its own width, a share of the row: the thread's half to start, a pane's its kind's; the room between two columns
// resizes the one on its left, as macOS does, and the last column takes what's left over. Past the edge the row
// scrolls, and the focused column scrolls just far enough to show whole. ⌃Tab moves the focus along. On a phone each
// column is the screen's width, and a swipe moves between them.
// Built in: diff, editor, preview, artifact, thread. Extensions and profiles add kinds with superego.pane(kind, …).
import { Fragment, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import type { Pane, ThreadInfo } from '@superego/protocol'
import { Button } from '@superego/ui'
import { machine as client } from './client.ts'
import { paneKind, useRegistry, type PaneProps, type UiApi } from './extension.tsx'
import { useLocalState } from './local-state.ts'
import { useAllThreads, useMachines } from './state.tsx'
import { ThreadBody } from './ThreadView.tsx'
import { FileEditor } from './file-editor.tsx'
import { focusRegion } from './focus.ts'

const narrowQuery = '(max-width: 760px)'
/** A pane's width (a share of the row) until it's dragged, unless its kind says otherwise. */
const DEFAULT_SHARE = 0.5
/** Wide, the columns are cards: this much room around them and between them (the room between is a pane's handle). */
const GAP = 8
/** No column narrower than this, however many: the row scrolls instead. */
const MIN_COLUMN = 380

export function ThreadPanes({ machine, thread, main }: { machine: PaneProps['machine']; thread: ThreadInfo; main: ReactNode }) {
  const registry = useRegistry()
  const dispatch = registry.router.dispatch
  const panes = thread.panes ?? []
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
  const title = (pane: Pane) => {
    const named = paneKind(registry, pane.kind, thread)?.title
    return pane.title ?? (typeof named === 'function' ? named(pane) : named) ?? pane.kind
  }

  // The room the cards share: the row less the gaps around and between them.
  const room = narrow ? rowWidth : Math.max(0, rowWidth - GAP * (panes.length + 2))
  // The columns, left to right: the thread, then its panes, each by the key its width is kept under.
  const columns = [{ key: 'thread', share: shares.thread ?? DEFAULT_SHARE },
    ...panes.map((pane) => ({ key: pane.id, share: shares[pane.id] ?? paneKind(registry, pane.kind, thread)?.width ?? DEFAULT_SHARE }))]
  const widths = columns.map((c) => narrow ? rowWidth : Math.min(room, Math.max(MIN_COLUMN, Math.round(c.share * room))))
  // The last column takes the room the others leave.
  const used = widths.reduce((sum, w) => sum + w, 0)
  if (!narrow && used < room) widths[widths.length - 1]! += room - used
  const threadWidth = widths[0]!
  const widthOf = (pane: Pane) => widths[panes.indexOf(pane) + 1]!

  // The room between two columns resizes the one on its left (`index`): its share of the row, kept for next time.
  const drag = (index: number) => (event: React.PointerEvent) => {
    const startX = event.clientX
    const start = widths[index]!
    const key = columns[index]!.key
    const move = (e: PointerEvent) => {
      const next = Math.min(0.85, Math.max(0.15, (start + e.clientX - startX) / Math.max(1, room)))
      setShares((all) => ({ ...all, [key]: next }))
    }
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up) }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    event.preventDefault()
    event.stopPropagation()
  }
  // On a phone, a swipe that settles on a column gives it the focus.
  const onScroll = () => {
    if (!narrow) return
    clearTimeout(settled.current)
    settled.current = setTimeout(() => {
      const el = row.current
      if (!el || !rowWidth) return
      const index = Math.round(el.scrollLeft / rowWidth)
      focus(index === 0 ? undefined : panes[index - 1]?.id)
    }, 120)
  }

  return (
    <div className={`panes ${narrow ? 'panes--narrow' : ''}`} ref={row} onScroll={onScroll}>
      {/* Focus moving into a column (a click, a key) makes it the focused one: the app and the keyboard agree. */}
      <div data-column="thread" tabIndex={-1} className={`panes__column panes__column--thread ${focused === undefined ? 'is-focused' : ''}`}
        style={{ width: threadWidth }} onPointerDownCapture={() => focus(undefined)} onFocusCapture={() => focus(undefined)}>{main}</div>
      {panes.map((pane, index) => (
        <Fragment key={pane.id}>
        {/* The room between two columns is the left one's handle: drag it to make that one wider or narrower. */}
        {!narrow && <div className="panes__gap" onPointerDown={drag(index)} role="separator" aria-orientation="vertical" aria-label={index === 0 ? 'Thread width' : `${title(panes[index - 1]!)} width`} />}
        <div data-column={pane.id} tabIndex={-1} className={`panes__column ${pane.id === focused ? 'is-focused' : ''}`}
          style={{ width: widthOf(pane) }} onPointerDownCapture={() => focus(pane.id)} onFocusCapture={() => focus(pane.id)} onClick={takeFocus}>
          <div className={`panes__tab ${pane.id === focused ? 'is-active' : ''}`}>
            <button className="panes__label">{title(pane)}</button>
            <button className="panes__close" aria-label={`Close ${title(pane)}`} onClick={() => close(pane)}>×</button>
          </div>
          <div className="panes__body"><PaneBody machine={machine} thread={thread} pane={pane} /></div>
        </div>
        </Fragment>
      ))}
    </div>
  )
}

function PaneBody({ machine, thread, pane }: PaneProps) {
  const registry = useRegistry()
  const kind = paneKind(registry, pane.kind, thread)
  if (!kind) return <div className="pane-empty">No pane of kind “{pane.kind}” here{thread.profile ? '' : ' (a profile may add it)'}.</div>
  const Component = kind.component
  return <Component machine={machine} thread={thread} pane={pane} />
}

// ── Built-in panes ──────────────────────────────────────────────────────────────────────────────────────────────

/** The file a pane shows, by name: its tab's title. */
const fileName = (pane: Pane) => (pane.params as { path?: string } | undefined)?.path?.split('/').at(-1)

export function registerBuiltInPanes(superego: UiApi) {
  superego.pane('diff', { title: 'Changes', component: DiffPane, menu: true, width: 0.6 })
  superego.pane('editor', { title: (pane) => fileName(pane) ?? 'Editor', component: EditorPane, opens: () => true })
  superego.pane('preview', { title: 'Preview', component: PreviewPane, width: 0.6 })
  superego.pane('artifact', { title: (pane) => fileName(pane) ?? 'Artifact', component: ArtifactPane })
  superego.pane('thread', { title: 'Thread', component: ThreadPane })
}

const params = <T,>(pane: Pane) => (pane.params ?? {}) as T

/** The folder's changes by git, refreshed as the thread moves on. */
function DiffPane({ machine, thread }: PaneProps) {
  const [changes, setChanges] = useState<{ diff: string; untracked: string[]; repo: boolean }>()
  const [error, setError] = useState<string>()
  const load = () => client(machine.id).call('thread.diff', { id: thread.id }).then((c) => { setChanges(c); setError(undefined) }, (e: Error) => setError(e.message))
  useEffect(() => { void load() }, [thread.id, thread.activeAt, thread.status.state])
  if (error) return <div className="pane-empty">{error}</div>
  if (!changes) return <div className="pane-empty">Loading…</div>
  if (!changes.repo) return <div className="pane-empty">{thread.cwd} isn't a git repository.</div>
  const files = parseDiff(changes.diff)
  return (
    <div className="pane-scroll diff-pane">
      <div className="pane-bar"><span>{files.length} changed{changes.untracked.length ? `, ${changes.untracked.length} new` : ''}</span><Button onClick={() => void load()}>Refresh</Button></div>
      {!files.length && !changes.untracked.length && <div className="pane-empty">No changes.</div>}
      {files.map((file) => (
        <details key={file.path} className="diff-file" open>
          <summary><span className="diff-file__path">{file.path}</span><span className="stat--add">+{file.added}</span> <span className="stat--del">−{file.removed}</span></summary>
          <pre className="diff-file__body">{file.lines.map((line, i) => (
            <span key={i} className={`diff-row diff-row--${line[0] === '+' ? 'add' : line[0] === '-' ? 'del' : line.startsWith('@@') ? 'hunk' : 'ctx'}`}>{line || ' '}</span>
          ))}</pre>
        </details>
      ))}
      {changes.untracked.length > 0 && (
        <div className="diff-file"><div className="diff-untracked">New, not tracked yet: {changes.untracked.map((path) => (
          <button key={path} className="diff-untracked__file" onClick={() => void openPane(machine.id, thread.id, 'editor', { path })}>{path}</button>
        ))}</div></div>
      )}
    </div>
  )
}

type DiffFile = { path: string; added: number; removed: number; lines: string[] }
export function parseDiff(diff: string): DiffFile[] {
  const files: DiffFile[] = []
  let file: DiffFile | undefined
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      file = { path: line.replace(/^diff --git a\/(.*) b\/.*$/, '$1'), added: 0, removed: 0, lines: [] }
      files.push(file)
    } else if (!file || /^(index |--- |\+\+\+ |new file|deleted file|similarity|rename |old mode|new mode)/.test(line)) continue
    else {
      file.lines.push(line)
      if (line.startsWith('+')) file.added++
      else if (line.startsWith('-')) file.removed++
    }
  }
  return files
}

const openPane = (machine: string, id: string, kind: string, params: Record<string, unknown>) =>
  window.superego.call(machine, 'pane.open', { id, kind, params })

/** A file in the thread's folder, to read and edit (see FileEditor). */
function EditorPane({ machine, thread, pane }: PaneProps) {
  const { path, line } = params<{ path?: string; line?: number }>(pane)
  const dispatch = useRegistry().router.dispatch
  if (!path) return <div className="pane-empty">No file given.</div>
  // Another file from beside it (the file tree): shown here instead, or in a pane of its own beside.
  const open = (file: string, { beside }: { beside: boolean }) => beside
    ? void dispatch('pane.open', { id: thread.id, kind: 'editor', params: { path: file } }, { machine: machine.id, source: 'editor' })
    : void dispatch('pane.update', { id: thread.id, pane: pane.id, params: { path: file } }, { machine: machine.id, source: 'editor' })
  return <FileEditor key={path} machine={machine} thread={thread} path={path} {...(line ? { line } : {})} onOpenFile={open} />
}

/** A web page: a local dev server, docs. */
function PreviewPane({ pane }: PaneProps) {
  const { url } = params<{ url?: string }>(pane)
  const [key, setKey] = useState(0)
  if (!url || !/^https?:\/\//.test(url)) return <div className="pane-empty">No address (an http or https URL) given.</div>
  return (
    <div className="frame-pane">
      <div className="pane-bar"><a href={url} target="_blank" rel="noreferrer">{url}</a><Button onClick={() => setKey((k) => k + 1)}>Reload</Button></div>
      <iframe key={key} src={url} title={url} sandbox="allow-scripts allow-same-origin allow-forms allow-popups" />
    </div>
  )
}

/** An HTML file the agent wrote, shown as a page: sandboxed, from its own origin, with its relative files beside it. */
function ArtifactPane({ machine, thread, pane }: PaneProps) {
  const { path } = params<{ path?: string }>(pane)
  const [key, setKey] = useState(0)
  useEffect(() => { setKey((k) => k + 1) }, [thread.activeAt])
  if (!path) return <div className="pane-empty">No file given.</div>
  const url = window.superego.artifactUrl?.(machine.id, thread.id, path)
  if (!url) return <div className="pane-empty">Artifacts aren't shown here.</div>
  return (
    <div className="frame-pane">
      <div className="pane-bar"><code>{path}</code><Button onClick={() => setKey((k) => k + 1)}>Reload</Button></div>
      <iframe key={key} src={url} title={path} sandbox="allow-scripts allow-forms allow-popups" />
    </div>
  )
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

