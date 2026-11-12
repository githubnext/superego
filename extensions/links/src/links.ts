// The links in a thread's transcript, as the list offers them: newest first, one per place they go.
import { score } from '@superego/app/ui'

/**
 * A link: what it says, where it goes (a web address, or the file it names), and how to follow it: `open` as a click
 * on it does, `beside` in a pane (absent when it can't be).
 */
export type Link = { text: string; target: string; kind: 'web' | 'file'; open(): void; beside?: () => void }

/** `links` in the transcript's order, newest first, each place once (its newest mention). */
export function newestFirst(links: Link[]): Link[] {
  const seen = new Set<string>()
  return [...links].reverse().filter((link) => !seen.has(`${link.kind}:${link.target}`) && Boolean(seen.add(`${link.kind}:${link.target}`)))
}

/** The links that match `query` by what they say or where they go, best first; in their order when it ties or is empty. */
export function filter(links: Link[], query: string): Link[] {
  if (!query.trim()) return links
  return links.map((link, index) => ({ link, index, r: Math.max(score(link.text, query), score(link.target, query)) }))
    .filter((m) => m.r > 0).sort((a, b) => b.r - a.r || a.index - b.index).map((m) => m.link)
}

/** A web address as the list shows it: host and path, no scheme. */
export const short = (url: string) => url.replace(/^https?:\/\/(www\.)?/i, '').replace(/\/$/, '')

/**
 * The links in a transcript, from the anchors its messages render: web links (opened in the browser; the button beside
 * one opens it in a pane) and the files a message names (opened in a pane either way).
 */
export function linksIn(transcript: Element): Link[] {
  return [...transcript.querySelectorAll<HTMLAnchorElement>('a[href]')].flatMap((a): Link[] => {
    const text = (a.textContent ?? '').trim()
    if (a.classList.contains('md__file')) {
      const name = a.title || text
      return [{ text: text || name, target: name, kind: 'file', open: () => a.click(), beside: () => a.click() }]
    }
    const href = a.getAttribute('href') ?? ''
    if (!/^[a-z][\w+.-]*:/i.test(href)) return []
    const pane = a.nextElementSibling?.classList.contains('md__pane-link') ? a.nextElementSibling as HTMLElement : undefined
    return [{ text: text || href, target: href, kind: 'web', open: () => a.click(), ...(pane ? { beside: () => pane.click() } : {}) }]
  })
}
