// Code blocks, coloured at build time with the app's own parsers (Lezer) and the app's palette
// (packages/app/src/renderer/code-highlight.ts): spans with classes, coloured by style.css. Shell gets a small
// tokenizer of its own: comments, strings, and the command at a line's start.
import { parser as js } from '@lezer/javascript'
import { parser as json } from '@lezer/json'
import { highlightTree, tagHighlighter, tags as t } from '@lezer/highlight'
import type { Parser } from '@lezer/common'

const highlighter = tagHighlighter([
  { tag: [t.keyword, t.operatorKeyword, t.modifier, t.controlKeyword, t.definitionKeyword, t.moduleKeyword], class: 'k' },
  { tag: [t.string, t.special(t.string), t.regexp, t.character], class: 's' },
  { tag: [t.number, t.bool, t.null, t.atom, t.unit], class: 'n' },
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], class: 'c' },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.function(t.definition(t.variableName))], class: 'f' },
  { tag: [t.typeName, t.className, t.namespace, t.standard(t.typeName)], class: 't' },
  { tag: [t.tagName, t.angleBracket], class: 'g' },
  { tag: [t.attributeName, t.propertyName, t.labelName], class: 'p' },
  { tag: [t.definition(t.variableName), t.definition(t.propertyName)], class: 'd' },
])

const parsers: Record<string, () => Parser> = {
  ts: () => js.configure({ dialect: 'ts' }),
  tsx: () => js.configure({ dialect: 'ts jsx' }),
  js: () => js,
  jsx: () => js.configure({ dialect: 'jsx' }),
  json: () => json,
  jsonc: () => json,
}

const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const span = (text: string, cls: string) => (cls ? `<span class="${cls}">${escape(text)}</span>` : escape(text))

/** `code` as HTML, coloured if `lang` is one it knows; escaped as it is otherwise. */
export function highlight(code: string, lang: string): string {
  if (lang === 'sh' || lang === 'bash' || lang === 'shell') return shell(code)
  const parser = parsers[lang]?.()
  if (!parser) return escape(code)
  let html = ''
  let at = 0
  highlightTree(parser.parse(code), highlighter, (from, to, cls) => {
    if (from > at) html += escape(code.slice(at, from))
    html += span(code.slice(from, to), cls)
    at = to
  })
  return html + escape(code.slice(at))
}

function shell(code: string): string {
  return code
    .split('\n')
    .map((line) => {
      let html = ''
      let command = true
      // A word, a quoted string, a comment (# after a space or at the start), or anything else one character at a time.
      for (const { 0: token, groups } of line.matchAll(/(?<comment>(?<=^|\s)#.*)|"(?:\\.|[^"\\])*"|'[^']*'|[^\s"'#]+|\s+|./g)) {
        if (groups?.comment) {
          html += span(token, 'c')
        } else if (token.startsWith('"') || token.startsWith("'")) {
          html += span(token, 's')
        } else if (/^\s+$/.test(token)) {
          html += token
        } else if (command) {
          html += span(token, 'f')
          command = false
        } else {
          html += escape(token)
          if (/^(&&|\|\||\||;)$/.test(token)) command = true
        }
      }
      return html
    })
    .join('\n')
}
