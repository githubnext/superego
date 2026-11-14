// Markdown shown as it reads, edited as it's written: Obsidian's live preview, on CodeMirror. Headings, emphasis, code,
// links, [[wikilinks]], #tags, quotes, lists and tasks render in place; the syntax behind one comes back where the
// cursor is while you edit (marks inside a line where the selection touches them, a line's own marks on its lines).
// Links are marked with `data-link`, their href (a [[wikilink]]'s as `wikilink:`, wikilinks.ts), so the editor that
// holds this follows them through the link handlers, as a message's are.
import { syntaxTree } from '@codemirror/language'
import type { EditorState, Range } from '@codemirror/state'
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from '@codemirror/view'
import type { SyntaxNodeRef } from '@lezer/common'
import { wikilinkHref } from './wikilinks.ts'


class Bullet extends WidgetType {
  eq() { return true }
  toDOM() { const el = document.createElement('span'); el.className = 'cm-lp-bullet'; el.textContent = '•'; return el }
}

class Checkbox extends WidgetType {
  readonly checked: boolean
  readonly at: number
  constructor(checked: boolean, at: number) { super(); this.checked = checked; this.at = at }
  eq(other: Checkbox) { return other.checked === this.checked && other.at === this.at }
  toDOM(view: EditorView) {
    const box = document.createElement('input')
    box.type = 'checkbox'
    box.className = 'cm-lp-task'
    box.checked = this.checked
    box.addEventListener('mousedown', (event) => {
      // Ticking it edits the text: `[ ]` ⇄ `[x]`, without moving the cursor there.
      event.preventDefault()
      view.dispatch({ changes: { from: this.at + 1, to: this.at + 2, insert: this.checked ? ' ' : 'x' } })
    })
    return box
  }
  ignoreEvent() { return false }
}

class Rule extends WidgetType {
  eq() { return true }
  toDOM() { const el = document.createElement('span'); el.className = 'cm-lp-hr'; return el }
}

const hide = Decoration.replace({})
const mark = (className: string, attributes?: Record<string, string>) => Decoration.mark({ class: className, attributes })
const line = (className: string) => Decoration.line({ class: className })

const WIKILINK = /(!?)\[\[([^\]|#^\n]*)([#^][^\]|\n]*)?(?:\|([^\]\n]*))?\]\]/g
const TAG = /(^|[\s(])(#[\p{L}\p{N}_/-]*[\p{L}_/-][\p{L}\p{N}_/-]*)/gu

/** Where YAML frontmatter ends, if the note starts with some: it shows as properties, not as Markdown. */
function frontmatterEnd(state: EditorState): number {
  if (state.doc.lines < 2 || state.doc.line(1).text !== '---') return -1
  for (let n = 2; n <= Math.min(state.doc.lines, 200); n++) if (/^(---|\.\.\.)\s*$/.test(state.doc.line(n).text)) return state.doc.line(n).to
  return -1
}

function build(view: EditorView): DecorationSet {
  const { state } = view
  const ranges: Range<Decoration>[] = []
  // Unfocused, nothing is being edited: everything shows rendered, wherever the cursor was left.
  const selection = view.hasFocus ? state.selection.ranges : []
  const touches = (from: number, to: number) => selection.some((r) => r.from <= to && r.to >= from)
  const activeLines = new Set(selection.flatMap((r) => {
    const lines: number[] = []
    for (let n = state.doc.lineAt(r.from).number; n <= state.doc.lineAt(r.to).number; n++) lines.push(n)
    return lines
  }))
  const lineActive = (pos: number) => activeLines.has(state.doc.lineAt(pos).number)
  const front = frontmatterEnd(state)
  if (front > 0) for (let n = 1; n <= state.doc.lineAt(front).number; n++) ranges.push(line(n === 1 ? 'cm-lp-front cm-lp-front--first' : 'cm-lp-front').range(state.doc.line(n).from))
  /** A mark hidden unless the cursor is at it; `space` hides the space after it too. */
  const hideMark = (from: number, to: number, reveal: boolean, space = false) => {
    if (reveal) return
    const end = space && state.doc.sliceString(to, to + 1) === ' ' ? to + 1 : to
    if (end > from) ranges.push(hide.range(from, end))
  }
  const inCode = new Set<number>()

  for (const { from, to } of view.visibleRanges) {
    syntaxTree(state).iterate({
      from, to,
      enter(node: SyntaxNodeRef) {
        if (node.from <= front) return
        const name = node.name
        const heading = /^(ATX|Setext)Heading(\d)$/.exec(name)
        if (heading) { ranges.push(line(`cm-lp-h cm-lp-h${heading[2]}`).range(state.doc.lineAt(node.from).from)); return }
        switch (name) {
          case 'HeaderMark': {
            const parent = node.node.parent?.name ?? ''
            if (parent.startsWith('ATX')) hideMark(node.from, node.to, lineActive(node.from), true)
            else hideMark(node.from, node.to, lineActive(node.from)) // a setext underline
            break
          }
          case 'Emphasis': ranges.push(mark('cm-lp-em').range(node.from, node.to)); break
          case 'StrongEmphasis': ranges.push(mark('cm-lp-strong').range(node.from, node.to)); break
          case 'Strikethrough': ranges.push(mark('cm-lp-strike').range(node.from, node.to)); break
          case 'EmphasisMark': case 'StrikethroughMark': {
            const parent = node.node.parent!
            hideMark(node.from, node.to, touches(parent.from, parent.to))
            break
          }
          case 'InlineCode': {
            ranges.push(mark('cm-lp-code').range(node.from, node.to))
            for (let p = node.from; p < node.to; p++) inCode.add(p)
            const reveal = touches(node.from, node.to)
            const inner = node.node
            for (let child = inner.firstChild; child; child = child.nextSibling) if (child.name === 'CodeMark') hideMark(child.from, child.to, reveal)
            return false
          }
          case 'Link': case 'Image': {
            const marks: { from: number; to: number }[] = []
            let url = ''
            for (let child = node.node.firstChild; child; child = child.nextSibling) {
              if (child.name === 'LinkMark') marks.push({ from: child.from, to: child.to })
              if (child.name === 'URL') url = state.doc.sliceString(child.from, child.to)
            }
            if (marks.length < 2 || !url) return false
            const textFrom = marks[0]!.to, textTo = marks[1]!.from
            const reveal = touches(node.from, node.to)
            if (textTo > textFrom) ranges.push(mark(reveal ? 'cm-lp-link cm-lp-raw' : 'cm-lp-link', { 'data-link': url }).range(textFrom, textTo))
            if (!reveal) {
              ranges.push(hide.range(node.from, textFrom))
              ranges.push(hide.range(textTo, node.to))
            }
            return false
          }
          case 'QuoteMark': hideMark(node.from, node.to, lineActive(node.from), true); break
          case 'Blockquote': {
            for (let n = state.doc.lineAt(node.from).number; n <= state.doc.lineAt(node.to).number; n++) ranges.push(line('cm-lp-quote').range(state.doc.line(n).from))
            break
          }
          case 'ListMark': {
            const item = node.node.parent
            const list = item?.parent?.name
            const task = item?.getChild('Task')
            if (task) { hideMark(node.from, node.to, touches(node.from, node.to + 1), true); break }
            if (list === 'BulletList' && !touches(node.from, node.to)) ranges.push(Decoration.replace({ widget: new Bullet() }).range(node.from, node.to))
            break
          }
          case 'TaskMarker': {
            const text = state.doc.sliceString(node.from, node.to)
            if (!touches(node.from, node.to)) ranges.push(Decoration.replace({ widget: new Checkbox(/x/i.test(text), node.from) }).range(node.from, node.to))
            if (/x/i.test(text)) {
              const end = state.doc.lineAt(node.from).to
              if (end > node.to + 1) ranges.push(mark('cm-lp-done').range(node.to + 1, end))
            }
            break
          }
          case 'FencedCode': {
            const first = state.doc.lineAt(node.from).number, last = state.doc.lineAt(node.to).number
            const open = first <= last && [...activeLines].some((n) => n >= first && n <= last)
            for (let n = first; n <= last; n++) {
              const fence = n === first || (n === last && /^\s*(```|~~~)/.test(state.doc.line(n).text))
              ranges.push(line(fence ? `cm-lp-block cm-lp-fence${open ? '' : ' cm-lp-fence--quiet'}` : 'cm-lp-block').range(state.doc.line(n).from))
            }
            for (let p = node.from; p < node.to; p++) inCode.add(p)
            return false
          }
          case 'HorizontalRule': {
            if (!lineActive(node.from)) ranges.push(Decoration.replace({ widget: new Rule() }).range(node.from, node.to))
            break
          }
        }
      },
    })

    // [[wikilinks]], ![[embeds]] and #tags: Obsidian's, not CommonMark's, so found in the text.
    const text = state.doc.sliceString(from, to)
    for (const match of text.matchAll(WIKILINK)) {
      const start = from + match.index!, end = start + match[0].length
      if (start <= front || inCode.has(start)) continue
      const [, bang, target = '', sub, alias] = match
      const shown = alias ?? target
      const reveal = touches(start, end)
      const link = wikilinkHref(target, sub)
      if (reveal) { ranges.push(mark('cm-lp-wikilink cm-lp-raw', { 'data-link': link }).range(start, end)); continue }
      const shownFrom = alias !== undefined ? end - 2 - alias.length : start + bang!.length + 2
      const shownTo = alias !== undefined ? end - 2 : shownFrom + target.length
      ranges.push(hide.range(start, shownFrom))
      if (shownTo > shownFrom && shown) ranges.push(mark(bang ? 'cm-lp-wikilink cm-lp-embed' : 'cm-lp-wikilink', { 'data-link': link }).range(shownFrom, shownTo))
      ranges.push(hide.range(shownTo, end))
    }
    for (const match of text.matchAll(TAG)) {
      const start = from + match.index! + match[1]!.length, end = start + match[2]!.length
      if (start <= front || inCode.has(start)) continue
      const lineText = state.doc.lineAt(start)
      if (start === lineText.from && /^#+\s/.test(lineText.text)) continue
      ranges.push(mark('cm-lp-tag').range(start, end))
    }
  }
  return Decoration.set(ranges, true)
}

/** Live preview for Markdown. Pair it with `markdown({ base: markdownLanguage })` for tasks and strikethrough. */
export function livePreview() {
  return [
    ViewPlugin.fromClass(class {
      decorations: DecorationSet
      constructor(view: EditorView) { this.decorations = build(view) }
      update(update: ViewUpdate) {
        if (update.docChanged || update.viewportChanged || update.selectionSet || update.focusChanged || syntaxTree(update.state) !== syntaxTree(update.startState)) this.decorations = build(update.view)
      }
    }, { decorations: (plugin) => plugin.decorations }),
  ]
}

/**
 * The link under a click in a live preview, if there is one, and whether it's shown as written (the cursor is in it),
 * where a plain click edits and only ⌘-click opens.
 */
export function linkAt(target: EventTarget | null): { href: string; raw: boolean } | undefined {
  const el = (target as HTMLElement | null)?.closest?.('[data-link]')
  const href = el?.getAttribute('data-link')
  return el && href ? { href, raw: el.classList.contains('cm-lp-raw') } : undefined
}
