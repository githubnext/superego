// A file in a thread's folder, open to edit. Markdown opens in live preview (as Obsidian does: rendered, its syntax
// back where the cursor is), or as source; anything else as source. It saves as you type, and follows the file when
// the agent changes it: your view updates, or, with edits of yours not yet saved, it asks which to keep.
// The editor pane is this; a profile's own panes use it too (the obsidian profile's notes), with their own links.
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { minimalSetup } from 'codemirror'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { defaultHighlightStyle, foldGutter, HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { Annotation, Compartment, type Extension } from '@codemirror/state'
import { EditorView, highlightActiveLine, highlightActiveLineGutter, keymap, lineNumbers } from '@codemirror/view'
import { searchKeymap } from '@codemirror/search'
import { tags } from '@lezer/highlight'
import type { ThreadInfo } from '@mu/protocol'
import { Button } from '@mu/ui'
import type { MachineEntry } from '../shared.ts'
import { machine as client } from './client.ts'
import { fileKind, Slot, useRegistry, type EditorSlotProps } from './extension.tsx'
import { linkAt, livePreview, type MarkdownLink } from './live-markdown.ts'

export type { MarkdownLink }
export type FileEditorProps = {
  machine: MachineEntry
  thread: ThreadInfo
  /** In the thread's folder. */
  path: string
  /** Opening a link (a click on it, or ⌘-click while it's being edited). Without one, links open beside the thread. */
  onLink?: (link: MarkdownLink) => void
  /** In the bar, after the file's name. */
  actions?: ReactNode
  /** Below the text, scrolling with it: a note's backlinks, say. */
  children?: ReactNode
  /**
   * Showing another file (from the file tree, say): here, or `beside` in a pane of its own. Without one, both open a
   * pane of their own (the pane kind that takes the file).
   */
  onOpenFile?: (path: string, options: { beside: boolean }) => void
}

const MODE = 'mu.editor.mode'
/** A change read from disk, not typed: it doesn't need saving. */
const fromDisk = Annotation.define<boolean>()

/** In live preview the syntax is quiet when shown, and code is monospace; the rest is the preview's own styling. */
const liveHighlight = HighlightStyle.define([
  { tag: tags.processingInstruction, color: 'var(--mu-faint)' },
  { tag: [tags.url, tags.labelName], color: 'var(--mu-muted)' },
  { tag: tags.monospace, fontFamily: 'var(--mu-mono)', fontSize: '0.92em' },
  { tag: tags.meta, color: 'var(--mu-muted)' },
])

/** The text as it is on disk, after `next` changed it there: only the part that differs, so the cursor stays put. */
function minimalChange(current: string, next: string) {
  let start = 0
  while (start < current.length && start < next.length && current[start] === next[start]) start++
  let end = 0
  while (end < current.length - start && end < next.length - start && current[current.length - 1 - end] === next[next.length - 1 - end]) end++
  return { from: start, to: current.length - end, insert: next.slice(start, next.length - end) }
}

export function FileEditor({ machine, thread, path, onLink, actions, children, onOpenFile }: FileEditorProps) {
  const isMarkdown = /\.(md|markdown|mdx)$/i.test(path)
  const [mode, setMode] = useState<'live' | 'source'>(() => localStorage.getItem(MODE) === 'source' ? 'source' : 'live')
  const live = isMarkdown && mode === 'live'
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView>(undefined)
  const modeSlot = useRef(new Compartment())
  /** What's on disk, as last read or written. */
  const disk = useRef<string>(undefined)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const [note, setNote] = useState<{ text: string; error?: boolean }>()
  /** The file changed on disk while there were edits here not yet saved: its new text. */
  const [conflict, setConflictState] = useState<string>()
  const conflictRef = useRef<string>(undefined)
  const setConflict = (text: string | undefined) => { conflictRef.current = text; setConflictState(text) }
  const dispatch = useRegistry().router.dispatch
  const linkRef = useRef(onLink)
  linkRef.current = onLink

  const modeExtensions = (liveMode: boolean): Extension => liveMode
    ? [markdown({ base: markdownLanguage }), livePreview(), syntaxHighlighting(liveHighlight), EditorView.editorAttributes.of({ class: 'is-live' })]
    : [lineNumbers(), highlightActiveLineGutter(), foldGutter(), highlightActiveLine(), syntaxHighlighting(defaultHighlightStyle), ...(isMarkdown ? [markdown({ base: markdownLanguage })] : [])]

  const save = async () => {
    clearTimeout(timer.current)
    const editor = view.current
    // Not over a change on disk the person hasn't chosen about yet.
    if (!editor || conflictRef.current !== undefined) return
    const content = editor.state.doc.toString()
    if (content === disk.current) return
    setNote({ text: 'Saving…' })
    try {
      await dispatch('file.write', { id: thread.id, path, content }, { machine: machine.id, source: 'editor' })
      disk.current = content
      setNote({ text: 'Saved' })
    } catch (error) { setNote({ text: (error as Error).message, error: true }) }
  }
  const saveRef = useRef(save)
  saveRef.current = save

  const open = (link: MarkdownLink) => {
    if (linkRef.current) return linkRef.current(link)
    if (link.kind === 'url' && /^[a-z][\w+.-]*:/i.test(link.target)) return void window.open(link.target, '_blank')
    void (async () => {
      const base = path.includes('/') ? path.slice(0, path.lastIndexOf('/') + 1) : ''
      const target = link.kind === 'url' ? `${base}${decodeURI(link.target.split('#')[0]!)}` : link.target
      const { path: found } = await client(machine.id).call('file.find', { id: thread.id, name: target })
      if (!found) return setNote({ text: `No file ${link.target}`, error: true })
      await dispatch('pane.open', { id: thread.id, kind: 'editor', params: { path: found } }, { machine: machine.id, source: 'editor' })
    })()
  }
  const openRef = useRef(open)
  openRef.current = open

  // The editor, made once per file.
  useEffect(() => {
    if (!host.current) return
    let alive = true
    disk.current = undefined
    setNote(undefined)
    setConflict(undefined)
    client(machine.id).call('file.read', { id: thread.id, path }).then(({ content }) => {
      if (!alive || !host.current) return
      disk.current = content
      view.current = new EditorView({
        parent: host.current,
        doc: content,
        extensions: [
          keymap.of([{ key: 'Mod-s', run: () => { void saveRef.current(); return true }, preventDefault: true }, ...searchKeymap]),
          minimalSetup, EditorView.lineWrapping,
          modeSlot.current.of(modeExtensions(live)),
          EditorView.updateListener.of((update) => {
            if (!update.docChanged || update.transactions.every((t) => t.annotation(fromDisk))) return
            setNote({ text: 'Edited' })
            clearTimeout(timer.current)
            timer.current = setTimeout(() => void saveRef.current(), 600)
          }),
          EditorView.domEventHandlers({
            mousedown(event) {
              const hit = event.button === 0 ? linkAt(event.target) : undefined
              if (!hit || (hit.raw && !(event.metaKey || event.ctrlKey))) return false
              event.preventDefault()
              openRef.current(hit.link)
              return true
            },
          }),
        ],
      })
    }, (error: Error) => alive && setNote({ text: error.message, error: true }))
    return () => {
      alive = false
      // Leaving with edits unsaved: save them now.
      if (view.current && view.current.state.doc.toString() !== disk.current) void saveRef.current()
      clearTimeout(timer.current)
      view.current?.destroy()
      view.current = undefined
    }
  }, [machine.id, thread.id, path])

  // Live preview or source, without losing the cursor or undo.
  useEffect(() => { view.current?.dispatch({ effects: modeSlot.current.reconfigure(modeExtensions(live)) }) }, [live])

  // The file on disk, again: whenever the thread moves on, often while the agent works, and on coming back here.
  useEffect(() => {
    let alive = true
    const check = async () => {
      const editor = view.current
      if (!editor || disk.current === undefined) return
      const { content } = await client(machine.id).call('file.read', { id: thread.id, path }).catch(() => ({ content: undefined }))
      if (!alive || content === undefined || content === disk.current) return
      const mine = editor.state.doc.toString()
      if (mine === disk.current) {
        editor.dispatch({ changes: minimalChange(mine, content), annotations: fromDisk.of(true) })
        disk.current = content
        setConflict(undefined)
      } else if (mine !== content) { clearTimeout(timer.current); setConflict(content) }
      else disk.current = content
    }
    void check()
    const working = thread.status.state === 'working'
    const every = working ? setInterval(() => void check(), 1500) : undefined
    window.addEventListener('focus', check)
    return () => { alive = false; clearInterval(every); window.removeEventListener('focus', check) }
  }, [machine.id, thread.id, path, thread.activeAt, thread.status.state])

  const takeTheirs = () => {
    const editor = view.current
    if (!editor || conflict === undefined) return
    clearTimeout(timer.current)
    editor.dispatch({ changes: minimalChange(editor.state.doc.toString(), conflict), annotations: fromDisk.of(true) })
    disk.current = conflict
    setConflict(undefined)
    setNote(undefined)
  }
  const keepMine = () => { disk.current = conflict; setConflict(undefined); void save() }

  const chooseMode = (next: 'live' | 'source') => { localStorage.setItem(MODE, next); setMode(next) }
  const registry = useRegistry()
  const slot: EditorSlotProps = {
    machine, thread, path,
    open: (file, { beside = false } = {}) => onOpenFile
      ? onOpenFile(file, { beside })
      : void dispatch('pane.open', { id: thread.id, kind: fileKind(registry, thread, file), params: { path: file } }, { machine: machine.id, source: 'editor' }),
  }
  return (
    <div className={`file-editor ${live ? 'file-editor--live' : ''}`}>
      <div className="pane-bar">
        <code title={path}>{path}</code>
        <span className={`pane-bar__note ${note?.error ? 'is-error' : ''}`}>{note?.text}</span>
        {actions}
        <Slot name="editor.bar" props={slot} />
        {isMarkdown && (
          <span className="file-editor__mode" role="group" aria-label="Show as">
            <button className={live ? 'is-on' : ''} aria-pressed={live} onClick={() => chooseMode('live')}>Live</button>
            <button className={!live ? 'is-on' : ''} aria-pressed={!live} onClick={() => chooseMode('source')}>Source</button>
          </span>
        )}
      </div>
      {conflict !== undefined && (
        <div className="file-editor__conflict">
          <span>The file changed on disk while you were editing it.</span>
          <Button onClick={takeTheirs}>Load it</Button>
          <Button onClick={keepMine}>Keep mine</Button>
        </div>
      )}
      <div className="file-editor__main">
        <Slot name="editor.side" props={slot} />
        <div className="file-editor__scroll">
          <div className="file-editor__host" ref={host} />
          {children && <div className="file-editor__after">{children}</div>}
        </div>
      </div>
    </div>
  )
}
