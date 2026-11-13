// Links in Markdown, claimed by handlers (`superego.link`): what a link of a kind looks like and what following it does.
// The core claims the files a thread names (`[[wikilinks]]`, relative links, code that reads as a path) and web pages;
// the threads extension claims threads (`thread:<id>`); an extension or a profile can claim others, or these its own
// way, ahead of the core.
// A thread's transcript keeps the links it draws, in order, for ⌃O's list (`transcriptLinks`).
import { createContext, useContext, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { SquareSplitHorizontalIcon } from '@superego/ui'
import type { LinkAttributes, LinkHandler, LinkProps, LinkWhere, UiApi } from './extension.tsx'
import { looksLikePath } from './markdown-html.ts'

/** A link drawn in a transcript: what it says, where it goes, and a way to follow it. */
export type TranscriptLink = { text: string; href: string; target: string; open(beside: boolean): Promise<string | undefined> }
type Kept = TranscriptLink & { element: Element }

/** Where Markdown is drawn, for its links; `collect` keeps them for a thread's transcript. */
export type LinkPlaceValue = LinkWhere & { collect?: (link: Kept) => () => void }
export const LinkPlace = createContext<LinkPlaceValue>({})

/** By thread: one window draws one transcript (Shell's ThreadView), so a thread's links are one view's. */
const kept = new Map<string, Set<Kept>>()

/** Keeps the links drawn in a thread's transcript, for `transcriptLinks`. */
export function collector(machine: string, thread: string) {
  const key = `${machine}/${thread}`
  return (link: Kept) => {
    const set = kept.get(key) ?? kept.set(key, new Set()).get(key)!
    set.add(link)
    return () => { set.delete(link); if (!set.size) kept.delete(key) }
  }
}

/** The links a thread's transcript shows now, in its order (oldest first). */
export function transcriptLinks(machine: string, thread: string): TranscriptLink[] {
  const order = [...kept.get(`${machine}/${thread}`) ?? []].filter((link) => link.element.isConnected)
  order.sort((a, b) => a.element.compareDocumentPosition(b.element) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1)
  return order.map(({ element: _element, ...link }) => link)
}

export const WIKILINK = 'wikilink:'

/** [[target|alias]] and ![[embeds]] as `wikilink:` links, outside code. */
export function wikilinks(text: string) {
  return text.split(/(```[\s\S]*?```|`[^`\n]*`)/).map((part, i) => i % 2 ? part : part.replace(/!?\[\[([^\]|#^\n]+)(?:[#^][^\]|\n]*)?(?:\|([^\]\n]*))?\]\]/g,
    (_all, target: string, alias?: string) => `[${(alias ?? target).trim().replace(/[[\]]/g, '')}](<${WIKILINK}${encodeURIComponent(target.trim())}>)`)).join('')
}

/** The file a link names: a wikilink's target, a relative link's path (its #anchor left off), or code as it reads. */
function fileName(href: string, kind: 'link' | 'code') {
  if (kind === 'code') return href
  try {
    return href.toLowerCase().startsWith(WIKILINK) ? decodeURIComponent(href.slice(WIKILINK.length)) : decodeURI(href.split('#')[0]!)
  } catch { return href }
}

/** A web address as a list shows it: host and path, no scheme. */
export const shortUrl = (url: string) => url.replace(/^https?:\/\/(www\.)?/i, '').replace(/\/$/, '')

/** The core's: files and web pages. */
export function registerLinks(core: UiApi) {
  core.link({
    scheme: 'wikilink',
    match: (href, kind, where) => Boolean(where.openFile) && (kind === 'code' ? looksLikePath(href)
      : href.toLowerCase().startsWith(WIKILINK) || (href !== '' && !/^([a-z][\w+.-]*:|#|\/\/)/i.test(href))),
    render: FileLink,
    open: (href, { openFile, kind }) => openFile!(fileName(href, kind)),
    target: fileName,
  })
  core.link({
    match: /^(https?|mailto):/i,
    render: WebLink,
    // In the browser; beside, in a pane, where something shows web pages.
    open(href, { openUrl, beside }) {
      if (beside && openUrl && /^https?:/i.test(href)) openUrl(href)
      else window.open(href, '_blank', 'noopener,noreferrer')
    },
    target: shortUrl,
  })
}

/** A file or folder a message names. One that can't be opened says why, and looks it. */
function FileLink({ href, code, children, open, attributes }: LinkProps) {
  const [problem, setProblem] = useState<string>()
  const name = fileName(href, code ? 'code' : 'link')
  return (
    <a {...attributes} href="#" className={['md__file', attributes?.className, code && 'md__file--code', problem && 'md__file--missing'].filter(Boolean).join(' ')} title={problem ? `${name}: ${problem}` : name}
      onClick={(e) => { e.preventDefault(); void open(false).then(setProblem) }}>{children}</a>
  )
}

/** A web page: opened in the browser, with a button beside it to open it in a pane instead, where something shows them. */
function WebLink({ href, title, children, where, attributes }: LinkProps) {
  const web = <a {...attributes} href={href} title={title} target="_blank" rel="noreferrer">{children}</a>
  if (!where.openUrl || !/^https?:\/\//i.test(href)) return web
  return (
    <>
      {web}
      <button type="button" className="md__pane-link" aria-label="Open in a pane" title="Open in a pane" onClick={() => where.openUrl!(href)}>
        <SquareSplitHorizontalIcon aria-hidden />
      </button>
    </>
  )
}

/** A link with no drawing of its own: follows it, and is struck through with why when it couldn't. */
function PlainLink({ href, title, children, open, attributes }: LinkProps) {
  const [problem, setProblem] = useState<string>()
  return (
    <a {...attributes} href={href} className={[attributes?.className, problem && 'md__file--missing'].filter(Boolean).join(' ') || undefined} title={problem ? `${title ?? href}: ${problem}` : title}
      onClick={(e) => { e.preventDefault(); void open(e.metaKey || e.ctrlKey).then(setProblem) }}>{children}</a>
  )
}

/** Follow `href` by its handler: resolves to why it couldn't, if it couldn't. */
export async function follow(handler: LinkHandler, href: string, kind: 'link' | 'code', where: LinkWhere, beside: boolean): Promise<string | undefined> {
  try {
    const said = await handler.open(href, { ...where, beside, kind })
    return typeof said === 'string' ? said : undefined
  } catch (error) { return (error as Error).message }
}

/** A link a handler claimed, drawn its way; in a transcript, kept for ⌃O's list. */
export function Claimed({ handler, href, kind, text, title, attributes, children }: { handler: LinkHandler; href: string; kind: 'link' | 'code'; text: string; title?: string; attributes?: LinkAttributes; children: ReactNode }) {
  const { collect, ...where } = useContext(LinkPlace)
  const place = useContext(LinkPlace)
  const open = useMemo(() => (beside: boolean) => follow(handler, href, kind, where, beside), [handler, href, kind, place])
  const ref = useRef<HTMLSpanElement>(null)
  useLayoutEffect(() => {
    if (!collect || !ref.current) return
    return collect({ element: ref.current, text: text || href, href, target: handler.target?.(href, kind) ?? href, open })
  }, [collect, open, text])
  const Render = handler.render ?? PlainLink
  const drawn = <Render href={href} code={kind === 'code'} where={where} open={open} {...(title ? { title } : {})} {...(attributes ? { attributes } : {})}>{children}</Render>
  // A box-less wrapper: its place in the document orders the list.
  return collect ? <span ref={ref} style={{ display: 'contents' }}>{drawn}</span> : drawn
}
