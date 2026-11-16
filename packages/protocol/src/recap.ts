// A thread's status in a line: what a run did (a `done` status's recap), the question it waits on, why it failed. Plain
// text, short enough for a notification, cut at a word. The daemon makes a done status's recap with these; a client
// shortens a question or an error the same way.

/** How long a recap, a question or an error runs before it's cut (with an ellipsis). */
const RECAP_LENGTH = 100

/** Markdown as the plain text it reads as: no code blocks, emphasis, heading or list marks, links as their text. */
export function plainText(markdown: string): string {
  return markdown
    .replace(/^ {0,3}(```|~~~)[^\n]*\n[\s\S]*?(?:\n {0,3}\1[^\n]*|$)/gm, '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\[[^\]]*\]/g, '$1')
    .replace(/<((?:https?|mailto):[^>\s]+)>/g, '$1')
    .replace(/<\/?[a-zA-Z][^>]*>/g, '')
    .replace(/`+([^`\n]+?)`+/g, '$1')
    .replace(/(\*\*|__)(?=\S)([^\n]*?\S)\1/g, '$2')
    .replace(/(^|[^\w*])\*(?=\S)([^*\n]*?\S)\*(?!\w)/g, '$1$2')
    .replace(/(^|[^\w_])_(?=\S)([^_\n]*?\S)_(?!\w)/g, '$1$2')
    .replace(/~~(?=\S)([^\n]*?\S)~~/g, '$1')
    .replace(/^ {0,3}#{1,6}[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/gm, '$1')
    .replace(/^ {0,3}(?:>[ \t]?)+/gm, '')
    .replace(/^[ \t]*(?:[-*+]|\d+[.)])[ \t]+(?:\[[ xX]\][ \t]+)?/gm, '')
    .replace(/^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/gm, '')
}

/** Text on one line, at most `max` characters: cut at a word, with an ellipsis, when it's longer. */
export function shorten(text: string, max = RECAP_LENGTH): string {
  const line = text.replace(/\s+/g, ' ').trim()
  if (line.length <= max) return line
  const cut = line.slice(0, max)
  const space = cut.lastIndexOf(' ')
  // One long word (a path, say) is cut where it reaches the limit.
  const words = space > max / 2 ? cut.slice(0, space) : cut.slice(0, max - 1)
  return `${words.replace(/[\s,;:.–—-]+$/, '')}…`
}

/** Markdown's paragraphs (and list items, and headings), as plain text, in order; code blocks left out. */
function blocks(markdown: string): { text: string; heading: boolean }[] {
  const found: { text: string; heading: boolean }[] = []
  const withoutCode = markdown.replace(/^ {0,3}(```|~~~)[^\n]*\n[\s\S]*?(?:\n {0,3}\1[^\n]*|$)/gm, '\n')
  for (const block of withoutCode.split(/\n\s*\n/)) {
    // A list's items, and a heading over a paragraph, each stand alone.
    let current: string[] = []
    const flush = (heading = false) => {
      const text = plainText(current.join('\n')).replace(/\s+/g, ' ').trim()
      if (text) found.push({ text, heading })
      current = []
    }
    for (const line of block.split('\n')) {
      if (/^ {0,3}#{1,6}\s/.test(line)) { flush(); current.push(line); flush(true); continue }
      if (/^\s*(?:[-*+]|\d+[.)])\s/.test(line)) flush()
      current.push(line)
    }
    flush()
  }
  return found
}

/** The first sentence of an answer, as plain text, shortened: past a heading, when there's anything past it. */
export function firstSentence(markdown: string, max = RECAP_LENGTH): string | undefined {
  const all = blocks(markdown)
  const first = all.find((b) => !b.heading) ?? all[0]
  if (!first) return undefined
  const sentence = /^.+?[.!?…](?=\s|$)/.exec(first.text)?.[0] ?? first.text
  return shorten(sentence, max) || undefined
}

/** The last paragraph of a question, as plain text, shortened: the question itself, after any context. */
export function lastParagraph(markdown: string, max = RECAP_LENGTH): string | undefined {
  const last = blocks(markdown).at(-1)
  return last ? shorten(last.text, max) || undefined : undefined
}

/** The first line of an error, shortened. */
export function firstLine(text: string, max = RECAP_LENGTH): string | undefined {
  const line = text.split('\n').find((l) => l.trim())
  return line ? shorten(line, max) : undefined
}
