// ⌃D / ⌃U, after Tremolo: what has the focus scrolls half a page down or up, animated (150ms, easing out). Presses in
// a row add up from where the last is headed; the wheel or a touch takes over at once.

/** What a press scrolls: the nearest scrollable thing around the focus, else the thread's transcript. */
function scrollerOf(focus: Element | null): HTMLElement | null {
  // From the prompt, the transcript it's under.
  const start = focus?.closest('.dock')?.parentElement?.querySelector(':scope > .thread__scroll') ?? focus
  for (let el = start; el && el !== document.body; el = el.parentElement) {
    if (!(el instanceof HTMLElement) || el.scrollHeight <= el.clientHeight + 1) continue
    const overflow = getComputedStyle(el).overflowY
    if (overflow === 'auto' || overflow === 'scroll') return el
  }
  // Nothing scrolls around the focus (a pane's own bar, say): the biggest thing that does in its column.
  const column = start?.closest('[data-column]')
  const inColumn = column && [...column.querySelectorAll<HTMLElement>('*')]
    .filter((el) => el.scrollHeight > el.clientHeight + 1 && /auto|scroll/.test(getComputedStyle(el).overflowY))
    .sort((a, b) => b.clientHeight - a.clientHeight)[0]
  return inColumn || document.querySelector<HTMLElement>('.app__main [data-column="thread"] .thread__scroll, .app__main .thread__scroll')
}

let running: { el: HTMLElement; frame: number; to: number } | undefined
const stop = () => { if (running) cancelAnimationFrame(running.frame); running = undefined }
let listening = false

export function scrollHalfPage(direction: -1 | 1) {
  if (!listening) {
    listening = true
    addEventListener('wheel', stop, { passive: true })
    addEventListener('touchstart', stop, { passive: true })
  }
  const el = scrollerOf(document.activeElement)
  if (!el) return
  const from = running?.el === el ? running.to : el.scrollTop
  stop()
  const to = Math.max(0, Math.min(from + direction * el.clientHeight / 2, el.scrollHeight - el.clientHeight))
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) { el.scrollTop = to; return }
  const start = el.scrollTop
  const began = performance.now()
  const tick = (now: number) => {
    const t = Math.min(1, (now - began) / 150)
    el.scrollTop = start + (to - start) * t * (2 - t)
    if (t < 1 && running) running.frame = requestAnimationFrame(tick)
    else running = undefined
  }
  running = { el, to, frame: requestAnimationFrame(tick) }
}
