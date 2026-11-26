// Mentions of things extensions name, as both halves write them: `@<kind>:<id>` (`@canvas:fox-and-rhino`), or with the
// id quoted where it has a space or a character that would end it (`@note:"Q4 plan"`). The UI half offers them as `@`
// is typed (`superego.composer.mention`), the daemon half says what each one sent names (`superego.mention`), and the
// sent message draws it as a link (`mentionHref`). The Mentions extension reads and writes them; `thread`, `file` and
// `folder` are its own kinds.

/** A kind of mention: lowercase letters, digits and dashes, starting with a letter (`canvas`, `note`). */
export const MENTION_KIND = /^[a-z][a-z0-9-]*$/

/** The kinds the Mentions extension names itself: no extension registers these. */
export const BUILT_IN_MENTIONS: readonly string[] = ['thread', 'file', 'folder']

/** Why `kind` can't be a kind of mention, if it can't. */
export function mentionKindProblem(kind: string): string | undefined {
  if (typeof kind !== 'string' || !MENTION_KIND.test(kind)) return `mention kind ${JSON.stringify(kind)} must be lowercase letters, digits and dashes, starting with a letter`
  if (BUILT_IN_MENTIONS.includes(kind)) return `mention kind ${kind} is the Mentions extension's own`
  return undefined
}

/** Whether an id can be written in a mention at all: not empty, and with no quote or line break in it. */
export const mentionable = (id: string) => typeof id === 'string' && id.length > 0 && !/["\n\r]/.test(id)

/**
 * How a mention of `id` (of `kind`) is written: `@<kind>:<id>`, or `@<kind>:"<id>"` when the id has a space, a
 * bracket, quote or comma, or ends in a full stop, colon, `!` or `?` (which a sentence would take as its own). Throws
 * for an id no mention can hold (empty, or with a `"` or a line break).
 */
export function mentionRef(kind: string, id: string): string {
  if (!mentionable(id)) throw new Error(`A mention can't name ${JSON.stringify(id)}: an id needs a character, and no quote or line break`)
  return /[\s"'`()[\]{}<>,;]/.test(id) || /[.:!?]$/.test(id) ? `@${kind}:"${id}"` : `@${kind}:${id}`
}

/**
 * Where a sent mention of `id` (of `kind`) links to, unless its source says otherwise: `<kind>:<id>`, the id
 * URI-encoded (`canvas:Fox%20%26%20Rhino`). A space whose `match` is `'<kind>:'` opens it; read the id back with
 * `decodeURIComponent(href.slice('<kind>:'.length))`.
 */
export const mentionHref = (kind: string, id: string) => `${kind}:${encodeURIComponent(id)}`
