// @vitest-environment happy-dom
// A window's web views, kept by their pane: drawn again, a pane has its page as it was; only the most recently shown
// are kept; a closed pane's page goes.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BridgeWebView, WebViewEvent } from '../src/shared/bridge.ts'

type Fake = BridgeWebView & { url: string; loads: string[]; reloads: number; closed: boolean; tell(event: WebViewEvent): void }

let opened: Fake[] = []
function fakeView(url: string): Fake {
  let listener: ((event: WebViewEvent) => void) | undefined
  const view: Fake = {
    url, loads: [url], reloads: 0, closed: false,
    place: () => {}, focus: () => {}, go: () => {}, reveal: () => {}, snapshot: async () => null,
    load: (to) => { view.loads.push(to) },
    reload: () => { view.reloads++ },
    onEvent: (next) => { listener = next },
    close: () => { view.closed = true },
    tell: (event) => listener?.(event),
  }
  opened.push(view)
  return view
}

async function load() {
  vi.resetModules()
  opened = []
  ;(window as unknown as { superego: unknown }).superego = { webView: ({ url }: { url: string }) => fakeView(url) }
  return import('../src/renderer/kept-web-views.ts')
}

const pane = (id: string) => ({ machine: 'local', thread: 't1', pane: id })
const at = (url: string) => ({ type: 'state', state: { url, title: '', loading: false, canGoBack: true, canGoForward: false } }) as const

describe('overCap', () => {
  it('closes the least recently shown beyond the cap, never one shown now', async () => {
    const { overCap } = await load()
    const views = [
      { key: 'a', shown: false, shownAt: 3 },
      { key: 'b', shown: true, shownAt: 1 },
      { key: 'c', shown: false, shownAt: 2 },
      { key: 'd', shown: false, shownAt: 4 },
    ]
    expect(overCap(views, 4)).toEqual([])
    expect(overCap(views, 3)).toEqual(['c'])
    expect(overCap(views, 2)).toEqual(['c', 'a'])
    expect(overCap(views, 0)).toEqual(['c', 'a', 'd'])
  })
})

describe('holdWebView', () => {
  beforeEach(() => { opened = [] })

  it("keeps a pane's page as it was when it's drawn again, and tells its last state", async () => {
    const { holdWebView } = await load()
    const first = holdWebView(pane('p'), { src: 'http://a/', partition: 'preview' }, () => {})
    opened[0]!.tell(at('http://a/next'))
    first.release()
    const events: WebViewEvent[] = []
    const again = holdWebView(pane('p'), { src: 'http://a/', partition: 'preview' }, (event) => events.push(event))
    expect(again.view).toBe(first.view)
    expect(opened).toHaveLength(1)
    expect(opened[0]!.loads).toEqual(['http://a/'])
    expect(events).toEqual([at('http://a/next')])
  })

  it('goes where its pane points it, and reloads as what it shows changes', async () => {
    const { holdWebView } = await load()
    const held = holdWebView(pane('p'), { src: 'http://a/', partition: 'preview', revision: '1' }, () => {})
    held.ask({ src: 'http://a/', partition: 'preview', revision: '1' })
    expect(opened[0]!.reloads).toBe(0)
    held.ask({ src: 'http://a/', partition: 'preview', revision: '2' })
    expect(opened[0]!.reloads).toBe(1)
    held.release()
    // Pointed elsewhere while it wasn't drawn: it goes there as it's drawn again.
    holdWebView(pane('p'), { src: 'http://b/', partition: 'preview', revision: '2' }, () => {})
    expect(opened[0]!.loads).toEqual(['http://a/', 'http://b/'])
  })

  it('keeps only the most recently shown, and opens one closed for room where it was', async () => {
    const { holdWebView, KEPT_WEB_VIEWS } = await load()
    for (let i = 0; i <= KEPT_WEB_VIEWS; i++) {
      const held = holdWebView(pane(`p${i}`), { src: `http://${i}/`, partition: 'preview' }, () => {})
      opened[i]!.tell(at(`http://${i}/moved`))
      held.release()
    }
    expect(opened.map((v) => v.closed)).toEqual([true, ...Array(KEPT_WEB_VIEWS).fill(false)])
    holdWebView(pane('p0'), { src: 'http://0/', partition: 'preview' }, () => {})
    expect(opened.at(-1)!.url).toBe('http://0/moved')
    // That one shown, the least recently shown of the rest went.
    expect(opened[1]!.closed).toBe(true)
  })

  it('never shares a view drawn twice at once, and closes a pane-less one as it goes', async () => {
    const { holdWebView } = await load()
    const one = holdWebView(pane('p'), { src: 'http://a/', partition: 'preview' }, () => {})
    const two = holdWebView(pane('p'), { src: 'http://a/', partition: 'preview' }, () => {})
    expect(two.view).not.toBe(one.view)
    two.release()
    expect(opened[1]!.closed).toBe(true)
    const alone = holdWebView(undefined, { src: 'http://c/', partition: 'artifact' }, () => {})
    alone.release()
    expect(opened[2]!.closed).toBe(true)
    expect(opened[0]!.closed).toBe(false)
  })

  it('closes the page of a pane that is gone, not of one not known yet', async () => {
    const { holdWebView, pruneWebViews } = await load()
    holdWebView(pane('gone'), { src: 'http://a/', partition: 'preview' }, () => {}).release()
    holdWebView(pane('unknown'), { src: 'http://b/', partition: 'preview' }, () => {}).release()
    const shown = holdWebView(pane('shown'), { src: 'http://c/', partition: 'preview' }, () => {})
    pruneWebViews((p) => p.pane === 'gone' ? false : p.pane === 'unknown' ? undefined : false)
    expect(opened.map((v) => v.closed)).toEqual([true, false, false])
    shown.release()
  })
})
