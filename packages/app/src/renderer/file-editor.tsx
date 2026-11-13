// A file in a thread's folder, open to edit. Markdown opens rendered (to read, as a message reads: its links open
// files and threads the same way), in live preview (as Obsidian does: rendered, its syntax back where the cursor is),
// or as source; anything else as source. It saves as you type, and follows the file when the agent changes it: your
// view updates, or, with edits of yours not yet saved, it asks which to keep.
// The editor pane is this; a profile's own panes use it too (the obsidian profile's notes), with their own links.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
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
import { fileKind, folderKind, Slot, urlKind, useRegistry, type EditorSlotProps } from './extension.tsx'
import { Images, Markdown, OpenFile, OpenUrl, ThreadMachine } from './Markdown.tsx'
import { codeHighlight } from './code-highlight.ts'
import { folderOf, imageType, resolve } from './markdown-html.ts'
import { linkAt, livePreview, type MarkdownLink } from './live-markdown.ts'
import { arrivals } from './arrivals.ts'

export type { MarkdownLink }
export type FileEditorProps = {
  machine: MachineEntry
  thread: ThreadInfo
  /** In the thread's folder. */
  path: string
  /** A line to show, with the cursor at its start: on opening, and whenever it changes. */
  line?: number
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

const MODE = 'superego.editor.mode'
/** How Markdown shows: read, as a message is; in live preview; or as source. */
type Mode = 'rendered' | 'live' | 'source'
const MODES: { mode: Mode; label: string }[] = [{ mode: 'rendered', label: 'Rendered' }, { mode: 'live', label: 'Live' }, { mode: 'source', label: 'Source' }]
/** As last chosen; live preview if never (or something this doesn't know). */
const storedMode = (): Mode => MODES.find((m) => m.mode === localStorage.getItem(MODE))?.mode ?? 'live'
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

const decode = (base64: string): Uint8Array<ArrayBuffer> => {
  const typed = Uint8Array as unknown as { fromBase64?(s: string): Uint8Array<ArrayBuffer> }
  return typed.fromBase64 ? typed.fromBase64(base64) : Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
}

/**
 * The images a rendered file shows, read from its thread's machine as any file of the thread's is (`file.read`, over
 * the socket or the WebSocket) into blob URLs: each once while the file is open, let go when it closes.
 */
function fileImages(machine: string, thread: string, path: string) {
  const read = new Map<string, Promise<string>>()
  const load = (file: string) => {
    let url = read.get(file)
    if (!url) {
      url = client(machine).call('file.read', { id: thread, path: file, base64: true })
        .then(({ content }) => URL.createObjectURL(new Blob([decode(content)], { type: imageType(file) })))
      // Tried again when next wanted.
      url.catch(() => { if (read.get(file) === url) read.delete(file) })
      read.set(file, url)
    }
    return url
  }
  const release = () => { for (const url of read.values()) url.then(URL.revokeObjectURL, () => {}); read.clear() }
  return { dir: folderOf(path), load, release }
}

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

export function FileEditor({ machine, thread, path, line, onLink, actions, children, onOpenFile }: FileEditorProps) {
  const isMarkdown = /\.(md|markdown|mdx)$/i.test(path)
  const [mode, setMode] = useState<Mode>(storedMode)
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
  const linkRef = useRef(onLink)
  linkRef.current = onLink
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
      const base = folderOf(path)
      const target = link.kind === 'url' ? `${base}${decodeURI(link.target.split('#')[0]!)}` : link.target
      const { path: found, folder } = await client(machine.id).call('file.find', { id: thread.id, name: target })
      if (found === null || folder) return setNote({ text: `No file ${link.target}`, error: true })
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
    setText(undefined)
    setNote(undefined)
    setConflict(undefined)
    client(machine.id).call('file.read', { id: thread.id, path }).then(({ content }) => {
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
              openRef.current(hit.link)
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
    peer.call('file.watch', { id: thread.id, path }).then((result) => {
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
    localStorage.setItem(MODE, next)
    const el = scroller.current
    if (el && (next === 'rendered') !== rendered) through.current = el.scrollTop / Math.max(1, el.scrollHeight - el.clientHeight)
    if (next === 'rendered' && view.current) setText(view.current.state.doc.toString())
    setMode(next)
  }

  // A file the text names: from beside this one first, as a link in it means, else as a message's would be (by its
  // name, anywhere in the folder). Opened beside the thread, in the pane kind that takes it; else why not.
  const findAndOpen = async (name: string): Promise<string | undefined> => {
    if (linkRef.current) return void linkRef.current({ kind: /[/.]/.test(name) ? 'url' : 'wiki', target: name })
    try {
      const peer = client(machine.id)
      const at = /^(.+?)((?::\d+)+|#L\d+.*)$/.exec(name)
      const near = resolve(folderOf(path), at?.[1] ?? name)
      const beside = near ? await peer.call('file.find', { id: thread.id, name: `${near}${at?.[2] ?? ''}` }) : undefined
      const found = beside && (beside.path === near || beside.path === `${near}.md`) ? beside : await peer.call('file.find', { id: thread.id, name })
      if (found.outside) return "outside this thread's folder"
      if (found.path === null) return "not in this thread's folder"
      const kind = found.folder ? folderKind(registry, { machine: machine.id, thread }) : fileKind(registry, { machine: machine.id, thread }, found.path)
      if (!kind) return found.folder ? 'a folder, and nothing here shows folders' : 'a file, and nothing here shows files'
      await dispatch('pane.open', { id: thread.id, kind, params: { path: found.path, ...(found.line ? { line: found.line } : {}) } }, { machine: machine.id, source: 'editor' })
      return undefined
    } catch (error) { return (error as Error).message }
  }
  const findAndOpenRef = useRef(findAndOpen)
  findAndOpenRef.current = findAndOpen
  // Kept the same, so the rendered text isn't laid out again on each render here.
  const openFile = useCallback((name: string) => findAndOpenRef.current(name), [])
  // A web page it links to, opened beside the thread in the pane kind that shows web pages; with none here, links open in
  // the browser only.
  const webKind = urlKind(registry, { machine: machine.id, thread })
  const openUrl = useCallback((url: string) => {
    if (!webKind) return
    const host = URL.parse(url)?.host
    void dispatch('pane.open', { id: thread.id, kind: webKind, ...(host ? { title: host } : {}), params: { url } }, { machine: machine.id, source: 'editor' })
      .catch((error) => console.error(error))
  }, [machine.id, thread.id, webKind])
  const openIn = (kind: string | undefined, file: string) => kind && dispatch('pane.open', { id: thread.id, kind, params: { path: file } }, { machine: machine.id, source: 'editor' })
  const images = useMemo(() => fileImages(machine.id, thread.id, path), [machine.id, thread.id, path])
  useEffect(() => images.release, [images])
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
              <OpenFile.Provider value={openFile}>
                <OpenUrl.Provider value={webKind ? openUrl : undefined}>
                  <ThreadMachine.Provider value={machine.id}>
                    <Images.Provider value={images}>
                      <Markdown text={text} html />
                    </Images.Provider>
                  </ThreadMachine.Provider>
                </OpenUrl.Provider>
              </OpenFile.Provider>
            </div>
          )}
          {children && <div className="file-editor__after">{children}</div>}
        </div>
      </div>
    </div>
  )
}
