// @vitest-environment happy-dom
// A web view's still: kept on hand while the page is shown, so anything of the window's over it is above it at once,
// without waiting for a new still to be taken; before there's any, the page stays until the first is drawn.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BridgeWebView, WebViewRect } from '../src/shared/bridge.ts'
import { placeView, type Placer, type Still } from '../src/renderer/web-view.tsx'

type Box = { x: number; y: number; width: number; height: number }
const boxes = new WeakMap<Element, Box>()
const at = (el: Element, box: Box) => boxes.set(el, box)

let placed: [WebViewRect | null, boolean][]
let snapshots: { resolve(bytes: Uint8Array | null): void }[]
let shown: (Still | undefined)[]
let placer: Placer | undefined

const view = (): BridgeWebView => ({
  place: (rect, show) => { placed.push([rect, show]) },
  snapshot: () => new Promise((resolve) => { snapshots.push({ resolve }) }),
  load: () => {}, go: () => {}, reload: () => {}, stop: () => {}, focus: () => {}, run: async () => undefined, capture: async () => null,
  reveal: () => {}, answer: () => {}, onEvent: () => {}, close: () => {},
})
let decoded = 0
const decode = async () => ({ url: `still-${++decoded}`, width: 400 })
const last = () => placed.at(-1)
const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))

beforeEach(() => {
  placed = []
  snapshots = []
  shown = []
  document.body.innerHTML = ''
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const { x, y, width, height } = boxes.get(this) ?? { x: 0, y: 0, width: 0, height: 0 }
    return { x, y, width, height, left: x, top: y, right: x + width, bottom: y + height, toJSON: () => ({}) } as DOMRect
  })
  Element.prototype.checkVisibility ??= () => true
  vi.spyOn(Element.prototype, 'checkVisibility').mockReturnValue(true)
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
})
afterEach(() => {
  placer?.stop()
  placer = undefined
  vi.restoreAllMocks()
})

function open() {
  const host = document.createElement('div')
  at(host, { x: 100, y: 50, width: 400, height: 300 })
  document.body.append(host)
  placer = placeView(host, view(), (still) => { shown.push(still) }, () => false, decode)
  return host
}
function cover() {
  const menu = document.createElement('div')
  menu.className = 'superego-layer'
  at(menu, { x: 300, y: 100, width: 120, height: 80 })
  document.body.append(menu)
}

describe('a web view covered by the window', () => {
  it('goes at once, a still of a moment ago in its place, and takes a fresh one', async () => {
    open()
    await vi.waitFor(() => expect(last()).toEqual([expect.objectContaining({ x: 100, y: 50 }), true]))
    // The page came to rest: a still of it, kept under it.
    placer!.settled()
    await vi.waitFor(() => expect(snapshots).toHaveLength(1))
    snapshots[0]!.resolve(new Uint8Array([1]))
    await vi.waitFor(() => expect(shown).toHaveLength(1))
    const kept = shown[0]!.url
    expect(last()![1]).toBe(true)

    cover()
    await frame()
    await frame()
    // Hidden without waiting for the still being taken now.
    expect(last()).toEqual([expect.objectContaining({ x: 100, y: 50 }), false])
    expect(snapshots).toHaveLength(2)
    expect(shown.at(-1)?.url).toBe(kept)
    snapshots[1]!.resolve(new Uint8Array([2]))
    await vi.waitFor(() => expect(shown).toHaveLength(2))
    expect(shown[1]!.url).not.toBe(kept)
  })

  it('with no still yet, stays until the first is drawn', async () => {
    open()
    await vi.waitFor(() => expect(last()?.[1]).toBe(true))
    cover()
    await vi.waitFor(() => expect(snapshots).toHaveLength(1))
    await frame()
    await frame()
    expect(last()![1]).toBe(true)
    snapshots[0]!.resolve(new Uint8Array([1]))
    await vi.waitFor(() => expect(last()![1]).toBe(false))
    expect(shown.at(-1)).toBeDefined()
  })
})
