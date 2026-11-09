// Panes: views beside a thread. A thread keeps which are open and which has focus (pane.open, pane.focus, pane.close),
// so they follow it to every client; the agent opens them too (open_pane). The thread and its panes are a row of
// columns, scrolled as Dinky's (and niri's) scrolling layout is: a lone thread fills the width; with panes, each pane
// is a column of one width (a share of the row, dragged at its edge and kept) and the thread takes what's left, never
// less; past the edge the row scrolls, and the focused column scrolls just far enough to show whole. ⌃Tab moves the
// focus along. On a phone each column is the screen's width, and a swipe moves between them.
// Built in: diff, editor, preview, artifact, thread. Extensions and profiles add kinds with mu.pane(kind, …).
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import type { Pane, ThreadInfo } from '@mu/protocol'
import { Button } from '@mu/ui'
import { machine as client } from './client.ts'
import { paneKind, useRegistry, type PaneProps, type UiApi } from './extension.tsx'
import { useLocalState } from './local-state.ts'
import { useAllThreads, useMachines } from './state.tsx'
import { ThreadBody } from './ThreadView.tsx'
import { FileEditor } from './file-editor.tsx'

const narrowQuery = '(max-width: 760px)'
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
  // A pane column's width, as a share of the row.
  const [share, setShare] = useLocalState('pane.width', 0.5)
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
  if (!panes.length) return <>{main}</>

  const focus = (pane?: string) => { if (pane !== focused) void dispatch('pane.focus', { id: thread.id, ...(pane ? { pane } : {}) }, { machine: machine.id, source: 'panes' }) }
  const close = (pane: Pane) => void dispatch('pane.close', { id: thread.id, pane: pane.id }, { machine: machine.id, source: 'panes' })
  const title = (pane: Pane) => {
    const named = paneKind(registry, pane.kind, thread)?.title
    return pane.title ?? (typeof named === 'function' ? named(pane) : named) ?? pane.kind
  }

  const width = narrow ? rowWidth : Math.min(rowWidth, Math.max(MIN_COLUMN, Math.round(share * rowWidth)))
  const threadWidth = narrow ? rowWidth : Math.max(width, rowWidth - panes.length * width)

  // A pane's left edge resizes every pane column: their share of the row, kept for next time.
  const drag = (event: React.PointerEvent) => {
    const startX = event.clientX
    const startShare = share
    const move = (e: PointerEvent) => setShare(Math.min(0.8, Math.max(0.2, startShare + (startX - e.clientX) / Math.max(1, rowWidth))))
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
      <div data-column="thread" className={`panes__column panes__column--thread ${focused === undefined ? 'is-focused' : ''}`}
        style={{ width: threadWidth }} onPointerDownCapture={() => focus(undefined)}>{main}</div>
      {panes.map((pane) => (
        <div key={pane.id} data-column={pane.id} className={`panes__column ${pane.id === focused ? 'is-focused' : ''}`}
          style={{ width }} onPointerDownCapture={() => focus(pane.id)}>
          {!narrow && <div className="panes__edge" onPointerDown={drag} role="separator" aria-orientation="vertical" aria-label="Pane width" />}
          <div className={`panes__tab ${pane.id === focused ? 'is-active' : ''}`}>
            <button className="panes__label" onClick={() => focus(pane.id)}>{title(pane)}</button>
            <button className="panes__close" aria-label={`Close ${title(pane)}`} onClick={() => close(pane)}>×</button>
          </div>
          <div className="panes__body"><PaneBody machine={machine} thread={thread} pane={pane} /></div>
        </div>
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

export function registerBuiltInPanes(mu: UiApi) {
  mu.pane('diff', { title: 'Changes', component: DiffPane, menu: true })
  mu.pane('editor', { title: (pane) => fileName(pane) ?? 'Editor', component: EditorPane, opens: () => true })
  mu.pane('preview', { title: 'Preview', component: PreviewPane })
  mu.pane('artifact', { title: (pane) => fileName(pane) ?? 'Artifact', component: ArtifactPane })
  mu.pane('thread', { title: 'Thread', component: ThreadPane })
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
  window.mu.call(machine, 'pane.open', { id, kind, params })

/** A file in the thread's folder, to read and edit (see FileEditor). */
function EditorPane({ machine, thread, pane }: PaneProps) {
  const { path } = params<{ path?: string }>(pane)
  if (!path) return <div className="pane-empty">No file given.</div>
  return <FileEditor key={path} machine={machine} thread={thread} path={path} />
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
  const url = window.mu.artifactUrl?.(machine.id, thread.id, path)
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

