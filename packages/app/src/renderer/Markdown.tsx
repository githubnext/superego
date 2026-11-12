// An assistant's text, as the markdown it is: GitHub-flavoured (tables, task lists, strikethrough). No raw HTML.
// Web links open in the browser, not in the window; in a thread (OpenUrl) a button beside each opens it in a pane. Where a file can be opened (a thread: OpenFile), the files it
// names open beside it: [[wikilinks]], relative links, and code that reads as a path (`notes/plan.md`). A thread it
// names ([title](thread:<id>)) shows as that thread, to open (ThreadMachine).
import { createContext, memo, useContext, useEffect, useLayoutEffect, useRef, useState, type ComponentProps } from 'react'
import ReactMarkdown, { defaultUrlTransform, type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { CheckIcon, CopyIcon, SquareSplitHorizontalIcon } from '@superego/ui'
import { ThreadRef } from './thread-ref.tsx'

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

/**
 * Puts `text` on the clipboard by selecting it and copying, as a keypress would: at once, with no permission to ask
 * for, and over Web access's plain http too. Focus and the selection go back to where they were.
 */
function copyBySelection(text: string) {
  const focused = document.activeElement instanceof HTMLElement ? document.activeElement : undefined
  const selection = document.getSelection()
  const ranges = selection ? Array.from({ length: selection.rangeCount }, (_, i) => selection.getRangeAt(i)) : []
  const area = document.createElement('textarea')
  area.value = text
  area.setAttribute('readonly', '')
  area.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none;user-select:text'
  document.body.append(area)
  area.select()
  let ok = false
  try { ok = document.execCommand('copy') } finally {
    area.remove()
    focused?.focus({ preventScroll: true })
    if (selection) { selection.removeAllRanges(); for (const range of ranges) selection.addRange(range) }
  }
  return ok
}

async function copyText(text: string) {
  if (copyBySelection(text)) return
  if (!navigator.clipboard) throw new Error('No way to copy here')
  await navigator.clipboard.writeText(text)
}

/** A code block in a message, with a button in its corner that copies all of it: blue with a check once it has. */
function CodeBlock(props: ComponentProps<'pre'> & { node?: unknown }) {
  const ref = useRef<HTMLDivElement>(null)
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle')
  // Each click keeps the feedback up for its full time, even mid-way through the last one's.
  const [click, setClick] = useState(0)
  useEffect(() => {
    if (state === 'idle') return
    const timer = setTimeout(() => setState('idle'), state === 'copied' ? 1600 : 2400)
    return () => clearTimeout(timer)
  }, [state, click])
  const copy = () => {
    const text = ref.current?.querySelector('pre')?.textContent?.replace(/\n$/, '') ?? ''
    setClick((n) => n + 1)
    copyText(text).then(() => setState('copied'), (error) => { console.error(error); setState('failed') })
  }
  const label = state === 'copied' ? 'Copied' : state === 'failed' ? 'Couldn’t copy' : 'Copy all'
  return (
    <div ref={ref} className="md__code">
      <Scroll {...props} />
      <button type="button" className={`md__copy ${state !== 'idle' ? `is-${state}` : ''}`} aria-label={label} title={label} onClick={copy}>
        {state === 'copied' ? <CheckIcon weight="bold" aria-hidden /> : <CopyIcon aria-hidden />}
      </button>
    </div>
  )
}

/**
 * Opens a file (or folder) by the name the text gives it; resolves to why it couldn't, if it couldn't. Provided where
 * there's a folder to look in: a thread.
 */
export const OpenFile = createContext<((name: string) => Promise<string | undefined>) | undefined>(undefined)

/** The machine whose threads a message names ([title](thread:<id>)). Provided in a thread. */
export const ThreadMachine = createContext<string | undefined>(undefined)

/** Opens a web page in a pane beside the thread. Provided where there's a thread to open it beside. */
export const OpenUrl = createContext<((url: string) => void) | undefined>(undefined)

const FILE = 'superego-file:'
const THREAD = 'thread:'
/** A path, by its look: no spaces at its ends, a slash or a file extension, and no scheme. A folder may end in `/`. */
const PATHLIKE = /^(?![a-z][\w+.-]*:)(?:[\w.@~/-][^\n`]*\/[^\n`]*[^\s]|[\w@~-][^\n`/]*\.[A-Za-z][\w]{0,7}(?::\d+)*)$/

/** [[target|alias]] and ![[embeds]] as links to the file, outside code. */
function wikilinks(text: string) {
  return text.split(/(```[\s\S]*?```|`[^`\n]*`)/).map((part, i) => i % 2 ? part : part.replace(/!?\[\[([^\]|#^\n]+)(?:[#^][^\]|\n]*)?(?:\|([^\]\n]*))?\]\]/g,
    (_all, target: string, alias?: string) => `[${(alias ?? target).trim().replace(/[[\]]/g, '')}](<${FILE}${encodeURIComponent(target.trim())}>)`)).join('')
}

/** A file or folder a message names. One that can't be opened says why, and looks it. */
function FileLink({ name, children, className }: { name: string; children: React.ReactNode; className?: string }) {
  const open = useContext(OpenFile)!
  const [problem, setProblem] = useState<string>()
  return (
    <a href="#" className={['md__file', className, problem && 'md__file--missing'].filter(Boolean).join(' ')} title={problem ? `${name}: ${problem}` : name}
      onClick={(e) => { e.preventDefault(); void open(name).then(setProblem) }}>{children}</a>
  )
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
    const machine = useContext(ThreadMachine)
    if (machine && href.startsWith(THREAD)) return <ThreadRef machine={machine} id={href.slice(THREAD.length)}>{props.children}</ThreadRef>
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
  pre: CodeBlock,
}

const urlTransform = (url: string) => url.startsWith(FILE) || url.startsWith(THREAD) ? url : defaultUrlTransform(url)

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  const files = useContext(OpenFile)
  return <div className="md"><ReactMarkdown remarkPlugins={[remarkGfm]} components={components} urlTransform={urlTransform}>{files ? wikilinks(text) : text}</ReactMarkdown></div>
})
