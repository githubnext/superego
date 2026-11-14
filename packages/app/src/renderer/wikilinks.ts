// [[wikilinks]] as links: `[[Note#Heading|alias]]` is a link that says "alias" to `wikilink:Note#Heading` (the note
// and the heading each URI-encoded), so a link handler claims it as it would any other scheme. Messages, rendered
// files and the editor's live preview all make them here, the same way.

export const WIKILINK = 'wikilink:'

/** A wikilink taken apart: the note it names, as written, and the heading or block (`^id`) in it, if any. */
export type Wikilink = { target: string; heading?: string; block?: string }

/** The href of `[[target#sub]]`: `sub` is what follows the target (`#Heading`, `#^block`, `^block`), if anything. */
export function wikilinkHref(target: string, sub?: string) {
  const part = sub?.replace(/^#/, '').trim()
  return `${WIKILINK}${encodeURIComponent(target.trim())}${part ? `#${encodeURIComponent(part)}` : ''}`
}

/** A `wikilink:` href taken apart; not one, undefined. */
export function parseWikilink(href: string): Wikilink | undefined {
  if (!href.toLowerCase().startsWith(WIKILINK)) return undefined
  const [target = '', part] = href.slice(WIKILINK.length).split('#', 2) as [string, string | undefined]
  const decode = (s: string) => { try { return decodeURIComponent(s) } catch { return s } }
  const sub = part ? decode(part) : ''
  return { target: decode(target), ...sub.startsWith('^') ? { block: sub.slice(1) } : sub ? { heading: sub } : {} }
}

/** [[target#heading|alias]] and ![[embeds]] as `wikilink:` links, outside code. */
export function wikilinks(text: string) {
  return text.split(/(```[\s\S]*?```|`[^`\n]*`)/).map((part, i) => i % 2 ? part : part.replace(/!?\[\[([^\]|#^\n]+)([#^][^\]|\n]*)?(?:\|([^\]\n]*))?\]\]/g,
    (_all, target: string, sub?: string, alias?: string) => `[${(alias ?? target).trim().replace(/[[\]]/g, '')}](<${wikilinkHref(target, sub)}>)`)).join('')
}
