// HTML in a Markdown file, as GitHub shows it: parsed (rehype-raw), then cut down to what documents use (rehype-sanitize,
// GitHub's own list and a little more). No scripts, no event handlers, no styles. Its images, and Markdown's, are files
// beside the document: resolved against its folder here, read from the thread's machine by whoever shows them.
import type { Options } from 'react-markdown'
import rehypeRaw from 'rehype-raw'
import rehypeSanitize, { defaultSchema, type Options as Schema } from 'rehype-sanitize'

const attributes = defaultSchema.attributes ?? {}
export const schema: Schema = {
  ...defaultSchema,
  tagNames: [...(defaultSchema.tagNames ?? []), 'mark', 'figure', 'figcaption', 'caption', 'small', 'u', 'abbr', 'cite', 'dfn'],
  attributes: {
    ...attributes,
    img: [...(attributes.img ?? []), 'srcSet', 'loading'],
    source: [...(attributes.source ?? []), 'type'],
  },
  protocols: {
    ...defaultSchema.protocols,
    // A message's own links: to files ([[wikilinks]]) and threads.
    href: [...(defaultSchema.protocols?.href ?? []), 'superego-file', 'thread'],
  },
}

/** After remark: HTML parsed, then sanitized. */
export const htmlPlugins: NonNullable<Options['rehypePlugins']> = [rehypeRaw, [rehypeSanitize, schema]]

/** `name` from the folder `dir` (`a/b/`, or '' at the top), as a path in the thread's folder; undefined if outside it. */
export function resolve(dir: string, name: string) {
  if (/^([/~]|[a-z][\w+.-]*:)/i.test(name)) return undefined
  const parts: string[] = []
  for (const part of `${dir}${name}`.split('/')) {
    if (part === '..') { if (!parts.pop()) return undefined }
    else if (part !== '.' && part !== '') parts.push(part)
  }
  return parts.join('/')
}

/** The folder `path` is in, as `resolve` takes it: `a/b/` for `a/b/c.md`, '' at the top. */
export const folderOf = (path: string) => path.includes('/') ? path.slice(0, path.lastIndexOf('/') + 1) : ''

/** An image's address as a file beside the document (`src`, query and fragment dropped, %-escapes undone), if it is one. */
export function imagePath(dir: string, src: string) {
  const bare = src.split(/[?#]/)[0]!
  if (!bare) return undefined
  let name: string
  try { name = decodeURI(bare) } catch { name = bare }
  return resolve(dir, name)
}

/** A srcset's candidates: each URL with its descriptor (`2x`, `640w`), if it has one. */
export function parseSrcset(srcset: string) {
  return srcset.trim().split(/\s*,\s*/).filter(Boolean)
    .map((part) => { const [url, ...rest] = part.split(/\s+/); return { url: url!, descriptor: rest.join(' ') } })
}

/**
 * Whether a `<source>`'s media query holds, with `prefers-color-scheme` answered by the app's theme (`dark`) rather
 * than the system's. Everything else is the window's own to answer (`match`).
 */
export function mediaMatches(media: string | undefined, dark: boolean, match: (query: string) => boolean) {
  if (!media?.trim()) return true
  const scheme = /\(\s*prefers-color-scheme\s*:\s*(light|dark)\s*\)/gi
  const exact = /^\s*\(\s*prefers-color-scheme\s*:\s*(light|dark)\s*\)\s*$/i.exec(media)
  if (exact) return (exact[1]!.toLowerCase() === 'dark') === dark
  // In a longer query: one that always holds, or never does.
  return match(media.replace(scheme, (_all, which: string) => (which.toLowerCase() === 'dark') === dark ? '(min-width: 0px)' : '(max-width: -1px)'))
}

/** MIME types for the images a document shows; an SVG's must be said, or it won't show from a blob. */
const TYPES: Record<string, string> = {
  svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  avif: 'image/avif', ico: 'image/x-icon', bmp: 'image/bmp',
}
export const imageType = (path: string) => TYPES[path.split('.').at(-1)?.toLowerCase() ?? ''] ?? ''
