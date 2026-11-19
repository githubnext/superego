// What both halves agree on: what mentions is, how a mention is written in a message (`@thread:<id>`, `@thread:<machine>/<id>`,
// `@path/to/file`, `@"a path with spaces"`), and the block the daemon half sends with a message that has some, which the
// UI half finds again to draw the mentions as links.
import type { ExtensionAbout } from '@superego/protocol'

export const about = {
  name: 'mentions', version: '1.0.0', api: '^5', title: 'Mentions',
  description: '@ in the composer names another thread or a file, and the agent is told what it is.',
} satisfies ExtensionAbout

/** A mention as written: `ref` is its text (`@thread:42`), what it names after it. */
export type Mention =
  | { ref: string; kind: 'thread'; id: string; machine?: string }
  | { ref: string; kind: 'file'; path: string }

/** A mention at the start of a word: a thread, a quoted path, or a path running to the next space or bracket. */
const MENTION = /(?<![^\s([{"'`])@(?:thread:(?:([\w.-]+)\/)?([\w-]+)|"([^"\n]+)"|([^\s"'`()[\]{}<>,;]+))/g

/** `text` cut into prose and code (`inline`, fenced), code at the odd places: a mention in code is only code. */
const parts = (text: string) => text.split(/(```[\s\S]*?```|`[^`\n]*`)/)

/** Each mention in `match`, or none: a path's last full stop or colon ends the sentence, not the path. */
function mentionOf(match: RegExpExecArray): Mention | undefined {
  const [all, machine, id, quoted, bare] = match
  if (id) return { ref: all, kind: 'thread', id, ...(machine ? { machine } : {}) }
  if (quoted) return { ref: all, kind: 'file', path: quoted }
  const path = bare!.replace(/[.:!?]+$/, '')
  return path ? { ref: `@${path}`, kind: 'file', path } : undefined
}

/** The mentions in a message, each once, in the order it makes them; none in code. */
export function mentionsIn(text: string): Mention[] {
  const found = new Map<string, Mention>()
  parts(text).forEach((part, index) => {
    if (index % 2) return
    for (const match of part.matchAll(MENTION)) {
      const mention = mentionOf(match)
      if (mention && !found.has(mention.ref)) found.set(mention.ref, mention)
    }
  })
  return [...found.values()]
}

/** `text` with each mention in `refs` replaced by what `swap` makes of it, outside code. */
export function replaceMentions(text: string, refs: ReadonlySet<string>, swap: (mention: Mention) => string): string {
  return parts(text).map((part, index) => {
    if (index % 2) return part
    let out = ''
    let from = 0
    for (const match of part.matchAll(MENTION)) {
      const mention = mentionOf(match)
      if (!mention || !refs.has(mention.ref)) continue
      out += part.slice(from, match.index) + swap(mention)
      from = match.index + mention.ref.length
    }
    return out + part.slice(from)
  }).join('')
}

/** How a path is written in a mention: bare, or quoted when it has a space or a character that would end it. */
export const fileRef = (path: string) => /[\s"'`()[\]{}<>,;]/.test(path) || /[.:!?]$/.test(path) ? `@"${path}"` : `@${path}`

/** How a thread is written in a mention: by id, and by its machine's name when that isn't the machine the message goes to. */
export const threadRef = (id: string, machine?: string) => `@thread:${machine ? `${machine}/` : ''}${id}`

/** The block sent with a message that mentions something: opens with this line. */
const OPEN = '<mentions>'
const CLOSE = '</mentions>'
/** A line of it: the mention as written, then what it is. */
const LINE = /^(@thread:\S+|@"[^"\n]+"|@\S+) is an? (thread|file|folder)\b/

/** The block for a message's mentions, a line each (`line`: what it is, after the mention). */
export const mentionsBlock = (lines: string[]) => [
  OPEN,
  'The message mentions these. They aren\'t attached: read what you need.',
  ...lines,
  CLOSE,
].join('\n')

/** A sent message's mentions as its block says them (the mention as written, and what it is), and which block that was. */
export function sentMentions(blocks: readonly { type: string; text?: string }[]): { items: SentMention[]; blocks: number[] } | undefined {
  const index = blocks.findIndex((block) => block.type === 'text' && block.text?.startsWith(`${OPEN}\n`))
  if (index < 0) return undefined
  const items = blocks[index]!.text!.split('\n').flatMap((line): SentMention[] => {
    const match = LINE.exec(line)
    return match ? [{ ref: match[1]!, kind: match[2] as SentMention['kind'] }] : []
  })
  return { items, blocks: [index] }
}
export type SentMention = { ref: string; kind: 'thread' | 'file' | 'folder' }

/** Markdown's own characters in a link's text, escaped. */
const escape = (text: string) => text.replace(/[\\[\]*_`]/g, '\\$&')

/**
 * A sent message's words with the mentions its block names as links: a thread as a `thread:` link (drawn as the thread,
 * by its title), a file or folder as a link to it, relative to the thread's folder.
 */
export function mentionLinks(text: string, items: readonly SentMention[]): string {
  return replaceMentions(text, new Set(items.map((item) => item.ref)), (mention) => mention.kind === 'thread'
    ? `[${escape(mention.ref)}](thread:${mention.machine ? `${mention.machine}/` : ''}${mention.id})`
    : `[${escape(mention.ref)}](<${mention.path.replace(/[<>]/g, encodeURIComponent)}>)`)
}
