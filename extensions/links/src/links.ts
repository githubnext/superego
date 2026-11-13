// The links in a thread's transcript, as the list offers them: newest first, one per place they go.
import { score, type TranscriptLink } from '@superego/app/ui'

/** A link: what it says, where it goes (in a line), and how to follow it (`beside`: in a pane, where it can be). */
export type Link = Pick<TranscriptLink, 'text' | 'href' | 'target' | 'open'>

/** `links` in the transcript's order, newest first, each place once (its newest mention). */
export function newestFirst<L extends Link>(links: L[]): L[] {
  const seen = new Set<string>()
  return [...links].reverse().filter((link) => !seen.has(link.href) && Boolean(seen.add(link.href)))
}

/** The links that match `query` by what they say or where they go, best first; in their order when it ties or is empty. */
export function filter<L extends Link>(links: readonly L[], query: string): L[] {
  if (!query.trim()) return [...links]
  return links.map((link, index) => ({ link, index, r: Math.max(score(link.text, query), score(link.target, query)) }))
    .filter((m) => m.r > 0).sort((a, b) => b.r - a.r || a.index - b.index).map((m) => m.link)
}
