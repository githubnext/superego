// Code, coloured the same wherever it shows: in the editor (CodeMirror), and in a message's or a rendered file's fenced
// blocks, highlighted with the editor's own languages (loaded when a block first names one) and colours.
import { HighlightStyle, LanguageDescription } from '@codemirror/language'
import { languages } from '@codemirror/language-data'
import { highlightTree, tags } from '@lezer/highlight'
import { StyleModule } from 'style-mod'

/**
 * Quiet: a few hues on the page's own colours, in light and dark (the --superego-syntax-* tokens in @superego/ui's
 * styles). What it doesn't name stays the text's colour. Headings and emphasis are left to the markdown styles.
 */
const syntax = (role: string) => `var(--superego-syntax-${role})`
export const codeHighlight = HighlightStyle.define([
  { tag: [tags.keyword, tags.operatorKeyword, tags.modifier, tags.controlKeyword, tags.definitionKeyword, tags.moduleKeyword], color: syntax('keyword') },
  { tag: [tags.string, tags.special(tags.string), tags.regexp, tags.character], color: syntax('string') },
  { tag: [tags.number, tags.bool, tags.null, tags.atom, tags.unit], color: syntax('number') },
  { tag: [tags.comment, tags.lineComment, tags.blockComment, tags.docComment], color: syntax('comment'), fontStyle: 'italic' },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName), tags.function(tags.definition(tags.variableName))], color: syntax('function') },
  { tag: [tags.typeName, tags.className, tags.namespace, tags.standard(tags.typeName)], color: syntax('type') },
  { tag: [tags.tagName, tags.angleBracket], color: syntax('tag') },
  { tag: [tags.attributeName, tags.propertyName, tags.labelName], color: syntax('attribute') },
  { tag: [tags.definition(tags.variableName), tags.definition(tags.propertyName)], color: syntax('definition') },
  { tag: [tags.meta, tags.processingInstruction, tags.documentMeta, tags.annotation], color: syntax('meta') },
  { tag: tags.inserted, color: syntax('inserted') },
  { tag: tags.deleted, color: syntax('deleted') },
  { tag: [tags.invalid], color: syntax('invalid') },
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
