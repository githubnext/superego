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
    // Images inline and in files of the thread's, as Markdown's own may be.
    src: [...(defaultSchema.protocols?.src ?? []), 'data', 'blob', 'file'],
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

/** Extensions a file named alone (no folder) is taken for one by: not `settings.get` or `x.y`, which are code. */
const EXTENSIONS = new Set(('md markdown mdx txt rst adoc org ts tsx mts cts js jsx mjs cjs json jsonc json5 yaml yml toml ini conf cfg env '
  + 'lock log csv tsv xml html htm css scss sass less svg png jpg jpeg gif webp avif ico pdf py rb rs go swift java kt kts scala c h cc '
  + 'cpp hpp m mm cs fs ex exs erl lua php pl sh bash zsh fish ps1 sql graphql proto vue svelte astro mmd dot tex gradle plist patch diff '
  + 'zig nix dart r jl hs ml clj elm sol wasm wat tf hcl dockerfile gitignore').split(' '))

/**
 * Inline code that is a file or folder, by its look: one token (no spaces, so not a command that names one), no
 * scheme, and a folder in it (`src/app.ts`, `docs/guides/`) or a known file extension (`README.md`, `plan.md:12`).
 * Dotted code (`settings.get`) isn't one.
 */
export function looksLikePath(text: string) {
  if (/^[a-z][\w+.-]*:(?!\d)/i.test(text)) return false
  if (/[\s`]/.test(text)) return false
  if (/^[\w.@~/-][^/]*\/./.test(text)) return true
  const name = /^[\w@~-][^/]*\.([A-Za-z]\w{0,9})(?::\d+)*$/.exec(text)
  return Boolean(name && EXTENSIONS.has(name[1]!.toLowerCase()))
}

/** The folder `path` is in, as `resolve` takes it: `a/b/` for `a/b/c.md`, '' at the top. */
export const folderOf = (path: string) => path.includes('/') ? path.slice(0, path.lastIndexOf('/') + 1) : ''

/** Where an image in a message or a rendered file comes from: a web (or data, blob) address, a file of the thread's, or neither, and why. */
export type ImageSource = { url: string } | { path: string } | { refused: string }

export const OUTSIDE = "outside the thread's folder"

/**
 * `src` as an image of the thread in `cwd` on its machine, written in a document in `dir` there (`a/b/`, or '' for a
 * message): a web, data or blob address as it is; a path (relative to `dir`, absolute, `~/…` or file://) as one in the
 * thread's folder, relative to it, or among the files the thread keeps (`attachments/<thread>/`, absolute). Anything
 * else is refused: `file.read` wouldn't read it, so it isn't asked to.
 */
export function imageSource(src: string, { cwd, dir = '', thread }: { cwd: string; dir?: string; thread?: string }): ImageSource {
  const given = src.trim()
  if (/^(https?|data|blob):/i.test(given)) return { url: given }
  let name: string
  if (/^file:/i.test(given)) {
    const url = URL.parse(given)
    if (!url || (url.host && url.host !== 'localhost')) return { refused: 'not a file on the thread’s machine' }
    name = url.pathname
  } else if (/^[a-z][\w+.-]*:/i.test(given)) return { refused: 'not a file or a web address' }
  else name = given.split(/[?#]/)[0]!
  try { name = decodeURI(name) } catch {}
  if (!name) return { refused: 'no address' }
  const folder = normalize(cwd)
  if (/^~(\/|$)/.test(name)) {
    // The machine's home, as far as the thread's folder tells it; one not under a home is not under this one either.
    const home = /^(\/Users\/[^/]+|\/home\/[^/]+|\/root)(?=\/|$)/.exec(folder)?.[1]
    if (!home) return { refused: OUTSIDE }
    name = `${home}${name.slice(1)}`
  }
  if (!name.startsWith('/')) {
    const path = resolve(dir, name)
    return path === undefined ? { refused: OUTSIDE } : { path }
  }
  const path = normalize(name)
  if (path.startsWith(`${folder}/`)) return { path: path.slice(folder.length + 1) }
  if (thread && path.includes(`/attachments/${thread}/`)) return { path }
  return { refused: OUTSIDE }
}

/** An absolute path with its `.`, `..` and doubled slashes gone (none above the root). */
function normalize(path: string) {
  const parts: string[] = []
  for (const part of path.split('/')) {
    if (part === '..') parts.pop()
    else if (part !== '.' && part !== '') parts.push(part)
  }
  return `/${parts.join('/')}`
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
