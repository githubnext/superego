// Text to edit, wherever it's kept: CodeMirror with the app's keys, and for Markdown, three ways to show it: rendered
// (read as a message reads), live preview (as Obsidian does: rendered, its syntax back where the cursor is), or source.
// It keeps nothing itself: `value` is the text from outside, `onChange` what's typed. A new `value` from outside (the
// agent's edit, a file changed on disk) goes in as the least change that makes it, so the cursor stays put, and flashes
// as it arrives. The editor pane's FileEditor is this plus a file; a space's notes page is this plus its own store.
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { history, historyKeymap, redo, standardKeymap, undo } from '@codemirror/commands'
import { markdown as markdownSupport, markdownLanguage } from '@codemirror/lang-markdown'
import { foldGutter, HighlightStyle, LanguageDescription, syntaxHighlighting } from '@codemirror/language'
import { languages } from '@codemirror/language-data'
import { Annotation, Compartment, EditorState, type Extension } from '@codemirror/state'
import { drawSelection, EditorView, highlightActiveLine, highlightActiveLineGutter, highlightSpecialChars, keymap, lineNumbers, placeholder as placeholderText } from '@codemirror/view'
import { closeSearchPanel, findNext, findPrevious, openSearchPanel } from '@codemirror/search'
import { tags } from '@lezer/highlight'
import type { LinkWhere } from './extension-api.ts'
import { useRegistry } from './registry.tsx'
import { linkHandler } from './lookups.ts'
import { Images, Markdown, type ImagesIn } from './Markdown.tsx'
import { follow, LinkPlace } from './links.tsx'
import { codeHighlight } from './code-highlight.ts'
import { linkAt, livePreview } from './live-markdown.ts'
import { arrivals } from './arrivals.ts'
import { useAppDark } from './appearance.ts'

/** How Markdown shows: read, as a message is; in live preview; or as source. */
export type TextMode = 'rendered' | 'live' | 'source'
/** The ways Markdown shows, in the order offered, each with its label (for a toggle of one's own). */
export const TEXT_MODES: { mode: TextMode; label: string }[] = [{ mode: 'rendered', label: 'Rendered' }, { mode: 'live', label: 'Live' }, { mode: 'source', label: 'Source' }]

/** What a `TextEditor` shows and how: its text from outside, what's typed, how Markdown shows, where it was left. */
export type TextEditorProps = {
  /** The text, as it is outside (on disk, in a store): shown, and taken in again whenever it changes. */
  value: string
  /** What's typed: the whole text after each change. Not called for `value` taken in. */
  onChange?(text: string): void
  /** Bump to take `value` in again though it's the same string as before (back to theirs after typing over it). */
  revision?: number
  /** Markdown (its modes), or not: source with line numbers. Default: by `path`'s name, else Markdown. */
  markdown?: boolean
  /** How Markdown shows; default live preview. */
  mode?: TextMode
  /** A file name, for the language a non-Markdown text is in. */
  path?: string
  /** A line to show, with the cursor at its start: on opening, and whenever it changes. */
  line?: number
  /** Where it was left (cursor and scroll) is kept under this key while the window lives, and found again on opening. */
  place?: string
  /** Its links, followed by the link handlers as a message's are: where they're from. */
  links?: LinkWhere
  /** Its images, read from where it is. */
  images?: ImagesIn
  /** ⌘S. */
  onSave?(): void
  /** Following a link failed: why. */
  onProblem?(problem: string): void
  /** Shown while it's empty. */
  placeholder?: string
  /** Read, not edited (the text gone from where it was kept, say): `value` still goes in. */
  readOnly?: boolean
  /** Below the text, scrolling with it: a note's backlinks, say. */
  children?: ReactNode
}

/** Where each text was left (scroll and cursor), by `place`, for as long as the window lives. */
const places = new Map<string, { top: number; anchor: number; head: number }>()
/**
 * The editor's keys: typing's own (moving, selecting, deleting, Enter, select all, macOS's Ctrl ones), undo and redo,
 * and find. Not CodeMirror's other defaults (⌘/ comment, ⌘L select line, ⌘I, ⌘[ ⌘], ⌥↑ ⌥↓, ⌘U ⌘⇧U undo and redo a
 * selection, …): those keys are the app's, and an editor with the focus would otherwise keep them from it. Nor the Ctrl
 * ones the app binds (⌃D scrolls, ⌃O lists links, ⌃T goes to the threads): pressed in an editor, they'd do both.
 */
const APP_CTRL_KEYS = new Set(['Ctrl-d', 'Ctrl-o', 'Ctrl-t'])
const EDITING_KEYS = [
  ...standardKeymap.filter((binding) => !binding.mac || !APP_CTRL_KEYS.has(binding.mac)), ...historyKeymap.filter((binding) => binding.run === undo || binding.run === redo),
  { key: 'Mod-f', run: openSearchPanel, scope: 'editor search-panel' },
  { key: 'Mod-g', run: findNext, shift: findPrevious, scope: 'editor search-panel', preventDefault: true },
  { key: 'Escape', run: closeSearchPanel, scope: 'editor search-panel' },
]

/** A change taken in from outside, not typed: not told to `onChange`. */
const fromOutside = Annotation.define<boolean>()

/** In live preview the syntax is quiet when shown, and code is monospace; the rest is the preview's own styling. */
const liveHighlight = HighlightStyle.define([
  { tag: tags.processingInstruction, color: 'var(--superego-faint)' },
  { tag: [tags.url, tags.labelName], color: 'var(--superego-muted)' },
  { tag: tags.monospace, fontFamily: 'var(--superego-mono)', fontSize: '0.92em' },
  { tag: tags.meta, color: 'var(--superego-muted)' },
])

/** The language by a file's name (or none): loaded on demand, as most texts need only one. */
const languageOf = (path: string) => LanguageDescription.matchFilename(languages, path.split('/').at(-1) ?? path)

/** Whether a file of this name is Markdown. */
export const isMarkdownPath = (path: string) => /\.(md|markdown|mdx)$/i.test(path)

/** `current` made `next` by only the part that differs, so the cursor stays put. */
export function minimalChange(current: string, next: string) {
  let start = 0
  while (start < current.length && start < next.length && current[start] === next[start]) start++
  let end = 0
  while (end < current.length - start && end < next.length - start && current[current.length - 1 - end] === next[next.length - 1 - end]) end++
  return { from: start, to: current.length - end, insert: next.slice(start, next.length - end) }
}

/**
 * The cursor at the start of `line` (1-based, kept in the text), and the line in the middle of `scroller` (the
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

/** Text to edit (see the top of this file). */
export function TextEditor({
  value, onChange, revision = 0, markdown, mode = 'live', path, line, place, links = {}, images, onSave, onProblem, placeholder, readOnly = false, children,
}: TextEditorProps) {
  const isMarkdown = markdown ?? (path ? isMarkdownPath(path) : true)
  /** The editor in live preview: shown, or kept behind the rendered text. */
  const live = isMarkdown && mode !== 'source'
  const rendered = isMarkdown && mode === 'rendered'
  /** The text rendered: the editor's, as it changes. */
  const [text, setText] = useState(value)
  const host = useRef<HTMLDivElement>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView>(undefined)
  const modeSlot = useRef(new Compartment())
  const languageSlot = useRef(new Compartment())
  const darkSlot = useRef(new Compartment())
  const readOnlySlot = useRef(new Compartment())
  const readOnlyOf = (on: boolean) => [EditorState.readOnly.of(on), EditorView.editable.of(!on)]
  const registry = useRegistry()
  // What its callbacks are now, for the editor made once.
  const latest = useRef({ onChange, onSave, onProblem, links, place })
  latest.current = { onChange, onSave, onProblem, links, place }
  // What was last taken in from outside: a `value` (and `revision`) seen already isn't taken in again.
  const taken = useRef({ value, revision })

  const modeExtensions = (liveMode: boolean): Extension => liveMode
    ? [markdownSupport({ base: markdownLanguage, codeLanguages: languages }), livePreview(), syntaxHighlighting(liveHighlight), syntaxHighlighting(codeHighlight), EditorView.editorAttributes.of({ class: 'is-live' })]
    : [lineNumbers(), highlightActiveLineGutter(), foldGutter(), highlightActiveLine(), syntaxHighlighting(codeHighlight), ...(isMarkdown ? [markdownSupport({ base: markdownLanguage, codeLanguages: languages })] : [])]
  // Light or dark as the window is, for CodeMirror's own styles (the active line and its number, the cursor, the
  // selection, the search panel): told, or it draws its light ones whatever the window.
  const dark = useAppDark()
  const darkRef = useRef(dark)
  darkRef.current = dark
  useEffect(() => { view.current?.dispatch({ effects: darkSlot.current.reconfigure(EditorView.darkTheme.of(dark)) }) }, [dark])

  // A link in live preview (a click on it, or ⌘-click while it's being edited; ⌘: beside), followed by its handler, as
  // in rendered text; one none claims, in the browser.
  const open = (href: string, beside: boolean) => {
    const where = latest.current.links
    const handler = linkHandler(registry, href, 'link', where)
    if (!handler) return void (/^[a-z][\w+.-]*:/i.test(href) && window.open(href, '_blank', 'noopener,noreferrer'))
    void follow(handler, href, 'link', where, beside).then((problem) => { if (problem) latest.current.onProblem?.(`${href}: ${problem}`) })
  }
  const openRef = useRef(open)
  openRef.current = open

  // The editor, made once.
  useEffect(() => {
    if (!host.current) return
    let alive = true
    const editor = view.current = new EditorView({
      parent: host.current,
      doc: value,
      extensions: [
        keymap.of([{ key: 'Mod-s', run: () => { latest.current.onSave?.(); return true }, preventDefault: true }, ...EDITING_KEYS]),
        highlightSpecialChars(), history(), drawSelection(), syntaxHighlighting(codeHighlight, { fallback: true }),
        EditorView.lineWrapping,
        ...(placeholder ? [placeholderText(placeholder)] : []),
        modeSlot.current.of(modeExtensions(live)),
        languageSlot.current.of([]),
        darkSlot.current.of(EditorView.darkTheme.of(darkRef.current)),
        readOnlySlot.current.of(readOnlyOf(readOnly)),
        // What comes in from outside (the agent's edit, say) flashes as it arrives.
        arrivals(fromOutside),
        EditorView.updateListener.of((update) => {
          if (!update.docChanged) return
          const now = update.state.doc.toString()
          setText(now)
          if (update.transactions.every((t) => t.annotation(fromOutside))) return
          latest.current.onChange?.(now)
        }),
        // The cursor, kept with the scroll for when it opens again.
        EditorView.updateListener.of((update) => {
          const key = latest.current.place
          if (!update.selectionSet || !key) return
          const { anchor, head } = update.state.selection.main
          places.set(key, { top: scroller.current?.scrollTop ?? places.get(key)?.top ?? 0, anchor, head })
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
    const language = isMarkdown || !path ? undefined : languageOf(path)
    if (language) void language.load().then((support) => {
      if (alive && view.current) view.current.dispatch({ effects: languageSlot.current.reconfigure(support) })
    }, (error: Error) => console.error(`Loading the ${language.name} language`, error))
    // At the line asked for; else back where it was left: the cursor, and the scroll once the text is laid out.
    const was = place ? places.get(place) : undefined
    if (line) goToLine(editor, line, scroller.current)
    else if (was) {
      const length = editor.state.doc.length
      editor.dispatch({ selection: { anchor: Math.min(was.anchor, length), head: Math.min(was.head, length) } })
      const restore = () => { if (scroller.current) scroller.current.scrollTop = was.top }
      restore()
      requestAnimationFrame(() => { restore(); requestAnimationFrame(restore) })
    }
    return () => {
      alive = false
      // The scroll as last seen (the container is gone by now), with the cursor.
      const key = latest.current.place
      if (key) {
        const { anchor, head } = editor.state.selection.main
        places.set(key, { top: places.get(key)?.top ?? 0, anchor, head })
      }
      editor.destroy()
      view.current = undefined
    }
  }, [])

  // `value` from outside, when it's new: as the least change, so the cursor stays put.
  useEffect(() => {
    const editor = view.current
    if (!editor || (taken.current.value === value && taken.current.revision === revision)) return
    taken.current = { value, revision }
    const mine = editor.state.doc.toString()
    if (mine !== value) editor.dispatch({ changes: minimalChange(mine, value), annotations: fromOutside.of(true) })
  }, [value, revision])

  useEffect(() => { view.current?.dispatch({ effects: readOnlySlot.current.reconfigure(readOnlyOf(readOnly)) }) }, [readOnly])

  // Asked for another line.
  useEffect(() => { if (line && view.current) goToLine(view.current, line, scroller.current) }, [line])

  // Live preview or source, without losing the cursor or undo.
  useEffect(() => { view.current?.dispatch({ effects: modeSlot.current.reconfigure(modeExtensions(live)) }) }, [live])

  // Rendered or the editor, each scrolled as far through the text as the other was. The editor stays as it was, only
  // hidden: its cursor, undo and search.
  const through = useRef(0)
  useLayoutEffect(() => {
    const el = scroller.current
    if (!el) return
    const at = through.current
    const scroll = () => { el.scrollTop = at * (el.scrollHeight - el.clientHeight) }
    // The editor measures itself once shown.
    scroll()
    requestAnimationFrame(scroll)
  }, [rendered])

  return (
    <div className={`file-editor__scroll text-editor text-editor--${rendered ? 'rendered' : live ? 'live' : 'source'}`} ref={scroller}
      onScroll={(e) => {
        const el = e.currentTarget
        through.current = el.scrollTop / Math.max(1, el.scrollHeight - el.clientHeight)
        const key = latest.current.place
        if (!key) return
        const was = places.get(key)
        places.set(key, { anchor: was?.anchor ?? 0, head: was?.head ?? 0, top: el.scrollTop })
      }}>
      <div className="file-editor__host" ref={host} hidden={rendered} />
      {rendered && (
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
  )
}
