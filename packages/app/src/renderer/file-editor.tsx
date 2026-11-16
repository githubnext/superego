// A file in a thread's folder, open to edit. Markdown opens rendered (to read, as a message reads: its links open
// files and threads the same way), in live preview (as Obsidian does: rendered, its syntax back where the cursor is),
// or as source; anything else as source. It saves as you type, and follows the file when the agent changes it: your
// view updates, or, with edits of yours not yet saved, it asks which to keep.
// The editor pane is this; a profile's own panes use it too (the obsidian profile's notes). Its links, rendered or in
// live preview, are followed by the link handlers, as a message's are: a thread's profile can claim them its own way.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { history, historyKeymap, standardKeymap } from '@codemirror/commands'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { foldGutter, HighlightStyle, LanguageDescription, syntaxHighlighting } from '@codemirror/language'
import { languages } from '@codemirror/language-data'
import { Annotation, Compartment, type Extension } from '@codemirror/state'
import { drawSelection, EditorView, highlightActiveLine, highlightActiveLineGutter, highlightSpecialChars, keymap, lineNumbers } from '@codemirror/view'
import { closeSearchPanel, findNext, findPrevious, openSearchPanel } from '@codemirror/search'
import { tags } from '@lezer/highlight'
import type { ThreadInfo } from '@superego/protocol'
import { Button } from '@superego/ui'
import type { MachineEntry } from '../shared.ts'
import { machine as client } from './client.ts'
import { fileKind, linkHandler, Slot, useRegistry, type EditorSlotProps } from './extension.tsx'
import { Images, imagesIn, Markdown } from './Markdown.tsx'
import { follow, LinkPlace, useLinkPlace } from './links.tsx'
import { useLocalState } from './local-state.ts'
import { codeHighlight } from './code-highlight.ts'
import { folderOf } from './markdown-html.ts'
import { linkAt, livePreview } from './live-markdown.ts'
import { arrivals } from './arrivals.ts'

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

/** How Markdown shows: read, as a message is; in live preview; or as source. */
type Mode = 'rendered' | 'live' | 'source'
const MODES: { mode: Mode; label: string }[] = [{ mode: 'rendered', label: 'Rendered' }, { mode: 'live', label: 'Live' }, { mode: 'source', label: 'Source' }]
/** Where each file was left (scroll and cursor), for as long as the window lives: it opens there again. */
const places = new Map<string, { top: number; anchor: number; head: number }>()
/**
 * The editor's keys: typing's own (moving, selecting, deleting, Enter, select all, macOS's Ctrl ones), undo and redo,
 * and find. Not CodeMirror's other defaults (⌘/ comment, ⌘L select line, ⌘I, ⌘[ ⌘], ⌥↑ ⌥↓, …): those keys are the
 * app's, and an editor with the focus would otherwise keep them from it.
 */
const EDITING_KEYS = [
  ...standardKeymap, ...historyKeymap,
  { key: 'Mod-f', run: openSearchPanel, scope: 'editor search-panel' },
  { key: 'Mod-g', run: findNext, shift: findPrevious, scope: 'editor search-panel', preventDefault: true },
  { key: 'Escape', run: closeSearchPanel, scope: 'editor search-panel' },
]

/** A change read from disk, not typed: it doesn't need saving. */
const fromDisk = Annotation.define<boolean>()

/** In live preview the syntax is quiet when shown, and code is monospace; the rest is the preview's own styling. */
const liveHighlight = HighlightStyle.define([
  { tag: tags.processingInstruction, color: 'var(--superego-faint)' },
  { tag: [tags.url, tags.labelName], color: 'var(--superego-muted)' },
  { tag: tags.monospace, fontFamily: 'var(--superego-mono)', fontSize: '0.92em' },
  { tag: tags.meta, color: 'var(--superego-muted)' },
])

/** The file's language by its name (or none): loaded on demand, as most files need only one. */
const languageOf = (path: string) => LanguageDescription.matchFilename(languages, path.split('/').at(-1) ?? path)

/** The text as it is on disk, after `next` changed it there: only the part that differs, so the cursor stays put. */
function minimalChange(current: string, next: string) {
  let start = 0
  while (start < current.length && start < next.length && current[start] === next[start]) start++
  let end = 0
  while (end < current.length - start && end < next.length - start && current[current.length - 1 - end] === next[next.length - 1 - end]) end++
  return { from: start, to: current.length - end, insert: next.slice(start, next.length - end) }
}

/**
 * The cursor at the start of `line` (1-based, kept in the file), and the line in the middle of `scroller` (the
 * editor's own scroll, around it), once the text is laid out.
 */
function goToLine(view: EditorView, line: number, scroller: HTMLElement | null) {
  const at = view.state.doc.line(Math.min(Math.max(1, line), view.state.doc.lines)).from
  view.dispatch({ selection: { anchor: at } })
  const center = () => {
    const coords = view.coordsAtPos(at)
    if (!coords || !scroller) return
    const box = scroller.getBoundingClientRect()
    scroller.scrollTop += coords.top - box.top - box.height / 2
  }
  requestAnimationFrame(() => { center(); requestAnimationFrame(center) })
}

/** A file of the thread's folder, to read and edit, as the core's editor pane shows it. */
export function FileEditor({ machine, thread, path, line, actions, children, onOpenFile }: FileEditorProps) {
  const isMarkdown = /\.(md|markdown|mdx)$/i.test(path)
  // As last chosen, in any window; live preview if never (or something this doesn't know).
  const [stored, setMode] = useLocalState<Mode>('editor.mode', 'live', { shared: true })
  const mode = MODES.some((m) => m.mode === stored) ? stored : 'live'
  /** The editor in live preview: shown, or kept behind the rendered text. */
  const live = isMarkdown && mode !== 'source'
  const rendered = isMarkdown && mode === 'rendered'
  const renderedRef = useRef(rendered)
  renderedRef.current = rendered
  /** The text rendered: the editor's, as it changes, while it's shown. */
  const [text, setText] = useState<string>()
  const host = useRef<HTMLDivElement>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const place = `${machine.id}/${thread.id}/${path}`
  const view = useRef<EditorView>(undefined)
  const modeSlot = useRef(new Compartment())
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
  // The line to open at, for the editor made below.
  const lineRef = useRef(line)
  lineRef.current = line

  const modeExtensions = (liveMode: boolean): Extension => liveMode
    ? [markdown({ base: markdownLanguage, codeLanguages: languages }), livePreview(), syntaxHighlighting(liveHighlight), syntaxHighlighting(codeHighlight), EditorView.editorAttributes.of({ class: 'is-live' })]
    : [lineNumbers(), highlightActiveLineGutter(), foldGutter(), highlightActiveLine(), syntaxHighlighting(codeHighlight), ...(isMarkdown ? [markdown({ base: markdownLanguage, codeLanguages: languages })] : [])]
  // Any other file's language, once loaded.
  const languageSlot = useRef(new Compartment())

  const save = async () => {
    clearTimeout(timer.current)
    const editor = view.current
    // Not over a change on disk the person hasn't chosen about yet.
    if (!editor || conflictRef.current !== undefined) return
    const content = editor.state.doc.toString()
    if (content === disk.current) return
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

  // Where its links are: a file it names is looked for beside it first, as a link in it means, else as a message's
  // would be (by its name, anywhere in the folder).
  const links = useLinkPlace(machine.id, thread, { near: folderOf(path), source: 'editor' })
  // A link in live preview (a click on it, or ⌘-click while it's being edited; ⌘: beside), followed by its handler, as
  // in rendered text; one none claims, in the browser.
  const open = (href: string, beside: boolean) => {
    const handler = linkHandler(registry, href, 'link', links)
    if (!handler) return void (/^[a-z][\w+.-]*:/i.test(href) && window.open(href, '_blank', 'noopener,noreferrer'))
    void follow(handler, href, 'link', links, beside).then((problem) => { if (problem) setNote({ text: `${href}: ${problem}`, error: true }) })
  }
  const openRef = useRef(open)
  openRef.current = open

  // The editor, made once per file.
  useEffect(() => {
    if (!host.current) return
    let alive = true
    disk.current = undefined
    setText(undefined)
    setNote(undefined)
    setConflict(undefined)
    client(machine.id).call('file.read', { thread: thread.id, path }).then(({ content }) => {
      if (!alive || !host.current) return
      disk.current = content
      setText(content)
      view.current = new EditorView({
        parent: host.current,
        doc: content,
        extensions: [
          keymap.of([{ key: 'Mod-s', run: () => { void saveRef.current(); return true }, preventDefault: true }, ...EDITING_KEYS]),
          highlightSpecialChars(), history(), drawSelection(), syntaxHighlighting(codeHighlight, { fallback: true }),
          EditorView.lineWrapping,
          modeSlot.current.of(modeExtensions(live)),
          languageSlot.current.of([]),
          // What the agent (or anyone) changes on disk flashes as it arrives.
          arrivals(fromDisk),
          EditorView.updateListener.of((update) => {
            // Rendered, it follows the text: what arrives from disk, and what's taken over it.
            if (update.docChanged && renderedRef.current) setText(update.state.doc.toString())
            if (!update.docChanged || update.transactions.every((t) => t.annotation(fromDisk))) return
            setNote({ text: 'Edited' })
            clearTimeout(timer.current)
            timer.current = setTimeout(() => void saveRef.current(), 600)
          }),
          // The cursor, kept with the scroll for when the file opens again.
          EditorView.updateListener.of((update) => {
            if (!update.selectionSet) return
            const { anchor, head } = update.state.selection.main
            places.set(place, { top: scroller.current?.scrollTop ?? places.get(place)?.top ?? 0, anchor, head })
          }),
          EditorView.domEventHandlers({
            mousedown(event) {
              const hit = event.button === 0 ? linkAt(event.target) : undefined
              if (!hit || (hit.raw && !(event.metaKey || event.ctrlKey))) return false
              event.preventDefault()
              openRef.current(hit.href, event.metaKey || event.ctrlKey)
              return true
            },
          }),
        ],
      })
      const language = isMarkdown ? undefined : languageOf(path)
      if (language) void language.load().then((support) => {
        if (alive && view.current) view.current.dispatch({ effects: languageSlot.current.reconfigure(support) })
      }, () => {})
      // At the line asked for; else back where it was left: the cursor, and the scroll once the text is laid out.
      const was = places.get(place)
      if (lineRef.current) goToLine(view.current, lineRef.current, scroller.current)
      else if (was) {
        const length = view.current.state.doc.length
        view.current.dispatch({ selection: { anchor: Math.min(was.anchor, length), head: Math.min(was.head, length) } })
        const restore = () => { if (scroller.current) scroller.current.scrollTop = was.top }
        restore()
        requestAnimationFrame(() => { restore(); requestAnimationFrame(restore) })
      }
    }, (error: Error) => alive && setNote({ text: error.message, error: true }))
    return () => {
      alive = false
      // The scroll as last seen (the container is gone by now), with the cursor.
      if (view.current) {
        const { anchor, head } = view.current.state.selection.main
        places.set(place, { top: places.get(place)?.top ?? 0, anchor, head })
      }
      // Leaving with edits unsaved: save them now.
      if (view.current && view.current.state.doc.toString() !== disk.current) void saveRef.current()
      clearTimeout(timer.current)
      view.current?.destroy()
      view.current = undefined
    }
  }, [machine.id, thread.id, path])

  // Asked for another line of the open file.
  useEffect(() => { if (line && view.current) goToLine(view.current, line, scroller.current) }, [line])

  // Live preview or source, without losing the cursor or undo.
  useEffect(() => { view.current?.dispatch({ effects: modeSlot.current.reconfigure(modeExtensions(live)) }) }, [live])

  // Rendered or the editor, each scrolled as far through the text as the other was. The editor stays as it was, only
  // hidden: its cursor, undo and search.
  const through = useRef<number>(undefined)
  useLayoutEffect(() => {
    const el = scroller.current
    const at = through.current
    through.current = undefined
    if (!el || at === undefined) return
    const scroll = () => { el.scrollTop = at * (el.scrollHeight - el.clientHeight) }
    // The editor measures itself once shown.
    scroll()
    requestAnimationFrame(scroll)
  }, [rendered])

  // The file on disk as it changes, whoever changes it (the agent, another editor, git), watched on its machine: shown
  // here at once when nothing typed here is waiting to be saved, else asked about. Its own saves are recognised.
  const connected = machine.state === 'connected'
  useEffect(() => {
    if (!connected) return
    const peer = client(machine.id)
    let sub: string | undefined
    let stopped = false
    const apply = (content: string | null) => {
      const editor = view.current
      if (!editor || disk.current === undefined) return
      if (content === null) return setNote({ text: 'Not on disk any more', error: true })
      if (content === disk.current) return
      if (content === saving.current) { disk.current = content; return }
      const mine = editor.state.doc.toString()
      if (mine === disk.current) {
        editor.dispatch({ changes: minimalChange(mine, content), annotations: fromDisk.of(true) })
        disk.current = content
        setConflict(undefined)
      } else if (mine !== content) { clearTimeout(timer.current); setConflict(content) }
      else disk.current = content
    }
    const off = peer.on('file.changed', (params) => { if (params.sub === sub) apply(params.content) })
    peer.call('file.watch', { thread: thread.id, path }).then((result) => {
      if (stopped) return void peer.call('unwatch', { sub: result.sub }).catch(() => {})
      sub = result.sub
      apply(result.content)
    }, () => {})
    return () => { stopped = true; off(); if (sub) void peer.call('unwatch', { sub }).catch(() => {}) }
  }, [machine.id, connected, thread.id, path])

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

  const chooseMode = (next: Mode) => {
    const el = scroller.current
    if (el && (next === 'rendered') !== rendered) through.current = el.scrollTop / Math.max(1, el.scrollHeight - el.clientHeight)
    if (next === 'rendered' && view.current) setText(view.current.state.doc.toString())
    setMode(next)
  }

  const openIn = (kind: string | undefined, file: string) => kind && dispatch('pane.open', { thread: thread.id, kind, params: { path: file } }, { machine: machine.id, source: 'editor' })
  // Its images, read from beside it on the thread's machine.
  const images = useMemo(() => imagesIn(machine, thread.id, thread.cwd, folderOf(path)), [machine, thread.id, thread.cwd, path])
  const slot: EditorSlotProps = {
    machine, thread, path,
    open: (file, { beside = false } = {}) => onOpenFile
      ? onOpenFile(file, { beside })
      : void openIn(fileKind(registry, { machine: machine.id, thread }, file), file),
  }
  return (
    <div className={`file-editor ${rendered ? 'file-editor--rendered' : live ? 'file-editor--live' : ''}`}>
      <div className="pane-bar">
        <code title={path}>{path}</code>
        <span className={`pane-bar__note ${note?.error ? 'is-error' : ''}`}>{note?.text}</span>
        {actions}
        <Slot name="editor.bar" props={slot} />
        {isMarkdown && (
          <span className="file-editor__mode" role="group" aria-label="Show as">
            {MODES.map(({ mode: each, label }) => (
              <button key={each} className={mode === each ? 'is-on' : ''} aria-pressed={mode === each} onClick={() => chooseMode(each)}>{label}</button>
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
        <div className="file-editor__scroll" ref={scroller}
          onScroll={(e) => { const was = places.get(place); places.set(place, { anchor: was?.anchor ?? 0, head: was?.head ?? 0, top: e.currentTarget.scrollTop }) }}>
          <div className="file-editor__host" ref={host} hidden={rendered} />
          {rendered && text !== undefined && (
            <div className="file-editor__rendered" tabIndex={-1}>
              <LinkPlace.Provider value={links}>
                <Images.Provider value={images}>
                  <Markdown text={text} html />
                </Images.Provider>
              </LinkPlace.Provider>
            </div>
          )}
          {children && <div className="file-editor__after">{children}</div>}
        </div>
      </div>
    </div>
  )
}
