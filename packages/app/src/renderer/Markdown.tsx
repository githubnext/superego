// An assistant's text, as the markdown it is: GitHub-flavoured (tables, task lists, strikethrough), its fenced code
// coloured by the language it names. No raw HTML in a message: agents write `<T>` and `<div>` loosely, and those would
// vanish. A file (`html`) has it as GitHub shows it, sanitized. In a thread (Images), images that are its files are read
// from its machine (a message's from its folder, a file's from beside it), and open in the lightbox.
// Links are drawn by the handler that claims them (links.tsx: threads, files, web pages, and extensions' own), for the
// place they're in (LinkPlace: a thread, a file beside one); any other opens in the browser. [[wikilinks]] are links
// where something claims them.
import { createContext, memo, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ComponentProps, type ReactNode } from 'react'
import ReactMarkdown, { defaultUrlTransform, type Components, type ExtraProps } from 'react-markdown'
import remarkBreaks from 'remark-breaks'
import remarkGfm from 'remark-gfm'
import { highlight, languageNamed } from './code-highlight.ts'
import { htmlPlugins, imageSource, mediaMatches, parseSrcset } from './markdown-html.ts'
import type { MachineEntry } from '../shared/bridge.ts'
import { ImageFrame, imageSourceOf, loadWebImages, onImageChange, onWeb, useWebImagesAsked, WebImage, type ImageItem } from './images.tsx'
import { Lightbox } from './lightbox.tsx'
import { CheckIcon, CopyIcon } from '@superego/ui'
import { copyText } from './copy-text.ts'
import { useAppDark } from './appearance.ts'
import { useOptionalRegistry } from './registry.tsx'
import { codeBlockOwner, codeBlockView, linkHandler, linkSchemes } from './lookups.ts'
import { Contained } from './contained.tsx'
import { Claimed, LinkPlace, WIKILINK, wikilinks } from './links.tsx'
import { useKnownFiles } from './known-files.ts'
import { proseCell } from './table-cells.ts'

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

/** How the Markdown a code block is in is set: compact (a preview, a fold's summary), and still streaming. */
const MarkdownContext = createContext<{ compact: boolean; streaming: boolean }>({ compact: false, streaming: false })

/**
 * A fenced code block: drawn by the extension that claims its language for the place it's in (`superego.codeBlock`),
 * else as code.
 */
function CodeBlock(props: ComponentProps<'pre'> & { node?: unknown }) {
  const registry = useOptionalRegistry()
  const { machine, thread } = useContext(LinkPlace)
  const { compact, streaming } = useContext(MarkdownContext)
  const fence = registry?.codeBlocks.length ? fenced(props.node as HastNode | undefined) : undefined
  const where = machine && thread ? { machine, thread } : undefined
  const Custom = fence && codeBlockView(registry!, fence.language, where)
  if (!Custom) return <PlainCodeBlock {...props} />
  const owner = codeBlockOwner(registry!, fence!.language, where)!
  return (
    <Contained name={owner.extension} scope={owner.profile}>
      <Custom language={fence!.language} code={fence!.code} compact={compact} streaming={streaming} />
    </Contained>
  )
}

/** A `<pre>`'s one `<code>`, by its language (`language-<tag>`, lowercased) and text (without its last newline). */
function fenced(pre: HastNode | undefined): { language: string; code: string } | undefined {
  const elements = (pre?.children ?? []).filter((child) => child.type === 'element')
  const code = elements.length === 1 && elements[0]!.tagName === 'code' ? elements[0]! : undefined
  const classes = code?.properties?.className
  const tag = (Array.isArray(classes) ? classes : [classes]).map((c) => /^language-(\S+)$/.exec(String(c))?.[1]).find(Boolean)
  return tag ? { language: tag.toLowerCase(), code: textOf(code).replace(/\n$/, '') } : undefined
}

/** A code block in a message, with a button in its corner that copies all of it: blue with a check once it has. */
function PlainCodeBlock(props: ComponentProps<'pre'> & { node?: unknown }) {
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
 * Where images come from: the thread's machine, the thread, and an image's address as it is to be read there (`src`
 * from a message, or from beside a rendered file). Without it, images are left as they are.
 */
export type ImagesIn = { machine: MachineEntry; thread: string; resolve(src: string): ImageItem }
export const Images = createContext<ImagesIn | undefined>(undefined)

/** The images of a thread, written in a document in `dir` (`a/b/` in its folder, or one elsewhere; '' for a message). */
export function imagesIn(machine: MachineEntry, thread: string, dir = ''): ImagesIn {
  return {
    machine, thread,
    resolve(src) {
      const source = imageSource(src, { dir })
      return 'refused' in source ? { name: src, problem: source.refused } : { name: src, ...source }
    },
  }
}

/**
 * The images of one message or file, in order, to go through in the lightbox from the one clicked; and to load its web
 * images all at once, as the user asks for one of them.
 */
const Gallery = createContext<{ add(element: Element, image: ImageItem): () => void; open(element: Element): void; loadWeb(): void } | undefined>(undefined)

function GalleryOf({ images, children }: { images: ImagesIn; children: ReactNode }) {
  const shown = useRef(new Map<Element, ImageItem>())
  const [open, setOpen] = useState<{ images: ImageItem[]; start: number }>()
  const add = useCallback((element: Element, image: ImageItem) => {
    shown.current.set(element, image)
    return () => { shown.current.delete(element) }
  }, [])
  const show = useCallback((element: Element) => {
    const order = [...shown.current.keys()].sort((a, b) => a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1)
    setOpen({ images: order.map((e) => shown.current.get(e)!), start: Math.max(0, order.indexOf(element)) })
  }, [])
  const loadWeb = useCallback(() => loadWebImages([...shown.current.values()].filter(onWeb).map((image) => image.url!)), [])
  const gallery = useMemo(() => ({ add, open: show, loadWeb }), [add, show, loadWeb])
  return (
    <Gallery.Provider value={gallery}>
      {children}
      {open && <Lightbox machine={images.machine} thread={images.thread} images={open.images} start={open.start} onClose={() => setOpen(undefined)} />}
    </Gallery.Provider>
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


type ImageProps = { src?: string; srcSet?: string; alt?: string; title?: string; width?: string | number; height?: string | number }

/**
 * An image in a message or a rendered file, in a thread: one of its files is read from its machine as it nears the
 * screen (a srcset's other sizes too), one on the web shown from there. It fits the column, and opens in the lightbox.
 * One that can't be read says so quietly, by its alt text, and why on hover.
 */
function InlineImage({ src, srcSet, alt, title, width, height }: ImageProps) {
  const images = useContext(Images)!
  const gallery = useContext(Gallery)
  const candidates = srcSet ? parseSrcset(srcSet) : []
  const main = src || candidates[0]?.url || ''
  const image = useMemo(() => ({ ...images.resolve(main), ...(alt ? { alt } : {}), ...(title ? { caption: title } : {}) }), [images, main, alt, title])
  const sizes = useSrcset(images, candidates)
  const ref = useRef<HTMLSpanElement>(null)
  useLayoutEffect(() => {
    const element = ref.current
    return element && gallery ? gallery.add(element, image) : undefined
  }, [gallery, image])
  return (
    <span ref={ref} className="md__image">
      <ImageFrame machine={images.machine} thread={images.thread} image={image} className="image-frame--inline"
        srcSet={sizes} width={width} height={height} brokenLabel={alt || image.name} cropTall
        onOpen={() => { if (ref.current) gallery?.open(ref.current) }} {...(gallery ? { onLoadWeb: gallery.loadWeb } : {})} />
    </span>
  )
}

/**
 * A srcset with each of its files read as the window can load them (those that can't be, and web images not loaded
 * yet, left out); none for one size.
 */
function useSrcset(images: ImagesIn, candidates: { url: string; descriptor: string }[]) {
  const key = candidates.length > 1 ? candidates.map((c) => `${c.url} ${c.descriptor}`).join(',') : ''
  const [set, setSet] = useState<{ key: string; value: string }>()
  // Read again when one of its files changes (image-cache.ts), or web images are loaded.
  const [changed, setChanged] = useState(0)
  const asked = useWebImagesAsked()
  useEffect(() => {
    if (!key) return
    let alive = true
    const files = candidates.map((c) => images.resolve(c.url))
    void Promise.all(candidates.map((c, i) => imageSourceOf(images.machine, images.thread, files[i]!)
      .then((url) => `${url}${c.descriptor ? ` ${c.descriptor}` : ''}`, () => undefined)))
      .then((urls) => { if (alive) setSet({ key, value: urls.filter(Boolean).join(', ') }) })
    const offs = files.map((file) => onImageChange(images.machine, images.thread, file, 'thumbnail', () => setChanged((n) => n + 1)))
    return () => { alive = false; for (const off of offs) off() }
  }, [images.machine.id, images.thread, key, changed, asked])
  return set?.key === key && set.value ? set.value : undefined
}

type HastNode = { type: string; tagName?: string; value?: string; properties?: Record<string, unknown>; children?: HastNode[] }
/** The text in a node, all of it. */
const textOf = (node: HastNode | undefined): string => !node ? '' : node.type === 'text' ? node.value ?? '' : (node.children ?? []).map(textOf).join('')
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
    <InlineImage key={srcSet ?? 'img'} src={srcSet ? undefined : text(img.src)} srcSet={srcSet ?? text(img.srcSet)} alt={text(img.alt)}
      title={text(img.title)} width={text(img.width)} height={text(img.height)} />
  )
}

const components: Components = {
  // A link some handler claims (a thread, a file, a web page) is drawn its way; any other opens in the browser.
  a: ({ node, href = '', ...props }) => {
    const registry = useOptionalRegistry()
    const where = useContext(LinkPlace)
    const handler = registry && linkHandler(registry, href, 'link', where)
    if (handler) {
      const { children, title, ref: _ref, ...attributes } = props
      return (
        <Claimed handler={handler} href={href} kind="link" text={textOf(node as HastNode | undefined).trim()} {...(title ? { title } : {})}
          {...(Object.keys(attributes).length ? { attributes } : {})}>{children}</Claimed>
      )
    }
    // Nowhere to go: a scheme no handler claims and the browser shouldn't follow (dropped by `urlTransform`), say a
    // mention's whose extension is gone. Its words, as words.
    if (!href) return <>{props.children}</>
    return <a {...props} href={href} target="_blank" rel="noreferrer" />
  },
  code: ({ node: _node, className, children, ...props }) => {
    // Code that names a file is a link once that's known: drawn again then.
    useKnownFiles()
    const registry = useOptionalRegistry()
    const where = useContext(LinkPlace)
    const text = typeof children === 'string' ? children : undefined
    const handler = registry && !className && text ? linkHandler(registry, text, 'code', where) : undefined
    if (handler) return <Claimed handler={handler} href={text!} kind="code" text={text!}><code {...props}>{text}</code></Claimed>
    const language = /(?:^|\s)language-(\S+)/.exec(className ?? '')?.[1]
    if (language && text !== undefined) return <Highlighted code={text} name={language} className={className!} />
    return <code className={className} {...props}>{children}</code>
  },
  img: ({ node: _node, src, srcSet, alt, title, width, height, ...props }) => {
    if (!useContext(Images)) {
      const img = <img src={src} alt={alt} title={title} width={width} height={height} {...props} />
      return src ? <WebImage url={src} alt={alt}>{img}</WebImage> : img
    }
    return <InlineImage src={src} srcSet={srcSet} alt={alt} title={title} width={width} height={height} />
  },
  picture: Picture,
  // Tables scroll sideways inside the column instead of widening it.
  table: ({ node: _node, ...props }) => <div className="md__table"><table {...props} /></div>,
  th: ({ node, className, ...props }) => <th {...props} className={cellClass(className, node)} />,
  td: ({ node, className, ...props }) => <td {...props} className={cellClass(className, node)} />,
  pre: CodeBlock,
}

/** How much text a node holds, in characters. */
type TextNode = { type: string; value?: string; children?: TextNode[] }
const textLength = (node: TextNode): number =>
  node.type === 'text' ? node.value!.length : (node.children ?? []).reduce((sum, child) => sum + textLength(child), 0)

const cellClass = (className: string | undefined, node: TextNode | undefined) =>
  [className, proseCell(node ? textLength(node) : 0)].filter(Boolean).join(' ') || undefined

/** An image's data, blob or file:// address kept (read as the others, in a thread). */
const imageUrl = (url: string, key: string) => key === 'src' && /^(data:image\/|blob:|file:)/i.test(url)

const noSubscribe = () => () => {}

/** Footnotes' ids are prefixed once, by the sanitizing, not again before it. */
const noPrefix = { clobberPrefix: '' }

const gfm = [remarkGfm]
const gfmWithBreaks = [remarkGfm, remarkBreaks]

export type MarkdownProps = {
  text: string
  /** Its HTML too (sanitized), as a document's. */
  html?: boolean
  /** Each newline a line break, as a person typed it. */
  breaks?: boolean
  /** Cut to this many lines, the last ending in an ellipsis: a preview. */
  lines?: number
  /** Set small, for a narrow pane or a preview: the UI's size, a step of space between blocks, headings at the text's size. */
  compact?: boolean
  /** Still being written: an assistant's message as it streams (extensions' code blocks wait out half-written source). */
  streaming?: boolean
}

/** `text` as Markdown, typeset as the transcript sets it (its size and leading too) wherever it's put. */
export const Markdown = memo(function Markdown({ text, html = false, breaks = false, lines, compact = false, streaming = false }: MarkdownProps) {
  const registry = useOptionalRegistry()
  // Drawn again when extensions come or go: a profile's UI, loaded once its thread shows, claims links drawn before.
  const version = () => registry?.version ?? 0
  useSyncExternalStore(registry?.subscribe ?? noSubscribe, version, version)
  const where = useContext(LinkPlace)
  const images = useContext(Images)
  // Links a handler claims keep their scheme (thread:, wikilink:); [[wikilinks]] are links where one claims them.
  const claimed = (url: string) => Boolean(registry && linkHandler(registry, url, 'link', where))
  const urlTransform = (url: string, key: string) => imageUrl(url, key) || (key === 'href' && claimed(url)) ? url : defaultUrlTransform(url)
  const set = useMemo(() => ({ compact, streaming }), [compact, streaming])
  const rendered = (
    <div className={`md${compact ? ' md--compact' : ''}${lines ? ' md--clamped' : ''}`} {...(lines ? { style: { WebkitLineClamp: lines } } : {})}>
      <MarkdownContext.Provider value={set}>
        <ReactMarkdown remarkPlugins={breaks ? gfmWithBreaks : gfm} {...(html ? { rehypePlugins: htmlPlugins(registry ? linkSchemes(registry, where) : []), remarkRehypeOptions: noPrefix } : {})} components={components} urlTransform={urlTransform}>
          {claimed(`${WIKILINK}x`) ? wikilinks(text) : text}
        </ReactMarkdown>
      </MarkdownContext.Provider>
    </div>
  )
  return images ? <GalleryOf images={images}>{rendered}</GalleryOf> : rendered
})
