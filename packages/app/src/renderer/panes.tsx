// Panes: views beside a thread. A session keeps which are open and which is in front (pane.open, pane.focus,
// pane.close), so they follow it to every client; the agent opens them too (open_pane). Wide, the thread sits left and
// the panes right, as tabs, with a divider to drag; narrow (a phone), tabs switch between the thread and each pane.
// Built in: diff, editor, preview, artifact, thread. Extensions and profiles add kinds with mu.pane(kind, …).
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { EditorView, basicSetup } from 'codemirror'
import { markdown } from '@codemirror/lang-markdown'
import { keymap } from '@codemirror/view'
import type { Pane, SessionInfo } from '@mu/protocol'
import { Button } from '@mu/ui'
import { machine as client } from './client.ts'
import { paneKind, useRegistry, type PaneProps, type UiApi } from './extension.tsx'
import { useAllSessions, useMachines } from './state.tsx'
import { ThreadView } from './SessionView.tsx'

const WIDTH = 'mu.paneWidth'
const narrowQuery = '(max-width: 760px)'

export function SessionPanes({ machine, session, thread }: { machine: PaneProps['machine']; session: SessionInfo; thread: ReactNode }) {
  const registry = useRegistry()
  const dispatch = registry.router.dispatch
  const panes = session.panes ?? []
  const [narrow, setNarrow] = useState(() => matchMedia(narrowQuery).matches)
  useEffect(() => {
    const list = matchMedia(narrowQuery)
    const change = () => setNarrow(list.matches)
    list.addEventListener('change', change)
    return () => list.removeEventListener('change', change)
  }, [])
  const [width, setWidth] = useState(() => Number(localStorage.getItem(WIDTH)) || 0.5)
  const area = useRef<HTMLDivElement>(null)
  const widthRef = useRef(width)
  widthRef.current = width
  if (!panes.length) return <>{thread}</>

  // In front: the session's choice; wide, with none chosen, the newest pane still shows beside the thread.
  const front = panes.find((p) => p.id === session.pane) ?? (narrow ? undefined : panes.at(-1))
  const focus = (pane?: Pane) => void dispatch('pane.focus', { id: session.id, ...(pane ? { pane: pane.id } : {}) }, { machine: machine.id, source: 'panes' })
  const close = (pane: Pane) => void dispatch('pane.close', { id: session.id, pane: pane.id }, { machine: machine.id, source: 'panes' })
  const title = (pane: Pane) => {
    const named = paneKind(registry, pane.kind, session)?.title
    return pane.title ?? (typeof named === 'function' ? named(pane) : named) ?? pane.kind
  }

  const tabs = (
    <div className="panes__tabs" role="tablist">
      {narrow && <button role="tab" aria-selected={!front} className={`panes__tab ${!front ? 'is-active' : ''}`} onClick={() => focus()}>Thread</button>}
      {panes.map((pane) => (
        <span key={pane.id} role="tab" aria-selected={pane === front} className={`panes__tab ${pane === front ? 'is-active' : ''}`}>
          <button className="panes__label" onClick={() => focus(pane)}>{title(pane)}</button>
          <button className="panes__close" aria-label={`Close ${title(pane)}`} onClick={() => close(pane)}>×</button>
        </span>
      ))}
    </div>
  )
  const body = front && <PaneBody key={front.id} machine={machine} session={session} pane={front} />

  if (narrow) return <div className="panes panes--narrow">{tabs}<div className="panes__body">{front ? body : thread}</div></div>

  // Drag the divider: the pane area's share of the width, kept for next time.
  const drag = (event: React.PointerEvent) => {
    const box = area.current?.getBoundingClientRect()
    if (!box) return
    const move = (e: PointerEvent) => setWidth(Math.min(0.8, Math.max(0.2, (box.right - e.clientX) / box.width)))
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); localStorage.setItem(WIDTH, String(widthRef.current)) }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    event.preventDefault()
  }
  return (
    <div className="panes" ref={area}>
      <div className="panes__thread" style={{ flexBasis: `${(1 - width) * 100}%` }}>{thread}</div>
      <div className="panes__divider" onPointerDown={drag} role="separator" aria-orientation="vertical" />
      <div className="panes__side" style={{ flexBasis: `${width * 100}%` }}>
        {tabs}
        <div className="panes__body">{body}</div>
      </div>
    </div>
  )
}

function PaneBody({ machine, session, pane }: PaneProps) {
  const registry = useRegistry()
  const kind = paneKind(registry, pane.kind, session)
  if (!kind) return <div className="pane-empty">No pane of kind “{pane.kind}” here{session.profile ? '' : ' (a profile may add it)'}.</div>
  const Component = kind.component
  return <Component machine={machine} session={session} pane={pane} />
}

// ── Built-in panes ──────────────────────────────────────────────────────────────────────────────────────────────

/** The file a pane shows, by name: its tab's title. */
const fileName = (pane: Pane) => (pane.params as { path?: string } | undefined)?.path?.split('/').at(-1)

export function registerBuiltInPanes(mu: UiApi) {
  mu.pane('diff', { title: 'Changes', component: DiffPane })
  mu.pane('editor', { title: (pane) => fileName(pane) ?? 'Editor', component: EditorPane })
  mu.pane('preview', { title: 'Preview', component: PreviewPane })
  mu.pane('artifact', { title: (pane) => fileName(pane) ?? 'Artifact', component: ArtifactPane })
  mu.pane('thread', { title: 'Thread', component: ThreadPane })
}

const params = <T,>(pane: Pane) => (pane.params ?? {}) as T

/** The folder's changes by git, refreshed as the session moves on. */
function DiffPane({ machine, session }: PaneProps) {
  const [changes, setChanges] = useState<{ diff: string; untracked: string[]; repo: boolean }>()
  const [error, setError] = useState<string>()
  const load = () => client(machine.id).call('session.diff', { id: session.id }).then((c) => { setChanges(c); setError(undefined) }, (e: Error) => setError(e.message))
  useEffect(() => { void load() }, [session.id, session.activeAt, session.status.state])
  if (error) return <div className="pane-empty">{error}</div>
  if (!changes) return <div className="pane-empty">Loading…</div>
  if (!changes.repo) return <div className="pane-empty">{session.cwd} isn't a git repository.</div>
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
          <button key={path} className="diff-untracked__file" onClick={() => void openPane(machine.id, session.id, 'editor', { path })}>{path}</button>
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

/** A file in the session's folder, to read and edit; ⌘S saves it. */
function EditorPane({ machine, session, pane }: PaneProps) {
  const { path } = params<{ path?: string }>(pane)
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView>(undefined)
  const [state, setState] = useState<{ dirty: boolean; error?: string; saved?: number }>({ dirty: false })
  const dispatch = useRegistry().router.dispatch
  useEffect(() => {
    if (!path || !host.current) return
    let live = true
    const save = () => {
      const content = view.current?.state.doc.toString() ?? ''
      void dispatch('file.write', { id: session.id, path, content }, { machine: machine.id, source: 'editor' })
        .then(() => setState({ dirty: false, saved: Date.now() }), (e: Error) => setState((s) => ({ ...s, error: e.message })))
      return true
    }
    client(machine.id).call('file.read', { id: session.id, path }).then(({ content }) => {
      if (!live || !host.current) return
      view.current = new EditorView({
        parent: host.current,
        doc: content,
        extensions: [
          keymap.of([{ key: 'Mod-s', run: save, preventDefault: true }]),
          basicSetup, EditorView.lineWrapping, ...(/\.(md|markdown)$/i.test(path) ? [markdown()] : []),
          EditorView.updateListener.of((update) => { if (update.docChanged) setState((s) => s.dirty ? s : { dirty: true }) }),
        ],
      })
    }, (e: Error) => setState({ dirty: false, error: e.message }))
    return () => { live = false; view.current?.destroy(); view.current = undefined }
  }, [machine.id, session.id, path])
  if (!path) return <div className="pane-empty">No file given.</div>
  return (
    <div className="editor-pane">
      <div className="pane-bar"><code>{path}</code><span className="pane-bar__note">{state.error ?? (state.dirty ? 'Edited · ⌘S saves' : state.saved ? 'Saved' : '')}</span></div>
      <div className="editor-pane__host" ref={host} />
    </div>
  )
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
function ArtifactPane({ machine, session, pane }: PaneProps) {
  const { path } = params<{ path?: string }>(pane)
  const [key, setKey] = useState(0)
  useEffect(() => { setKey((k) => k + 1) }, [session.activeAt])
  if (!path) return <div className="pane-empty">No file given.</div>
  const url = window.mu.artifactUrl?.(machine.id, session.id, path)
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
  const { session: id, machine: machineId } = params<{ session?: string; machine?: string }>(pane)
  const machines = useMachines()
  const sessions = useAllSessions()
  const machine = machines.find((m) => m.id === (machineId ?? 'local'))
  const session = machine && sessions[machine.id]?.find((s) => s.id === id)
  if (!machine || !session) return <div className="pane-empty">No thread {id ?? ''} here.</div>
  return <div className="thread-pane"><ThreadView machine={machine} session={session} /></div>
}

