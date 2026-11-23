// A file in a thread's folder, open to edit; an image shows as itself (image-file.tsx). The text is a TextEditor
// (text-editor.tsx: Markdown rendered, in live preview or as source; anything else as source). It saves as you type,
// and follows the file when the agent changes it: your view updates, or, with edits of yours not yet saved, it asks
// which to keep.
// The editor pane is this; a profile's own panes use it too (the obsidian profile's notes). Its links, rendered or in
// live preview, are followed by the link handlers, as a message's are: a thread's profile can claim them its own way.
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { ThreadInfo } from '@superego/protocol'
import { Button } from '@superego/ui'
import type { MachineEntry } from '../shared/bridge.ts'
import { machine as client } from './client.ts'
import type { EditorSlotProps } from './extension-api.ts'
import { useRegistry } from './registry.tsx'
import { fileKind } from './lookups.ts'
import { Slot } from './placement.tsx'
import { imagesIn } from './Markdown.tsx'
import { useLinkPlace } from './links.tsx'
import { useLocalState } from './local-state.ts'
import { folderOf } from './markdown-html.ts'
import { filePath } from './short-path.ts'
import { ImageFile, isImageFile } from './image-file.tsx'
import { isMarkdownPath, TEXT_MODES, TextEditor, type TextMode } from './text-editor.tsx'

/** The file a `FileEditor` shows, and what goes around it. */
export type FileEditorProps = {
  machine: MachineEntry
  thread: ThreadInfo
  /** In the thread's folder. */
  path: string
  /** A line to show, with the cursor at its start: on opening, and whenever it changes. */
  line?: number
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

/** A file of the thread's folder, to read and edit, as the core's editor pane shows it. */
export function FileEditor(props: FileEditorProps) {
  const { machine, thread, path, actions } = props
  return isImageFile(path) ? <ImageFile machine={machine} thread={thread} path={path} actions={actions} /> : <FileText {...props} />
}

function FileText({ machine, thread, path, line, actions, children, onOpenFile }: FileEditorProps) {
  const isMarkdown = isMarkdownPath(path)
  // As last chosen, in any window; live preview if never (or something this doesn't know).
  const [stored, setMode] = useLocalState<TextMode>('editor.mode', 'live', { shared: true })
  const mode = TEXT_MODES.some((m) => m.mode === stored) ? stored : 'live'
  /** What the editor shows from disk: taken in again as `rev` moves on. */
  const [shown, setShown] = useState<{ text: string; rev: number }>()
  /** What's typed, as it is now. */
  const mine = useRef<string>(undefined)
  /** What's on disk, as last read or written. */
  const disk = useRef<string>(undefined)
  /** What this editor is writing now: the change on disk that's its own. */
  const saving = useRef<string>(undefined)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const [note, setNote] = useState<{ text: string; error?: boolean }>()
  /** The file changed on disk while there were edits here not yet saved: its new text. */
  const [conflict, setConflictState] = useState<string>()
  const conflictRef = useRef<string>(undefined)
  const setConflict = (text: string | undefined) => { conflictRef.current = text; setConflictState(text) }
  const registry = useRegistry()
  const dispatch = registry.router.dispatch
  const take = (text: string) => { mine.current = text; setShown((was) => ({ text, rev: (was?.rev ?? 0) + 1 })) }

  const save = async () => {
    clearTimeout(timer.current)
    const content = mine.current
    // Not over a change on disk the person hasn't chosen about yet.
    if (content === undefined || conflictRef.current !== undefined || content === disk.current) return
    setNote({ text: 'Saving…' })
    saving.current = content
    try {
      await dispatch('file.write', { thread: thread.id, path, content }, { machine: machine.id, source: 'editor' })
      disk.current = content
      setNote({ text: 'Saved' })
    } catch (error) { setNote({ text: (error as Error).message, error: true }) }
  }
  const saveRef = useRef(save)
  saveRef.current = save
  const typed = (text: string) => {
    mine.current = text
    setNote({ text: 'Edited' })
    clearTimeout(timer.current)
    timer.current = setTimeout(() => void saveRef.current(), 600)
  }

  // Where its links are: a file it names is looked for beside it first, as a link in it means, else as a message's
  // would be (by its name, anywhere in the folder).
  const links = useLinkPlace(machine, thread, { near: folderOf(path), source: 'editor' })

  // The file, read once per file; what's typed and not yet saved is saved on leaving it.
  useEffect(() => {
    let alive = true
    disk.current = undefined
    mine.current = undefined
    setShown(undefined)
    setNote(undefined)
    setConflict(undefined)
    client(machine.id).call('file.read', { thread: thread.id, path }).then(({ content }) => {
      if (!alive) return
      disk.current = content
      take(content)
    }, (error: Error) => alive && setNote({ text: error.message, error: true }))
    return () => {
      alive = false
      if (mine.current !== undefined && mine.current !== disk.current) void saveRef.current()
      clearTimeout(timer.current)
    }
  }, [machine.id, thread.id, path])

  // The file on disk as it changes, whoever changes it (the agent, another editor, git), watched on its machine: shown
  // here at once when nothing typed here is waiting to be saved, else asked about. Its own saves are recognised.
  const connected = machine.state === 'connected'
  useEffect(() => {
    if (!connected) return
    const peer = client(machine.id)
    let sub: string | undefined
    let stopped = false
    const apply = (content: string | null) => {
      if (mine.current === undefined || disk.current === undefined) return
      if (content === null) return setNote({ text: 'Not on disk any more', error: true })
      if (content === disk.current) return
      if (content === saving.current) { disk.current = content; return }
      if (mine.current === disk.current) {
        take(content)
        disk.current = content
        setConflict(undefined)
      } else if (mine.current !== content) { clearTimeout(timer.current); setConflict(content) }
      else disk.current = content
    }
    const off = peer.on('file.changed', (params) => { if (params.sub === sub) apply(params.content) })
    peer.call('file.watch', { thread: thread.id, path }).then((result) => {
      if (stopped) return void peer.call('unwatch', { sub: result.sub }).catch(() => {})
      sub = result.sub
      apply(result.content)
    }, (error: Error) => setNote({ text: `Not following the file: ${error.message}`, error: true }))
    return () => { stopped = true; off(); if (sub) void peer.call('unwatch', { sub }).catch(() => {}) }
  }, [machine.id, connected, thread.id, path])

  const takeTheirs = () => {
    if (conflict === undefined) return
    clearTimeout(timer.current)
    take(conflict)
    disk.current = conflict
    setConflict(undefined)
    setNote(undefined)
  }
  const keepMine = () => { disk.current = conflict; setConflict(undefined); void save() }

  const openIn = (kind: string | undefined, file: string) => kind && dispatch('pane.open', { thread: thread.id, kind, params: { path: file } }, { machine: machine.id, source: 'editor' })
  // Its images, read from beside it on the thread's machine.
  const images = useMemo(() => imagesIn(machine, thread.id, folderOf(path)), [machine, thread.id, path])
  const slot: EditorSlotProps = {
    machine, thread, path,
    open: (file, { beside = false } = {}) => onOpenFile
      ? onOpenFile(file, { beside })
      : void openIn(fileKind(registry, { machine: machine.id, thread }, file), file),
  }
  return (
    <div className="file-editor">
      <div className="pane-bar">
        <code title={path}>{filePath(thread.cwd, path)}</code>
        <span className={`pane-bar__note ${note?.error ? 'is-error' : ''}`}>{note?.text}</span>
        {actions}
        <Slot name="editor.bar" props={slot} />
        {isMarkdown && (
          <span className="file-editor__mode" role="group" aria-label="Show as">
            {TEXT_MODES.map(({ mode: each, label }) => (
              <button key={each} className={mode === each ? 'is-on' : ''} aria-pressed={mode === each} onClick={() => setMode(each)}>{label}</button>
            ))}
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
        {shown
          ? <TextEditor value={shown.text} revision={shown.rev} onChange={typed} markdown={isMarkdown} mode={mode} path={path} {...(line ? { line } : {})}
              place={`${machine.id}/${thread.id}/${path}`} links={links} images={images} onSave={() => void saveRef.current()}
              onProblem={(problem) => setNote({ text: problem, error: true })}>{children}</TextEditor>
          : <div className="file-editor__scroll" />}
      </div>
    </div>
  )
}
