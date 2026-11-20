// The element picker, run in a Browser pane's page (its WebView's `run`): its source alone goes there, so each function
// here is whole in itself, using nothing from outside it. While it picks, a layer of its own covers the page (in a
// closed shadow root, so no CSS reaches in or out): the pointer over it finds the element under it, outlined in the
// accent and labelled with its tag, classes and size; a click picks it, Esc cancels, ↑ goes to its parent and ↓ back.
// The page hears no click, nor any of those keys. Done, every trace of it is gone from the page.

/** What's told of an element picked: enough for the agent to find it in the source and change it. */
export type Picked = {
  /** The page it's in, and its title. */
  url: string
  title: string
  /** A CSS selector that finds it, and nothing else, in its page: as short as that allows. */
  selector: string
  /** Its tag, and its id or first class with it, as the chip says it: `<button.primary>`. */
  label: string
  /** Its opening tag, with its key attributes (values cut short). */
  opening: string
  /** Its text, its spaces collapsed, cut short. */
  text: string
  /** Its outer HTML, cut at `htmlLimit` (at a tag's end); `htmlSize`: how long it was whole. */
  html: string
  htmlSize: number
  /** Its box where it's drawn, in the page's CSS pixels; and the viewport's size. */
  box: { x: number; y: number; width: number; height: number }
  viewport: { width: number; height: number }
  /** Its computed styles that say how it looks and sits: font, colours, spacing, its box. */
  styles: Record<string, string>
}

export type PickOptions = {
  /** The outline's colour: the app's accent, as a CSS colour. */
  accent: string
  /** How much of its outer HTML to keep, in characters. */
  htmlLimit: number
}

/**
 * Pick an element in `win`'s page: what it is once one's clicked (or Return pressed), or null once cancelled (Esc, or
 * `cancelPick`). One picking at a time: a second cancels the first. Answers once its layer is off the page (a frame
 * drawn without it), so a capture of the element then is of the page alone.
 */
export function pick(win: Window, options: PickOptions): Promise<Picked | null> {
  const KEY = Symbol.for('superego.picker')
  const held = win as unknown as Record<symbol, ((picked: null) => void) | undefined>
  held[KEY]?.(null)
  const doc = win.document
  const css = (win as Window & typeof globalThis).CSS as typeof CSS | undefined
  const esc = (text: string) => typeof css?.escape === 'function' ? css.escape(text) : text.replace(/[^\w-]/g, (c) => `\\${c}`)
  const unique = (selector: string) => {
    try { return doc.querySelectorAll(selector).length === 1 } catch { return false }
  }
  /** Classes that say what it is: plain words, not a utility's variants (`hover:bg-x`) or a hash. */
  const named = (el: Element) => [...el.classList].filter((c) => /^[a-zA-Z_-][\w-]*$/.test(c) && c.length <= 32).slice(0, 2)
  const segment = (el: Element) => el.localName + named(el).map((c) => `.${esc(c)}`).join('')

  /** The shortest selector, from the element up, that finds it alone: by an id, a test id, a name, else its path. */
  const selectorOf = (el: Element): string => {
    if (el.id && unique(`#${esc(el.id)}`)) return `#${esc(el.id)}`
    for (const attr of ['data-testid', 'data-test', 'data-cy', 'name', 'aria-label']) {
      const value = el.getAttribute(attr)
      if (!value || value.length > 60) continue
      const selector = `${el.localName}[${attr}="${value.replace(/["\\]/g, (c) => `\\${c}`)}"]`
      if (unique(selector)) return selector
    }
    const parts: string[] = []
    for (let node: Element | null = el; node; node = node.parentElement) {
      if (node !== el && node.id && unique(`#${esc(node.id)}`)) {
        parts.unshift(`#${esc(node.id)}`)
        break
      }
      let part = segment(node)
      parts.unshift(part)
      if (unique(parts.join(' > '))) break
      const parent: Element | null = node.parentElement
      if (parent && [...parent.children].filter((c) => c.matches(part)).length > 1) {
        const index = [...parent.children].filter((c) => c.localName === node!.localName).indexOf(node) + 1
        part = `${part}:nth-of-type(${index})`
        parts[0] = part
        if (unique(parts.join(' > '))) break
      }
    }
    return parts.join(' > ')
  }
  const labelOf = (el: Element) => `<${el.localName}${el.id ? `#${el.id}` : el.classList[0] ? `.${el.classList[0]}` : ''}>`
  const cut = (text: string, max: number) => text.length > max ? `${text.slice(0, max - 1)}…` : text
  const openingOf = (el: Element) => {
    const attrs = [...el.attributes].filter((a) => a.name !== 'style').slice(0, 8)
    return `<${el.localName}${attrs.map((a) => a.value ? ` ${a.name}="${cut(a.value, 80).replace(/"/g, '&quot;')}"` : ` ${a.name}`).join('')}>`
  }
  /** Four sides as CSS says them, as short as it allows: `8px 16px`. */
  const sides = (style: CSSStyleDeclaration, name: string, suffix = '') => {
    const [t, r, b, l] = ['top', 'right', 'bottom', 'left'].map((side) => style.getPropertyValue(`${name}-${side}${suffix}`))
    return t === r && r === b && b === l ? t! : t === b && r === l ? `${t} ${r}` : r === l ? `${t} ${r} ${b}` : `${t} ${r} ${b} ${l}`
  }
  const stylesOf = (el: Element): Record<string, string> => {
    const style = win.getComputedStyle(el)
    const styles: Record<string, string> = {}
    for (const name of ['display', 'position', 'font-family', 'font-size', 'font-weight', 'line-height', 'color', 'background-color']) {
      const value = style.getPropertyValue(name)
      if (value) styles[name] = value
    }
    for (const name of ['margin', 'padding']) styles[name] = sides(style, name)
    const border = style.getPropertyValue('border-top-width')
    if (border && border !== '0px') styles.border = `${sides(style, 'border', '-width')} ${style.getPropertyValue('border-top-style')} ${style.getPropertyValue('border-top-color')}`
    const radius = style.getPropertyValue('border-radius')
    if (radius && radius !== '0px') styles['border-radius'] = radius
    for (const name of ['gap', 'flex-direction', 'grid-template-columns']) {
      const value = style.getPropertyValue(name)
      if (value && value !== 'normal' && value !== 'none' && (name !== 'flex-direction' || /flex/.test(styles.display ?? ''))) styles[name] = value
    }
    return Object.fromEntries(Object.entries(styles).filter(([, value]) => value))
  }
  const describe = (el: Element): Picked => {
    const html = el.outerHTML
    let kept = html
    if (html.length > options.htmlLimit) {
      const end = html.lastIndexOf('>', options.htmlLimit)
      kept = html.slice(0, end > options.htmlLimit / 2 ? end + 1 : options.htmlLimit)
    }
    const r = el.getBoundingClientRect()
    return {
      url: win.location.href, title: doc.title, selector: selectorOf(el), label: labelOf(el), opening: openingOf(el),
      text: cut(((el as HTMLElement).innerText ?? el.textContent ?? '').replace(/\s+/g, ' ').trim(), 300),
      html: kept, htmlSize: html.length,
      box: { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) },
      viewport: { width: win.innerWidth, height: win.innerHeight },
      styles: stylesOf(el),
    }
  }

  // The layer: over the whole page, taking the pointer, so nothing under it hears it; drawn in a closed shadow root.
  const host = doc.createElement('superego-picker')
  host.setAttribute('style', 'all: initial !important; display: block !important; position: fixed !important; inset: 0 !important; z-index: 2147483647 !important; cursor: crosshair !important; pointer-events: auto !important')
  const root = host.attachShadow({ mode: 'closed' })
  const accent = /^[#\w(),.%\s/-]+$/.test(options.accent) ? options.accent : '#6e56cf'
  root.innerHTML = `<style>
    .box { position: fixed; display: none; box-sizing: border-box; border: 2px solid ${accent}; border-radius: 2px; background: color-mix(in srgb, ${accent} 14%, transparent); pointer-events: none; }
    .label { position: fixed; display: none; max-width: calc(100vw - 8px); box-sizing: border-box; padding: 2px 6px; border-radius: 4px; background: #1d1d21; color: #f4f4f5;
      font: 11px/16px ui-monospace, SFMono-Regular, Menlo, monospace; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; pointer-events: none; }
    .size { color: #a1a1aa; margin-left: 6px; }
  </style><div class="box"></div><div class="label"><span class="name"></span><span class="size"></span></div>`
  const box = root.querySelector<HTMLElement>('.box')!
  const label = root.querySelector<HTMLElement>('.label')!
  doc.documentElement.append(host)

  let current: Element | null = null
  /** Where ↓ goes back to: the elements ↑ came up from. */
  const below: Element[] = []
  const show = (el: Element | null) => {
    current = el
    if (!el) {
      box.style.display = label.style.display = 'none'
      return
    }
    const r = el.getBoundingClientRect()
    Object.assign(box.style, { display: 'block', left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` })
    const classes = [...el.classList].slice(0, 3).map((c) => `.${c}`).join('')
    label.querySelector('.name')!.textContent = `${el.localName}${el.id ? `#${el.id}` : ''}${classes}`
    label.querySelector('.size')!.textContent = `${Math.round(r.width)} × ${Math.round(r.height)}`
    label.style.display = 'block'
    const height = 20
    const top = r.top >= height + 4 ? r.top - height - 4 : r.bottom + 4 + height <= win.innerHeight ? r.bottom + 4 : Math.max(r.top, 0) + 4
    Object.assign(label.style, { top: `${top}px`, left: `${Math.min(Math.max(r.left, 4), Math.max(4, win.innerWidth - label.offsetWidth - 4))}px` })
  }
  const under = (x: number, y: number) => (typeof doc.elementsFromPoint === 'function' ? doc.elementsFromPoint(x, y) : []).find((el) => el !== host && !host.contains(el)) ?? null

  const swallow = (event: Event) => {
    event.preventDefault()
    event.stopImmediatePropagation()
  }
  const onPointer = (event: Event) => {
    if (event.target !== host) return
    swallow(event)
    const { clientX, clientY } = event as MouseEvent
    if (event.type === 'pointermove' || event.type === 'mousemove') {
      const el = under(clientX, clientY)
      if (el !== current) {
        below.length = 0
        show(el)
      }
    } else if (event.type === 'click') {
      const el = current ?? under(clientX, clientY)
      if (el) finish(el)
    }
  }
  const onKey = (event: KeyboardEvent) => {
    if (event.key === 'Escape') { swallow(event); finish(null) }
    else if (event.key === 'Enter' && current) { swallow(event); finish(current) }
    else if (event.key === 'ArrowUp' && current?.parentElement) {
      swallow(event)
      below.push(current)
      show(current.parentElement)
    } else if (event.key === 'ArrowDown' && current) {
      swallow(event)
      const next = below.pop() ?? current.firstElementChild
      if (next) show(next)
    }
  }
  const onMove = () => { if (current) show(current) }
  const POINTER = ['pointermove', 'mousemove', 'pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click', 'dblclick', 'auxclick', 'contextmenu']
  for (const name of POINTER) win.addEventListener(name, onPointer, true)
  win.addEventListener('keydown', onKey, true)
  win.addEventListener('scroll', onMove, true)
  win.addEventListener('resize', onMove)

  let settle: (picked: Picked | null) => void = () => {}
  function finish(el: Element | null) {
    if (held[KEY] !== cancel) return
    delete held[KEY]
    for (const name of POINTER) win.removeEventListener(name, onPointer, true)
    win.removeEventListener('keydown', onKey, true)
    win.removeEventListener('scroll', onMove, true)
    win.removeEventListener('resize', onMove)
    const picked = el && describe(el)
    host.remove()
    if (!picked) return settle(null)
    // Once a frame's drawn without the layer (or a moment, where frames don't come: a hidden page).
    let done = false
    const answer = () => { if (!done) { done = true; settle(picked) } }
    win.requestAnimationFrame(() => win.requestAnimationFrame(answer))
    win.setTimeout(answer, 200)
  }
  const cancel = () => finish(null)
  held[KEY] = cancel
  return new Promise((resolve) => { settle = resolve })
}

/** Stop picking in `win`'s page, if it is: its `pick` answers null. */
export function cancelPick(win: Window): void {
  const held = win as unknown as Record<symbol, ((picked: null) => void) | undefined>
  held[Symbol.for('superego.picker')]?.(null)
}
