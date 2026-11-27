// What both halves agree on: what mentions is, how a mention is written in a message (`@thread:<id>`, `@thread:<machine>/<id>`,
// `@path/to/file`, `@"a path with spaces"`, and an extension's things: `@<kind>:<id>`, `@<kind>:"<id with spaces>"`), and
// the block the daemon half sends with a message that has some, which the UI half finds again to draw the mentions as
// links.
import { mentionHref, type ExtensionAbout } from '@superego/protocol'

export const about = {
  name: 'mentions', version: '1.1.0', api: '^5.16', title: 'Mentions', group: 'thread',
  description: '@ in the composer names another thread, a file, or something an extension names, and the agent is told what it is.',
} satisfies ExtensionAbout

/**
 * A mention as written: `ref` is its text (`@thread:42`), what it names after it. An extension's (`kind: 'other'`) is
 * of its `type` (`canvas`); a bare one (`@a:b`) may be a path with a colon in it all the same, where no extension
 * resolves its type.
 */
export type Mention =
  | { ref: string; kind: 'thread'; id: string; machine?: string }
  | { ref: string; kind: 'file'; path: string }
  | { ref: string; kind: 'other'; type: string; id: string; quoted: boolean }

/**
 * A mention at the start of a word: a thread, an extension's thing with its id quoted, a quoted path, or a word running
 * to the next space or bracket (a path, or an extension's thing: `@<kind>:<id>`).
 */
const MENTION = /(?<![^\s([{"'`])@(?:thread:(?:([\w.-]+)\/)?([\w-]+)|([a-z][a-z0-9-]*):"([^"\n]+)"|"([^"\n]+)"|([^\s"'`()[\]{}<>,;]+))/g

/** What an extension's kind of thing looks like, before its id. */
const KIND = /^([a-z][a-z0-9-]*):(.+)$/

/** `text` cut into prose and code (`inline`, fenced), code at the odd places: a mention in code is only code. */
const parts = (text: string) => text.split(/(```[\s\S]*?```|`[^`\n]*`)/)

/**
 * Each mention in `match`, or none: a word's last full stop or colon ends the sentence, not the mention. The Mentions
 * extension's own kinds aren't written `@<kind>:"…"`.
 */
function mentionOf(match: RegExpExecArray): Mention | undefined {
  const [all, machine, id, type, quotedId, quoted, bare] = match
  if (id) return { ref: all, kind: 'thread', id, ...(machine ? { machine } : {}) }
  if (type) return type === 'thread' || type === 'file' || type === 'folder' ? undefined : { ref: all, kind: 'other', type, id: quotedId!, quoted: true }
  if (quoted) return { ref: all, kind: 'file', path: quoted }
  const word = bare!.replace(/[.:!?]+$/, '')
  if (!word) return undefined
  const named = KIND.exec(word)
  if (named && named[1] !== 'thread' && named[1] !== 'file' && named[1] !== 'folder') return { ref: `@${word}`, kind: 'other', type: named[1]!, id: named[2]!, quoted: false }
  return { ref: `@${word}`, kind: 'file', path: word }
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
/** A line of it: the mention as written, then what it is: a thread, a file, a folder, or an extension's kind of thing. */
const LINE = /^(@thread:\S+|@[a-z][a-z0-9-]*:"[^"\n]+"|@"[^"\n]+"|@\S+) is an? ([a-z][a-z0-9-]*)\b/

/** A line of the block for an extension's thing: what its resolver said of it, kept to a line. */
export const otherLine = (ref: string, type: string, said: string) =>
  `${ref} is ${/^[aeiou]/.test(type) ? 'an' : 'a'} ${type}: ${said.trim().replace(/\s*\n\s*/g, ' ')}`

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
    return match ? [{ ref: match[1]!, kind: match[2]! }] : []
  })
  return { items, blocks: [index] }
}
/** A mention the block said what it was: `thread`, `file`, `folder`, or an extension's kind (`canvas`). */
export type SentMention = { ref: string; kind: string }

/** Markdown's own characters in a link's text, escaped. */
const escape = (text: string) => text.replace(/[\\[\]*_`]/g, '\\$&')

/** A link's destination as Markdown takes it whole: in brackets, its own brackets escaped. */
const destination = (href: string) => `<${href.replace(/[<>]/g, encodeURIComponent)}>`

/**
 * A sent message's words with the mentions its block names as links: a thread as a `thread:` link (drawn as the thread,
 * by its title), a file or folder as a link to it, relative to the thread's folder, and an extension's thing as `href`
 * says (default `<kind>:<id>`, `mentionHref`; none: left as written).
 */
export function mentionLinks(text: string, items: readonly SentMention[], href: (kind: string, id: string) => string | undefined = mentionHref): string {
  const kinds = new Map(items.map((item) => [item.ref, item.kind]))
  return replaceMentions(text, new Set(kinds.keys()), (mention) => {
    const kind = kinds.get(mention.ref)!
    const link = (to: string) => `[${escape(mention.ref)}](${to})`
    if (mention.kind === 'thread') return link(`thread:${mention.machine ? `${mention.machine}/` : ''}${mention.id}`)
    // A path with a colon in it (`@a:b`) is a file all the same, where the block says so.
    if (kind === 'file' || kind === 'folder') return mention.kind === 'file' ? link(destination(mention.path)) : mention.quoted ? mention.ref : link(destination(mention.ref.slice(1)))
    if (mention.kind !== 'other' || mention.type !== kind) return mention.ref
    const to = href(kind, mention.id)
    return to ? link(destination(to)) : mention.ref
  })
}
