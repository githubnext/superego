// Inspect mode: every view, slot, pane and space drawn gets an outline in its extension's colour; hovering one reads what
// it is, clicking pastes its identifier into the thread's composer (⌥Click, or with no thread: onto the clipboard).
//
// Each place the window draws one of them wraps it in `Inspected`. Off, that is nothing: no element, no work. On, it
// puts a pair of empty markers (`<template>`, which draws nothing) around what it drew, and the layer measures what's
// between each pair, so no extension and no layout needs to know.
import { useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { Pane } from '@superego/protocol'
import type { Owner, Registry, Where } from './registry.tsx'
import { paneKind } from './lookups.ts'
import { useRegistry } from './registry.tsx'
import { copyText } from './copy-text.ts'
import { insertInComposer } from './composer-items.ts'

// ── Whether it's on: the window's, outside any component, so what's drawn only pays for it while it is.
let on = false
const listeners = new Set<() => void>()
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }
/** Turn Inspect mode on or off (toggled, unless `to` is given). */
export function toggleInspect(to = !on) {
  if (to === on) return
  on = to
  for (const listener of listeners) listener()
}
/** Whether Inspect mode is on, as it changes. */
export const useInspecting = () => useSyncExternalStore(subscribe, () => on)

// ── What's drawn, as each place says.
export type InspectKind = 'view' | 'slot' | 'pane' | 'space'
export type InspectInfo = {
  kind: InspectKind
  /** A view's id, a pane's or space's kind, a slot's name. */
  id: string
  title: string
  owner: Owner
  /** Where it's drawn now: a view's place, `main` for a space. */
  place?: string
  /** The places a view fits. */
  fits?: readonly string[]
  context?: string
  params?: unknown
}

/** What goes in the composer for it: its identifier, as code; a slot with its extension, which fills it. */
export const identifierOf = (info: InspectInfo) => info.kind === 'slot' ? `\`${info.owner.extension}\` (\`${info.id}\`)` : `\`${info.id}\``

/** The info of a view drawn in `place`. */
export const viewInfo = (view: Registry['views'][number], place: string): InspectInfo => ({
  kind: 'view', id: view.id, title: view.title, owner: view.owner, place, fits: view.fits, context: view.context,
})

/** The info of the pane `pane` is, in the thread `where`: its kind's, and the owner of that. */
export function paneInfo(registry: Registry, pane: Pane, title: string, where: Where): InspectInfo {
  const kind = paneKind(registry, pane.kind, where)
  return { kind: 'pane', id: pane.kind, title, owner: kind?.owner ?? CORE, place: 'pane', params: pane.params }
}

/** The info of a space of `entry`'s kind, `title` now, drawn at `place`. */
export const spaceInfo = (entry: Registry['spaces'][number], title: string, params: unknown, place: string): InspectInfo =>
  ({ kind: 'space', id: entry.kind, title, owner: entry.owner, place, params })

const CORE: Owner = { extension: 'core', optional: false }

const infoOf = new WeakMap<Element, () => InspectInfo>()

/**
 * Draws `children` as they are; in Inspect mode they're what's outlined, as `info` says (asked only then). The markers
 * come and go around them, so what they draw keeps its state.
 */
export function Inspected({ info, children }: { info: () => InspectInfo; children: ReactNode }) {
  const inspecting = useInspecting()
  const id = useId()
  return (
    <>
      {inspecting && <template data-inspect-start={id} ref={(el) => { if (el) infoOf.set(el, info) }} />}
      {children}
      {inspecting && <template data-inspect-end={id} />}
    </>
  )
}

// ── Colours: one family per extension, as a hue the styles turn into an outline that reads in light and dark.
const HUES: Record<string, number> = { core: 205, threads: 255, git: 45, 'mcp-servers': 305, worktrees: 150, focus: 85, ego: 345 }
/** An extension's hue: a fixed one for those the app ships, else spread by its name. */
export function hueOf(extension: string): number {
  const fixed = HUES[extension]
  if (fixed !== undefined) return fixed
  let hash = 0
  for (const char of extension) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  return (hash * 137.508) % 360
}

// ── Measuring.
type Rect = { left: number; top: number; right: number; bottom: number }
export type Box = { key: string; info: InspectInfo; rect: Rect; hue: number }

const union = (a: Rect | undefined, b: Rect | undefined): Rect | undefined =>
  !a ? b : !b ? a : { left: Math.min(a.left, b.left), top: Math.min(a.top, b.top), right: Math.max(a.right, b.right), bottom: Math.max(a.bottom, b.bottom) }
const meet = (a: Rect, b: Rect): Rect | undefined => {
  const r = { left: Math.max(a.left, b.left), top: Math.max(a.top, b.top), right: Math.min(a.right, b.right), bottom: Math.min(a.bottom, b.bottom) }
  return r.right > r.left && r.bottom > r.top ? r : undefined
}
const asRect = (r: DOMRect): Rect | undefined => r.width > 0 && r.height > 0 ? { left: r.left, top: r.top, right: r.right, bottom: r.bottom } : undefined

/** Where a node is drawn: an element's box (through those without one of their own, `display: contents`), or its text's. */
function rectOf(node: Node): Rect | undefined {
  if (node instanceof Element) {
    const style = getComputedStyle(node)
    if (style.display === 'none' || style.visibility === 'hidden') return undefined
    if (style.display === 'contents') return [...node.childNodes].reduce<Rect | undefined>((all, child) => union(all, rectOf(child)), undefined)
    return asRect(node.getBoundingClientRect())
  }
  if (node.nodeType === Node.TEXT_NODE && node.textContent?.trim()) {
    const range = document.createRange()
    range.selectNodeContents(node)
    return typeof range.getBoundingClientRect === 'function' ? asRect(range.getBoundingClientRect()) : undefined
  }
  return undefined
}

/** What an ancestor that clips (scrolls, hides overflow) shows of a box. */
function clipped(rect: Rect, from: Element | null): Rect | undefined {
  let shown: Rect | undefined = meet(rect, { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight })
  for (let el = from; el && shown && el !== document.body && el !== document.documentElement; el = el.parentElement) {
    const { overflowX, overflowY } = getComputedStyle(el)
    if (/(hidden|auto|scroll|clip)/.test(overflowX + overflowY)) {
      const clip = asRect(el.getBoundingClientRect())
      shown = clip && meet(shown, clip)
    }
  }
  return shown
}

/** Every region drawn now, the largest first, so a smaller one inside it is drawn over it. */
export function measure(): Box[] {
  const boxes: Box[] = []
  for (const start of document.querySelectorAll('template[data-inspect-start]')) {
    const info = infoOf.get(start)?.()
    const id = start.getAttribute('data-inspect-start')
    if (!info || id === null) continue
    let rect: Rect | undefined
    for (let node = start.nextSibling; node && !(node instanceof Element && node.getAttribute('data-inspect-end') === id); node = node.nextSibling) rect = union(rect, rectOf(node))
    const shown = rect && clipped(rect, start.parentElement)
    if (shown && shown.right - shown.left >= 4 && shown.bottom - shown.top >= 4) boxes.push({ key: id, info, rect: shown, hue: hueOf(info.owner.extension) })
  }
  const area = ({ rect }: Box) => (rect.right - rect.left) * (rect.bottom - rect.top)
  return boxes.sort((a, b) => area(b) - area(a))
}

// ── What the sheet says.
const KINDS: Record<InspectKind, string> = { view: 'View', slot: 'Slot', pane: 'Pane', space: 'Space' }

/** Where it came from, when that says something: a profile's. */
function originOf(owner: Owner): string | undefined {
  if (owner.global !== undefined) return `Global profile · ${owner.global}`
  if (owner.project) return `Project profile · ${owner.project.profile}`
  return owner.profile !== undefined ? 'Profile' : undefined
}

const compact = (params: unknown): string | undefined => {
  if (!params || typeof params !== 'object' || !Object.keys(params).length) return undefined
  const text = JSON.stringify(params)
  return text.length > 90 ? `${text.slice(0, 89)}…` : text
}

/** The rows of the sheet, as label and value. */
export function rowsOf(info: InspectInfo, registry: Registry): [string, string][] {
  const { owner } = info
  const version = registry.extensions.find((e) => e.name === owner.extension)?.version
  const rows: [string, string | undefined][] = [
    ['Extension', version ? `${owner.extension} · ${version}` : owner.extension],
    ['Kind', owner.data ? `${KINDS[info.kind]} · data` : KINDS[info.kind]],
    ['Origin', originOf(owner)],
    ['Place', info.place],
    ['Fits', info.fits?.join(', ')],
    ['Context', info.context],
    ['Params', compact(info.params)],
  ]
  return rows.filter((row): row is [string, string] => Boolean(row[1]))
}

/** Where the sheet goes: beside the region (right, left, below, above) where it fits, else by the pointer; inside the window. */
export function sheetAt(rect: Rect, size: { width: number; height: number }, pointer: { x: number; y: number }, view = { width: window.innerWidth, height: window.innerHeight }): { left: number; top: number } {
  const gap = 10, edge = 8
  const clamp = (n: number, max: number) => Math.max(edge, Math.min(n, max - edge))
  const centered = { left: clamp(rect.left, view.width - size.width), top: clamp(rect.top, view.height - size.height) }
  const sides = [
    { fits: rect.right + gap + size.width <= view.width - edge, left: rect.right + gap, top: centered.top },
    { fits: rect.left - gap - size.width >= edge, left: rect.left - gap - size.width, top: centered.top },
    { fits: rect.bottom + gap + size.height <= view.height - edge, left: centered.left, top: rect.bottom + gap },
    { fits: rect.top - gap - size.height >= edge, left: centered.left, top: rect.top - gap - size.height },
  ]
  const side = sides.find((s) => s.fits)
  if (side) return { left: side.left, top: side.top }
  return { left: clamp(pointer.x + 14, view.width - size.width), top: clamp(pointer.y + 14, view.height - size.height) }
}

type Told = { text: string; failed?: boolean }

/**
 * The layer over the window while Inspect mode is on: an outline per region, the sheet of the one under the pointer,
 * and the pill that says so. `where` is the thread whose composer a click pastes into; none, it copies.
 */
export function InspectLayer({ where }: { where: { machine: string; thread: string } | undefined }) {
  const registry = useRegistry()
  const [boxes, setBoxes] = useState<Box[]>([])
  const [hover, setHover] = useState<{ key: string; x: number; y: number }>()
  const [told, setTold] = useState<Told>()
  const sheet = useRef<HTMLDivElement>(null)
  const [at, setAt] = useState<{ left: number; top: number }>()

  // Kept to what's drawn as it changes: the window resized, something scrolled or moved, the DOM changed.
  useLayoutEffect(() => {
    let frame = 0
    let last = ''
    const run = () => {
      frame = 0
      const next = measure()
      const key = JSON.stringify(next.map((b) => [b.key, b.rect, b.info]))
      if (key !== last) { last = key; setBoxes(next) }
    }
    const schedule = () => { if (!frame) frame = requestAnimationFrame(run) }
    run()
    const watcher = new MutationObserver((records) => {
      if (records.some((r) => !(r.target instanceof Element && r.target.closest('.inspect-layer')))) schedule()
    })
    watcher.observe(document.body, { childList: true, subtree: true, attributes: true, characterData: true })
    window.addEventListener('resize', schedule)
    window.addEventListener('scroll', schedule, true)
    window.addEventListener('transitionend', schedule, true)
    return () => {
      if (frame) cancelAnimationFrame(frame)
      watcher.disconnect()
      window.removeEventListener('resize', schedule)
      window.removeEventListener('scroll', schedule, true)
      window.removeEventListener('transitionend', schedule, true)
    }
  }, [])

  // Esc leaves it, before anything under it hears (an agent turn stopped, a menu closed).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      toggleInspect(false)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  useEffect(() => {
    if (!told) return
    const timer = setTimeout(() => setTold(undefined), 1600)
    return () => clearTimeout(timer)
  }, [told])

  const hovered = boxes.find((b) => b.key === hover?.key)
  useLayoutEffect(() => {
    if (!hovered || !hover || !sheet.current) return setAt(undefined)
    setAt(sheetAt(hovered.rect, { width: sheet.current.offsetWidth, height: sheet.current.offsetHeight }, hover))
  }, [hovered, hover?.x, hover?.y])

  const pick = (box: Box, event: React.MouseEvent) => {
    const text = identifierOf(box.info)
    if (where && !event.altKey) {
      insertInComposer(where, text)
      toggleInspect(false)
      return
    }
    copyText(text).then(() => setTold({ text: 'Copied' })).catch((error) => {
      console.error(`Copying ${text}`, error)
      setTold({ text: `Couldn't copy: ${(error as Error).message}`, failed: true })
    })
  }

  const over = (event: React.MouseEvent) => {
    const key = (event.target as Element).closest<HTMLElement>('[data-inspect-box]')?.dataset.inspectBox
    setHover(key ? { key, x: event.clientX, y: event.clientY } : undefined)
  }

  return createPortal(
    <div className={`inspect-layer ${hovered ? 'has-hover' : ''}`} onMouseOver={over} onMouseMove={over} onMouseLeave={() => setHover(undefined)}>
      {boxes.map(({ key, info, rect, hue }) => (
        <div key={key} data-inspect-box={key} data-inspect-id={info.id} data-inspect-kind={info.kind}
          className={`inspect-box ${key === hover?.key ? 'is-hovered' : ''}`}
          style={{ left: rect.left, top: rect.top, width: rect.right - rect.left, height: rect.bottom - rect.top, '--ins-hue': hue } as CSSProperties}
          onClick={(event) => pick({ key, info, rect, hue }, event)} />
      ))}
      {hovered && (
        <div ref={sheet} className="inspect-sheet" role="tooltip" style={{ left: at?.left ?? 0, top: at?.top ?? 0, visibility: at ? 'visible' : 'hidden', '--ins-hue': hovered.hue } as CSSProperties}>
          <div className="inspect-sheet__head">
            <i className="inspect-sheet__dot" aria-hidden />
            <span className="inspect-sheet__title">{hovered.info.title}</span>
            {hovered.info.kind !== 'slot' && <code className="inspect-sheet__id">{hovered.info.id}</code>}
          </div>
          <dl className="inspect-sheet__rows">
            {rowsOf(hovered.info, registry).map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
          </dl>
          <p className="inspect-sheet__hint">{where ? 'Click to paste in chat · ⌥Click to copy' : 'Click to copy'}</p>
        </div>
      )}
      <div className="inspect-pill" role="status">
        <span className={told?.failed ? 'is-failed' : ''} role={told?.failed ? 'alert' : undefined}>{told?.text ?? 'Inspecting'}</span>
        <button type="button" className="inspect-pill__done" onClick={() => toggleInspect(false)}>Done <kbd>Esc</kbd></button>
      </div>
    </div>,
    document.body,
  )
}
