// What's typed in a Browser pane's address bar, as where to go: a web address as it is; a bare host (`example.com`,
// `localhost:5173`) with its scheme, `http://` for this computer and the local network, as nothing there has a
// certificate, else `https://`; an HTML file's path, in the working folder; anything else, a search.

/** Where a Browser pane goes: a web page, or an HTML file in the thread's folder. */
export type Destination = { url: string } | { path: string }

/** The search engines the address bar searches with (an app setting, `SEARCH_ENGINE`). */
export const SEARCH_ENGINES = {
  duckduckgo: { label: 'DuckDuckGo', url: 'https://duckduckgo.com/?q=' },
  google: { label: 'Google', url: 'https://www.google.com/search?q=' },
} as const
export type SearchEngine = keyof typeof SEARCH_ENGINES
/** The app setting naming the search engine. */
export const SEARCH_ENGINE = 'browser.searchEngine'
export const DEFAULT_SEARCH_ENGINE: SearchEngine = 'duckduckgo'

/** A web page's address, typed with its scheme. */
const WEB = /^https?:\/\//i
/** A host, its port and the rest: `example.com`, `localhost:5173/as/me`, `[::1]:3000`. */
const HOST = /^(\[[0-9a-f:.]+\]|[a-z0-9-]+(?:\.[a-z0-9-]+)*\.?)(:\d{1,5})?([/?#].*)?$/i
const IPV4 = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/
/** An HTML file, by its path: `report.html`, `docs/page.htm`. */
const HTML_FILE = /\.html?$/i

/** Whether `host` is this computer or on its network: reached over plain `http://`. */
export function isLocalHost(host: string): boolean {
  const name = host.toLowerCase().replace(/\.$/, '')
  if (name === 'localhost' || name.endsWith('.localhost') || name.endsWith('.local') || name === '[::1]') return true
  const ip = IPV4.exec(name)
  if (!ip) return false
  const [a, b] = [Number(ip[1]), Number(ip[2])]
  return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254)
}

/**
 * Whether a page the agent chose waits for the user before it loads: one beyond this computer and its network (a
 * one-part name, `workbox:5173`, is on it). Loading a page sends its address, and the agent could have put what it
 * read in there; a dev server here, or near, is no one else's to hear it.
 */
export function asksFirst(url: string): boolean {
  const parsed = URL.parse(url)
  if (!parsed || !/^https?:$/.test(parsed.protocol)) return true
  const host = parsed.hostname
  return !isLocalHost(host) && (host.includes('.') || host.startsWith('['))
}

/** Where `typed` goes; nothing for nothing typed. */
export function destination(typed: string, engine: SearchEngine = DEFAULT_SEARCH_ENGINE): Destination | undefined {
  const text = typed.trim()
  if (!text) return undefined
  // A file's path: its first part not a host (no dot, or the file itself).
  const path = text.replace(/^\.\//, '')
  const first = path.split('/')[0]!
  if (HTML_FILE.test(path) && !/[\s?#:]/.test(path) && (!first.includes('.') || HTML_FILE.test(first))) return { path }
  const url = webAddress(text)
  return { url: url ?? SEARCH_ENGINES[engine].url + encodeURIComponent(text) }
}

/** `text` as a web page's address, if it's one: with its scheme already, or a bare host given one. */
export function webAddress(typed: string): string | undefined {
  const text = typed.trim()
  if (WEB.test(text)) return text
  if (/\s/.test(text)) return undefined
  const host = HOST.exec(text)
  if (!host) return undefined
  const [, name, port] = host as unknown as [string, string, string | undefined]
  const local = isLocalHost(name)
  // A name of one part is a host only where it's one on its own (localhost), or given a port (`workbox:5173`), a host
  // on the local network then.
  const lan = port !== undefined && !name.includes('.') && !name.startsWith('[')
  if (!local && !lan && !IPV4.test(name) && !/\.[a-z]{2,}\.?$/i.test(name)) return undefined
  return `${local || lan ? 'http' : 'https'}://${text}`
}
