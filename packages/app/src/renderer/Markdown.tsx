// An assistant's text, as the markdown it is: GitHub-flavoured (tables, task lists, strikethrough), its fenced code
// coloured by the language it names. No raw HTML in a message: agents write `<T>` and `<div>` loosely, and those would
// vanish. A file (`html`) has it as GitHub shows it, sanitized, with its images read from beside it (Images).
// Web links open in the browser, not in the window; in a thread (OpenUrl) a button beside each opens it in a pane. Where a file can be opened (a thread: OpenFile), the files it
// names open beside it: [[wikilinks]], relative links, and code that reads as a path (`notes/plan.md`). A thread it
// names ([title](thread:<id>)) shows as that thread, to open (ThreadMachine).
import { createContext, memo, useContext, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ComponentProps, type ReactNode } from 'react'
import ReactMarkdown, { defaultUrlTransform, type Components, type ExtraProps } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { highlight, languageNamed } from './code-highlight.ts'
import { htmlPlugins, imagePath, looksLikePath, mediaMatches, parseSrcset } from './markdown-html.ts'
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

/**
 * Where a rendered file's images come from: its folder (`a/b/`), and a read of a file in the thread's folder to a URL
 * the window can show. Without it, images are left as they are.
 */
export const Images = createContext<{ dir: string; load: (path: string) => Promise<string> } | undefined>(undefined)

const FILE = 'superego-file:'
const THREAD = 'thread:'

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

/** A fenced block's code, coloured once its language is loaded; plain until then (or in a language nobody knows). */
function Highlighted({ code, name, className }: { code: string; name: string; className: string }) {
  const language = languageNamed(name)
  const [, loaded] = useState(0)
  useEffect(() => {
    if (language && !language.support) void language.load().then(() => loaded((n) => n + 1), () => {})
  }, [language])
  const lines = language && highlight(code, language)
  if (!lines) return <code className={className}>{code}</code>
  // A diff's added and removed lines are tinted, whole.
  const diff = language.name.toLowerCase() === 'diff'
  const lineClass = (line: string) => !diff ? undefined
    : /^\+(?!\+\+ )/.test(line) ? 'md__line--add' : /^-(?!-- )/.test(line) ? 'md__line--del' : undefined
  const texts = code.split('\n')
  return (
    <code className={`${className} is-highlighted`}>
      {lines.map((pieces, i) => {
        const content = pieces.map((piece, j) => piece.classes ? <span key={j} className={piece.classes}>{piece.text}</span> : piece.text)
        const end = i < lines.length - 1 ? '\n' : ''
        const tint = lineClass(texts[i] ?? '')
        return tint ? <span key={i} className={tint}>{content}{end}</span> : <span key={i}>{content}{end}</span>
      })}
    </code>
  )
}

/** Whether the app is dark: its own color-scheme if it sets just one, else the system's. */
function appDark() {
  const scheme = getComputedStyle(document.documentElement).colorScheme
  const dark = /\bdark\b/.test(scheme), light = /\blight\b/.test(scheme)
  return dark !== light ? dark : matchMedia('(prefers-color-scheme: dark)').matches
}
function watchTheme(changed: () => void) {
  const query = matchMedia('(prefers-color-scheme: dark)')
  query.addEventListener('change', changed)
  const observer = new MutationObserver(changed)
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style', 'data-theme'] })
  return () => { query.removeEventListener('change', changed); observer.disconnect() }
}
const useAppDark = () => useSyncExternalStore(watchTheme, appDark, () => false)

type ImageProps = { src?: string; srcSet?: string; alt?: string; title?: string; width?: string | number; height?: string | number }
const WEB = /^https?:\/\//i

/**
 * An image in a rendered file: one beside it is read from the thread's machine (and its srcset's too); one on the web
 * is shown from there. While reading, nothing; a file that can't be read says so, by its alt text.
 */
function FileImage({ src, srcSet, alt, title, width, height }: ImageProps) {
  const images = useContext(Images)!
  const candidates = srcSet ? parseSrcset(srcSet) : []
  const wanted = [...new Set([src, ...candidates.map((c) => c.url)].filter((url): url is string => Boolean(url)))]
  const key = wanted.join('\n')
  const [loaded, setLoaded] = useState<{ key: string; urls: Map<string, string | null> }>()
  useEffect(() => {
    let alive = true
    void Promise.all(wanted.map(async (url): Promise<[string, string | null]> => {
      if (WEB.test(url)) return [url, url]
      const path = imagePath(images.dir, url)
      return [url, path === undefined ? null : await images.load(path).catch(() => null)]
    })).then((pairs) => { if (alive) setLoaded({ key, urls: new Map(pairs) }) })
    return () => { alive = false }
  }, [images, key])
  if (loaded?.key !== key) return null
  const at = (url: string | undefined) => url ? loaded.urls.get(url) ?? undefined : undefined
  const set = candidates.flatMap((c) => { const url = at(c.url); return url ? [`${url}${c.descriptor ? ` ${c.descriptor}` : ''}`] : [] }).join(', ')
  const shown = at(src) ?? at(candidates[0]?.url)
  if (!shown) return <span className="md__image-missing" title={src ?? srcSet}>{alt || src}</span>
  return <img src={shown} srcSet={set || undefined} alt={alt ?? ''} title={title} width={width} height={height} />
}

type HastNode = { type: string; tagName?: string; properties?: Record<string, unknown>; children?: HastNode[] }
const text = (value: unknown) => typeof value === 'string' ? value : Array.isArray(value) ? value.join(' ') : undefined

/**
 * A `<picture>`: the source whose media holds (its `prefers-color-scheme` the app's theme, which may not be the
 * system's), shown through its `<img>`.
 */
function Picture({ node, children }: ExtraProps & { children?: ReactNode }) {
  const dark = useAppDark()
  if (!useContext(Images)) return <picture>{children}</picture>
  const elements = ((node as HastNode | undefined)?.children ?? []).filter((child) => child.type === 'element')
  const img = elements.find((child) => child.tagName === 'img')?.properties ?? {}
  const source = elements.filter((child) => child.tagName === 'source').map((child) => child.properties ?? {})
    .find((props) => text(props.srcSet) && mediaMatches(text(props.media), dark, (query) => matchMedia(query).matches)
      && (!text(props.type) || /^image\/(svg\+xml|png|jpe?g|gif|webp|avif)$/i.test(text(props.type)!)))
  const srcSet = text(source?.srcSet)
  return (
    <FileImage key={srcSet ?? 'img'} src={srcSet ? undefined : text(img.src)} srcSet={srcSet ?? text(img.srcSet)} alt={text(img.alt)}
      title={text(img.title)} width={text(img.width)} height={text(img.height)} />
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
    if (open && !className && text && looksLikePath(text)) return <FileLink name={text} className="md__file--code"><code {...props}>{text}</code></FileLink>
    const language = /(?:^|\s)language-(\S+)/.exec(className ?? '')?.[1]
    if (language && text !== undefined) return <Highlighted code={text} name={language} className={className!} />
    return <code className={className} {...props}>{children}</code>
  },
  img: ({ node: _node, src, srcSet, alt, title, width, height, ...props }) => {
    if (!useContext(Images)) return <img src={src} alt={alt} title={title} width={width} height={height} {...props} />
    return <FileImage src={src} srcSet={srcSet} alt={alt} title={title} width={width} height={height} />
  },
  picture: Picture,
  // Tables scroll sideways inside the column instead of widening it.
  table: ({ node: _node, ...props }) => <div className="md__table"><table {...props} /></div>,
  pre: CodeBlock,
}

const urlTransform = (url: string) => url.startsWith(FILE) || url.startsWith(THREAD) ? url : defaultUrlTransform(url)

/** Footnotes' ids are prefixed once, by the sanitizing, not again before it. */
const noPrefix = { clobberPrefix: '' }

/** `text` as Markdown; with `html`, its HTML too (sanitized), as a document's. */
export const Markdown = memo(function Markdown({ text, html = false }: { text: string; html?: boolean }) {
  const files = useContext(OpenFile)
  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={[remarkGfm]} {...(html ? { rehypePlugins: htmlPlugins, remarkRehypeOptions: noPrefix } : {})} components={components} urlTransform={urlTransform}>
        {files ? wikilinks(text) : text}
      </ReactMarkdown>
    </div>
  )
})
