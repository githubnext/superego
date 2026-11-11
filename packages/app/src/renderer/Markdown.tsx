// An assistant's text, as the markdown it is: GitHub-flavoured (tables, task lists, strikethrough). No raw HTML.
// Web links open in the browser, not in the window; in a thread (OpenUrl) a button beside each opens it in a pane. Where a file can be opened (a thread: OpenFile), the files it
// names open beside it: [[wikilinks]], relative links, and code that reads as a path (`notes/plan.md`).
import { createContext, memo, useContext, useLayoutEffect, useRef, type ComponentProps } from 'react'
import ReactMarkdown, { defaultUrlTransform, type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { SquareSplitHorizontalIcon } from '@mu/ui'

/** Code scrolls sideways, never wraps; it fades at the right edge only while a line runs past it. */
export function Scroll({ node: _node, ...props }: ComponentProps<'pre'> & { node?: unknown }) {
  const ref = useRef<HTMLPreElement>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const check = () => el.classList.toggle('is-overflowing', el.scrollWidth - el.scrollLeft - el.clientWidth > 1)
    check()
    const observer = new ResizeObserver(check)
    observer.observe(el)
    el.addEventListener('scroll', check, { passive: true })
    return () => { observer.disconnect(); el.removeEventListener('scroll', check) }
  }, [])
  return <pre ref={ref} {...props} />
}

/** Opens a file by the name the text gives it. Provided where there's a folder to look in: a thread. */
export const OpenFile = createContext<((name: string) => void) | undefined>(undefined)

/** Opens a web page in a pane beside the thread. Provided where there's a thread to open it beside. */
export const OpenUrl = createContext<((url: string) => void) | undefined>(undefined)

const FILE = 'mu-file:'
/** A path, by its look: no spaces at its ends, a slash or a file extension, and no scheme. */
const PATHLIKE = /^(?![a-z][\w+.-]*:)(?:[\w.@~-][^\n`]*\/[^\n`]*[^\s/]|[\w@~-][^\n`/]*\.[A-Za-z][\w]{0,7})$/

/** [[target|alias]] and ![[embeds]] as links to the file, outside code. */
function wikilinks(text: string) {
  return text.split(/(```[\s\S]*?```|`[^`\n]*`)/).map((part, i) => i % 2 ? part : part.replace(/!?\[\[([^\]|#^\n]+)(?:[#^][^\]|\n]*)?(?:\|([^\]\n]*))?\]\]/g,
    (_all, target: string, alias?: string) => `[${(alias ?? target).trim().replace(/[[\]]/g, '')}](<${FILE}${encodeURIComponent(target.trim())}>)`)).join('')
}

function FileLink({ name, children, className }: { name: string; children: React.ReactNode; className?: string }) {
  const open = useContext(OpenFile)!
  return <a href="#" className={className ? `md__file ${className}` : 'md__file'} title={name} onClick={(e) => { e.preventDefault(); open(name) }}>{children}</a>
}

/** Beside a web link: open it in a pane instead of the browser. */
function PaneLinkButton({ url }: { url: string }) {
  const open = useContext(OpenUrl)
  if (!open) return null
  return (
    <button type="button" className="md__pane-link" aria-label="Open in a pane" title="Open in a pane" onClick={() => open(url)}>
      <SquareSplitHorizontalIcon aria-hidden />
    </button>
  )
}

const components: Components = {
  a: ({ node: _node, href = '', ...props }) => {
    const open = useContext(OpenFile)
    if (open && href.startsWith(FILE)) return <FileLink name={decodeURIComponent(href.slice(FILE.length))}>{props.children}</FileLink>
    if (open && href && !/^([a-z][\w+.-]*:|#|\/\/)/i.test(href)) return <FileLink name={decodeURI(href.split('#')[0]!)}>{props.children}</FileLink>
    const web = <a {...props} href={href} target="_blank" rel="noreferrer" />
    return /^https?:\/\//i.test(href) ? <>{web}<PaneLinkButton url={href} /></> : web
  },
  code: ({ node: _node, className, children, ...props }) => {
    const open = useContext(OpenFile)
    const text = typeof children === 'string' ? children : undefined
    if (open && !className && text && PATHLIKE.test(text)) return <FileLink name={text} className="md__file--code"><code {...props}>{text}</code></FileLink>
    return <code className={className} {...props}>{children}</code>
  },
  // Tables scroll sideways inside the column instead of widening it.
  table: ({ node: _node, ...props }) => <div className="md__table"><table {...props} /></div>,
  pre: Scroll,
}

const urlTransform = (url: string) => url.startsWith(FILE) ? url : defaultUrlTransform(url)

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  const files = useContext(OpenFile)
  return <div className="md"><ReactMarkdown remarkPlugins={[remarkGfm]} components={components} urlTransform={urlTransform}>{files ? wikilinks(text) : text}</ReactMarkdown></div>
})
