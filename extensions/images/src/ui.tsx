// images, UI half: a show_images call drawn as the images themselves, where the call is in the thread and outside the
// fold of its run of work. One image fits the column; a few sit in a grid; more go one at a time in a carousel (‹ ›,
// ←/→ when focused, a swipe on touch). Any opens in the lightbox. Each is read only as it nears the screen (a thumbnail;
// whole in the lightbox), holding its place (its size is known) until then, and says so when its file is gone. One alone
// and much taller than wide (a whole page's screenshot) shows its top at the column's width, fading out.
import { useRef, useState, type CSSProperties, type KeyboardEvent } from 'react'
import { defineUiExtension, describeImage, ImageFrame, Lightbox, loadWebImages, TALL, type MachineEntry, type ToolCallProps } from '@superego/app/ui'
import { CaretLeftIcon, CaretRightIcon, ImageBrokenIcon } from '@superego/ui'
import { about, TOOL, type ShowDetails, type Shown } from './shared.ts'
import './styles.css'

export default defineUiExtension({
  ...about,
  setup(superego) {
    superego.tool(TOOL, ShownImages, { fold: false })
  },
})

function ShownImages({ machine, thread, call, result }: ToolCallProps) {
  const [open, setOpen] = useState<number>()
  if (result?.isError) {
    return (
      <div className="images images--failed">
        <div className="images__failed"><ImageBrokenIcon size={14} aria-hidden /><span>Couldn’t show {Array.isArray(call.arguments.images) && call.arguments.images.length === 1 ? 'the image' : 'images'}</span></div>
        <div className="images__error">{result.text}</div>
      </div>
    )
  }
  const details = result?.details as ShowDetails | undefined
  if (!details?.images?.length) {
    // Being checked: a quiet line, until it's shown (or says why not).
    return result ? null : <div className="images images--pending"><span className="images__placeholder" aria-label="Loading images" /></div>
  }
  const { images, layout, title } = details
  const props = { machine, thread: thread.id, images, onOpen: setOpen }
  return (
    <figure className={`images images--${layout}`} aria-label={title ?? (images.length === 1 ? describeImage(images[0]!) : `${images.length} images`)}>
      {title && <figcaption className="images__title">{title}</figcaption>}
      {layout === 'carousel' && images.length > 1 ? <Carousel {...props} />
        : layout === 'grid' && images.length > 1 ? <Grid {...props} />
        : <div className="images__stack">{images.map((image, index) => <Single key={index} {...props} image={image} index={index} />)}</div>}
      {open !== undefined && <Lightbox machine={machine} thread={thread.id} images={images} start={open} onClose={() => setOpen(undefined)} />}
    </figure>
  )
}

type Props = { machine: MachineEntry; thread: string; images: Shown[]; onOpen(index: number): void }

/** One image, as big as the column allows up to its own size and a height, keeping its shape. */
function Single({ image, index, ...props }: Props & { image: Shown; index: number }) {
  const ratio = image.width && image.height ? image.width / image.height : undefined
  const tall = ratio !== undefined && 1 / ratio > TALL
  const style: CSSProperties | undefined = !ratio ? undefined
    : tall ? { aspectRatio: `${image.width} / ${image.height}`, width: `min(100%, ${image.width}px)`, maxHeight: 'var(--images-max-height)' }
    : { aspectRatio: `${image.width} / ${image.height}`, width: `min(100%, ${image.width}px, calc(var(--images-max-height) * ${ratio.toFixed(4)}))` }
  return (
    <div className="images__item">
      <Picture {...props} image={image} index={index} fit="contain" className="images__frame--single" style={style} cropTall />
      {image.caption && <div className="images__caption">{image.caption}</div>}
    </div>
  )
}

/** A few, side by side in even cells. */
function Grid(props: Props) {
  const { images } = props
  const columns = images.length === 3 || images.length > 4 ? 3 : 2
  return (
    <div className="images__grid" style={{ '--images-columns': columns } as CSSProperties}>
      {images.map((image, index) => (
        <div key={index} className="images__item">
          <Picture {...props} image={image} index={index} fit="cover" className="images__frame--cell" />
          {image.caption && <div className="images__caption">{image.caption}</div>}
        </div>
      ))}
    </div>
  )
}

/** Many, one at a time: a strip that snaps, moved by its buttons, its dots, ←/→ when focused, or a swipe. */
function Carousel(props: Props) {
  const { images } = props
  const track = useRef<HTMLDivElement>(null)
  const [at, setAt] = useState(0)
  const go = (index: number) => {
    const element = track.current
    if (!element) return
    const next = Math.max(0, Math.min(images.length - 1, index))
    const smooth = document.visibilityState === 'visible' && !window.matchMedia('(prefers-reduced-motion: reduce)').matches
    element.scrollTo({ left: next * element.clientWidth, behavior: smooth ? 'smooth' : 'auto' })
    setAt(next)
  }
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return
    const by = event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : 0
    if (!by) return
    event.preventDefault()
    event.stopPropagation()
    go(at + by)
  }
  const caption = images[at]?.caption
  // As tall as the widest of them needs at this width (up to a height); the others sit in it, letterboxed.
  const ratios = images.flatMap((i) => i.width && i.height ? [i.width / i.height] : [])
  const ratio = Math.min(2.4, Math.max(1, ...(ratios.length ? ratios : [1.6])))
  return (
    <div className="images__carousel" role="region" aria-roledescription="carousel" aria-label="Images, one at a time" tabIndex={0} onKeyDown={onKeyDown}>
      <div className="images__viewport">
        <div ref={track} className="images__track" onScroll={(e) => { const el = e.currentTarget; if (el.clientWidth) setAt(Math.round(el.scrollLeft / el.clientWidth)) }}>
          {images.map((image, index) => (
            <div key={index} className="images__slide" role="group" aria-roledescription="slide" aria-label={`${index + 1} of ${images.length}`} aria-hidden={index !== at}>
              {/* The one shown and its neighbours are read; the rest wait their turn. */}
              <Picture {...props} image={image} index={index} fit="contain" className="images__frame--slide" style={{ aspectRatio: ratio.toFixed(4) }} wanted={Math.abs(index - at) <= 1} tabIndex={index === at ? 0 : -1} />
            </div>
          ))}
        </div>
        <button type="button" className="images__nav images__nav--prev" aria-label="Previous image" disabled={at === 0} onClick={() => go(at - 1)}><CaretLeftIcon size={16} weight="bold" aria-hidden /></button>
        <button type="button" className="images__nav images__nav--next" aria-label="Next image" disabled={at === images.length - 1} onClick={() => go(at + 1)}><CaretRightIcon size={16} weight="bold" aria-hidden /></button>
      </div>
      <div className="images__under">
        <div className="images__caption images__caption--carousel">{caption}</div>
        {images.length <= 12 && (
          <div className="images__dots">
            {images.map((_, index) => (
              <button key={index} type="button" tabIndex={-1} className={`images__dot ${index === at ? 'is-current' : ''}`} aria-label={`Image ${index + 1}`} aria-current={index === at} onClick={() => go(index)} />
            ))}
          </div>
        )}
        <span className="images__count" aria-live="polite">{at + 1} / {images.length}</span>
      </div>
    </div>
  )
}

/**
 * An image as a button that opens the lightbox (the app's own frame: read as it nears the screen, broken when it can't
 * be; on the web, held until it's pressed, which loads all of these).
 */
function Picture({ machine, thread, images, image, index, onOpen, fit, className, style, wanted = true, tabIndex, cropTall = false }: Props & {
  image: Shown
  index: number
  fit: 'contain' | 'cover'
  className: string
  style?: CSSProperties
  wanted?: boolean
  tabIndex?: number
  cropTall?: boolean
}) {
  return (
    <ImageFrame machine={machine} thread={thread} image={image} onOpen={() => onOpen(index)} className={`images__frame ${className}`}
      imgClassName={`images__img images__img--${fit}`} style={style} wanted={wanted} tabIndex={tabIndex} near={nearFrom} cropTall={cropTall}
      onLoadWeb={() => loadWebImages(images.flatMap((shown) => shown.url ? [shown.url] : []))} />
  )
}

/** What scrolls an image here: the thread, not a carousel's own strip. */
const nearFrom = (element: Element) => element.closest('.images')?.parentElement
