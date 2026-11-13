// Code, coloured the same wherever it shows: in the editor (CodeMirror), and in a message's or a rendered file's fenced
// blocks, highlighted with the editor's own languages (loaded when a block first names one) and colours.
import { HighlightStyle, LanguageDescription } from '@codemirror/language'
import { languages } from '@codemirror/language-data'
import { highlightTree, tags } from '@lezer/highlight'
import { StyleModule } from 'style-mod'

/**
 * Quiet: a few hues on the page's own colours, in light and dark. What it doesn't name stays the text's colour.
 * Headings and emphasis are left to the markdown styles.
 */
const c = (light: string, dark: string) => `light-dark(${light}, ${dark})`
export const codeHighlight = HighlightStyle.define([
  { tag: [tags.keyword, tags.operatorKeyword, tags.modifier, tags.controlKeyword, tags.definitionKeyword, tags.moduleKeyword], color: c('#a626a4', '#c792ea') },
  { tag: [tags.string, tags.special(tags.string), tags.regexp, tags.character], color: c('#50a14f', '#a5d68a') },
  { tag: [tags.number, tags.bool, tags.null, tags.atom, tags.unit], color: c('#b76b01', '#f2b46d') },
  { tag: [tags.comment, tags.lineComment, tags.blockComment, tags.docComment], color: 'var(--superego-faint)', fontStyle: 'italic' },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName), tags.function(tags.definition(tags.variableName))], color: c('#2f6fdb', '#82aaff') },
  { tag: [tags.typeName, tags.className, tags.namespace, tags.standard(tags.typeName)], color: c('#c18401', '#ffcb6b') },
  { tag: [tags.tagName, tags.angleBracket], color: c('#e45649', '#f07178') },
  { tag: [tags.attributeName, tags.propertyName, tags.labelName], color: c('#986801', '#e0c08a') },
  { tag: [tags.definition(tags.variableName), tags.definition(tags.propertyName)], color: c('#0f6e8a', '#89ddff') },
  { tag: [tags.meta, tags.processingInstruction, tags.documentMeta, tags.annotation], color: 'var(--superego-muted)' },
  { tag: tags.inserted, color: c('#2f7d32', '#a5d68a') },
  { tag: tags.deleted, color: c('#c0392b', '#f07178') },
  { tag: [tags.invalid], color: 'var(--superego-status-error)' },
  { tag: tags.link, textDecoration: 'underline' },
])

/** A piece of a line, with the classes that colour it ('' for plain text). */
export type Piece = { text: string; classes: string }

/** The language a fence names (`ts`, `bash`, `diff`, …), if the editor knows it. */
export const languageNamed = (name: string) => LanguageDescription.matchLanguageName(languages, name, true) ?? undefined

let mounted = false
/** The colours' styles, in the page once: the editor mounts them itself, a message may come first. */
function mount() {
  if (mounted || typeof document === 'undefined' || !codeHighlight.module) return
  StyleModule.mount(document, codeHighlight.module)
  mounted = true
}

/** `code` in a loaded language, line by line; undefined until the language is loaded (`load` loads it). */
export function highlight(code: string, language: LanguageDescription): Piece[][] | undefined {
  if (!language.support) return undefined
  mount()
  const tree = language.support.language.parser.parse(code)
  const lines: Piece[][] = [[]]
  const add = (from: number, to: number, classes: string) => {
    const parts = code.slice(from, to).split('\n')
    parts.forEach((text, i) => {
      if (i > 0) lines.push([])
      if (text) lines.at(-1)!.push({ text, classes })
    })
  }
  let at = 0
  highlightTree(tree, codeHighlight, (from, to, classes) => {
    if (from > at) add(at, from, '')
    add(from, to, classes)
    at = to
  })
  if (at < code.length) add(at, code.length, '')
  return lines
}
