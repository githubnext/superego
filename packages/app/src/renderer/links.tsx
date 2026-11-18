// Links in Markdown, claimed by handlers (`superego.link`): what a link of a kind looks like and what following it does.
// The core claims the files a thread names (`[[wikilinks]]`, relative links, code that reads as a path) and web pages,
// as defaults: a thread's profile is asked first, then the extensions, so either can claim these its own way (the
// obsidian profile's notes). The threads extension claims threads (`thread:<id>`). Messages, a file's rendered text and
// the editor's live preview all follow links through the same handlers (`linkHandler`, `follow`).
// They stay the core's, not the files' or browser extensions': both are optional, and a link to a file or a page
// must work in a thread that goes without them (a file opens in the core's editor, a page in the browser).
// A thread's transcript keeps the links it draws, in order, for ⌃O's list (`transcriptLinks`).
import { createContext, useCallback, useContext, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { ThreadInfo } from '@superego/protocol'
import { SquareSplitHorizontalIcon } from '@superego/ui'
import { machine as client } from './client.ts'
import type { LinkAttributes, LinkHandler, LinkProps, LinkWhere, UiApi } from './extension-api.ts'
import { useRegistry, whose } from './registry.tsx'
import { fileKind, folderKind, urlKind } from './lookups.ts'
import { Contained } from './contained.tsx'
import { looksLikePath, resolve } from './markdown-html.ts'
import { shortPath } from './short-path.ts'
import { parseWikilink, WIKILINK } from './wikilinks.ts'

/** A link drawn in a transcript: what it says, where it goes, and a way to follow it. */
export type TranscriptLink = { text: string; href: string; target: string; open(beside: boolean): Promise<string | undefined> }
type Kept = TranscriptLink & { element: Element }

/** Where Markdown is drawn, for its links; `collect` keeps them for a thread's transcript. */
export type LinkPlaceValue = LinkWhere & { collect?: (link: Kept) => () => void }
export const LinkPlace = createContext<LinkPlaceValue>({})

/**
 * Where a thread's Markdown is drawn (its transcript, a file's rendered text), for its links: a file it names opens
 * beside the thread, in the pane kind that takes it, at the line it names (a folder in the kind that shows folders);
 * else why not, for the link to say. A file's links (`near`: the folder it's in) look beside it first. A web page opens
 * beside it in the pane kind that shows web pages; with none here, links open in the browser only. Kept the same while
 * what links care about is, so the text isn't drawn again as the thread moves on.
 */
export function useLinkPlace(machine: string, thread: ThreadInfo, { near, source }: { near?: string; source: string }): LinkPlaceValue {
  const registry = useRegistry()
  const latest = useRef({ machine, thread, near, source, registry })
  latest.current = { machine, thread, near, source, registry }
  const openFile = useCallback(async (name: string): Promise<string | undefined> => {
    const { machine, thread, near, source, registry } = latest.current
    try {
      const peer = client(machine)
      const at = /^(.+?)((?::\d+)+|#L\d+.*)$/.exec(name)
      const beside = near === undefined ? undefined : resolve(near, at?.[1] ?? name)
      const there = beside ? await peer.call('file.find', { thread: thread.id, name: `${beside}${at?.[2] ?? ''}` }) : undefined
      const found = there && (there.path === beside || there.path === `${beside}.md`) ? there : await peer.call('file.find', { thread: thread.id, name })
      const folder = shortPath(thread.cwd)
      if (found.outside) return `outside ${folder}, where this thread works`
      if (found.path === null) return `not in ${folder}`
      const where = { machine, thread }
      const kind = found.folder ? folderKind(registry, where) : fileKind(registry, where, found.path)
      if (!kind) return found.folder ? 'a folder, and nothing here shows folders' : 'a file, and nothing here shows files'
      await registry.router.dispatch('pane.open', { thread: thread.id, kind, params: { path: found.path, ...(found.line ? { line: found.line } : {}) } }, { machine, source })
      return undefined
    } catch (error) { return (error as Error).message }
  }, [])
  const web = urlKind(registry, { machine, thread })
  const openUrl = useCallback((url: string) => {
    const { machine, thread, source, registry } = latest.current
    const kind = urlKind(registry, { machine, thread })
    if (!kind) return
    const host = URL.parse(url)?.host
    void registry.router.dispatch('pane.open', { thread: thread.id, kind, ...(host ? { title: host } : {}), params: { url } }, { machine, source })
      .catch((error) => console.error(error))
  }, [])
  const linkThread = useMemo(() => thread, [thread.id, thread.profile?.dir, String(thread.without)])
  return useMemo(() => ({ machine, thread: linkThread, openFile, ...(web ? { openUrl } : {}) }), [machine, linkThread, web])
}

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

export { parseWikilink, WIKILINK, wikilinkHref, wikilinks, type Wikilink } from './wikilinks.ts'

/** The file a link names: a wikilink's note (its #heading left off), a relative link's path (its #anchor too), or code as it reads. */
function fileName(href: string, kind: 'link' | 'code') {
  if (kind === 'code') return href
  const wiki = parseWikilink(href)
  if (wiki) return wiki.target
  try { return decodeURI(href.split('#')[0]!) } catch { return href }
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
      onClick={(e) => { e.preventDefault(); void open(e.metaKey || e.ctrlKey).then(setProblem) }}>{children}</a>
  )
}

/** A web page: opened in the browser, with a button beside it to open it in a pane instead, where something shows them. */
function WebLink({ href, title, children, where, attributes, open }: LinkProps) {
  const inPane = Boolean(where.openUrl) && /^https?:\/\//i.test(href)
  // ⌘-click: beside, as any link's.
  const web = <a {...attributes} href={href} title={title} target="_blank" rel="noreferrer"
    {...inPane ? { onClick: (e) => { if (e.metaKey || e.ctrlKey) { e.preventDefault(); void open(true) } } } : {}}>{children}</a>
  if (!inPane) return web
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
  // Drawn apart: a handler's drawing that throws takes only its own link.
  const drawn = (
    <Contained name={whose(handler)} inline>
      <Render href={href} code={kind === 'code'} where={where} open={open} {...(title ? { title } : {})} {...(attributes ? { attributes } : {})}>{children}</Render>
    </Contained>
  )
  // A box-less wrapper: its place in the document orders the list.
  return collect ? <span ref={ref} style={{ display: 'contents' }}>{drawn}</span> : drawn
}
