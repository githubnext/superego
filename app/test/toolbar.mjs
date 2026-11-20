// The Browser pane's toolbar, a web page's and an HTML file's (run by `test/look.sh <dir> toolbar`): a page with no history yet, one
// with history to go back, its address bar being typed in, the pane holding the keyboard (its "↩ to use the page"
// hint), a page loading (its line under the toolbar, its spinners, Stop), a page at Small and at Large (scaled to fit)
// with its size menu, an HTML file, and a blank page. Light and dark,
// each cropped to the pane's top, into $SUPEREGO_SHOWCASE_OUT.
import { webContents } from 'electron'
import { writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { openApp } from './harness.mjs'

const page = (title) => `<body style="margin:0;font:15px system-ui;padding:24px"><h1>${title}</h1><a href="/invoices/2024?draft=1">Next</a></body>`
// `/slow` never answers until the server closes: a page loading.
const held = []
// `/sized`: a page that says how wide it is, its layout one column when narrow.
const sized = `<body style="margin:0;font:15px system-ui"><style>main{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;padding:24px}div{height:80px;border-radius:8px;background:#e8e6f4}@media (max-width:600px){main{grid-template-columns:1fr}}</style><main><h1 style="grid-column:1/-1" id="w"></h1><div></div><div></div><div></div><div></div><div></div><div></div></main><script>const w=()=>document.getElementById('w').textContent=innerWidth+' px';w();addEventListener('resize',w)</script></body>`
const server = createServer((q, r) => { if (q.url === '/slow') return held.push(r); r.setHeader('content-type', 'text/html'); r.end(q.url === '/sized' ? sized : page(q.url)) }).listen(0)

await openApp({ name: 'toolbar', timeout: 180_000 }, async (t) => {
  const { run, until } = t
  await t.resize(1200, 640)
  const project = process.env.SUPEREGO_SHOWCASE_PROJECT
  writeFileSync(join(project, 'report.html'), page('Report'))
  const { id } = await run(`window.superego.call('local', 'thread.start', { cwd: ${JSON.stringify(project)}, title: 'Ledger' })`)
  await until(`[...document.querySelectorAll('.superego-list-item')].some((li) => li.textContent.includes('Ledger'))`, 'the thread listed')
  await run(`[...document.querySelectorAll('.superego-list-item')].find((li) => li.textContent.includes('Ledger')).click()`)
  await until(`document.querySelector('.thread__title')?.textContent === 'Ledger'`, 'the thread shown')
  await t.emulateFocus()

  // The pane's top: its tab and its toolbar, with a little of what's under it.
  const top = `(() => { const r = document.querySelector('.panes__column:has(.browser-frame)').getBoundingClientRect(); return { getBoundingClientRect: () => ({ x: r.x, y: r.y, width: r.width, height: 96 }) } })()`
  const both = async (name, before) => {
    for (const theme of ['light', 'dark']) {
      await t.theme(theme)
      if (before) await before()
      await t.shot(`toolbar-${name}-${theme}`, top)
    }
  }
  const address = `document.querySelector('.browser-address__text')?.textContent`
  const url = `http://localhost:${server.address().port}/`

  await run(`window.superego.call('local', 'pane.open', { thread: '${id}', kind: 'browser', params: { url: ${JSON.stringify(url)} } })`)
  await until(`${address} === ${JSON.stringify(url)}`, 'the page shown')
  await both('fresh')
  // A link followed: back is offered.
  const view = await until(() => webContents.getAllWebContents().find((w) => w.getURL() === url), 'the page\'s view')
  await view.loadURL(`${url}invoices/2024?draft=1`)
  await until(`${address}.endsWith('/invoices/2024?draft=1') && !document.querySelector('button[aria-label="Back"]').disabled`, 'back offered')
  await both('history')
  // The address bar clicked: a field, the address selected.
  await both('editing', async () => {
    if (!await run(`Boolean(document.querySelector('input.browser-address'))`)) await t.click('button.browser-address')
    await until(`document.activeElement?.matches('input.browser-address')`, 'the address bar a field')
  })
  await run(`document.querySelector('input.browser-address').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
  await until(`!document.querySelector('input.browser-address')`, 'the address bar a pill again')
  // The pane holding the keyboard: Return passes it to the page, and it says so.
  await both('hint', () => until(`(() => { const el = document.querySelector('.browser-frame .web-view'); el.focus({ preventScroll: true }); return Boolean(document.querySelector('.browser-hint')) })()`, 'the hint'))
  await run(`document.activeElement?.blur()`)
  // A page loading: its line part way, the spinner in place of the globe on its tab and in the address, Stop.
  // Not waited for: it never loads, and is stopped below, which rejects it (ERR_ABORTED), as expected.
  view.loadURL(`${url}slow`).catch(() => {})
  await until(`Boolean(document.querySelector('.browser-load:not(.is-done)')) && Boolean(document.querySelector('button[aria-label="Stop"]'))`, 'the page loading')
  await both('loading', () => new Promise((resolve) => setTimeout(resolve, 1500)))
  // Its tab in the title bar, the spinner in place of its globe.
  const tab = `(() => { const r = [...document.querySelectorAll('.strip__tab')].find((el) => el.querySelector('.browser-spinner')).getBoundingClientRect(); return { getBoundingClientRect: () => ({ x: r.x - 120, y: r.y - 8, width: r.width + 240, height: r.height + 16 }) } })()`
  for (const theme of ['light', 'dark']) {
    await t.theme(theme)
    await t.shot(`toolbar-loading-tab-${theme}`, tab)
  }
  for (const r of held.splice(0)) r.destroy()
  await run(`document.querySelector('button[aria-label="Stop"]')?.click()`)
  await until(`!document.querySelector('.browser-load')`, 'the page stopped')

  // At a size: Small, centred on its backdrop; Large, scaled down to fit; the size menu. The whole pane.
  const pane = `document.querySelector('.panes__column:has(.browser-frame)')`
  const browserPane = await run(`window.superego.call('local', 'thread.list', {}).then((l) => l.find((t) => t.id === '${id}').panes.at(-1).id)`)
  const resize = (viewport) => run(`window.superego.call('local', 'pane.update', { thread: '${id}', pane: '${browserPane}', params: { url: ${JSON.stringify(`${url}sized`)}, viewport: ${JSON.stringify(viewport)} } })`)
  const sizedView = () => webContents.getAllWebContents().find((w) => w.getURL() === `${url}sized`)
  await resize({ width: 390 })
  await until(async () => await sizedView()?.executeJavaScript('innerWidth') === 390, 'the page at Small')
  // The page is a view of its own over the window, not in its screenshots: drawn into its box for them, as its still is.
  const drawPage = async () => {
    // By DevTools' screenshot: a hidden window's views have no surface for capturePage.
    const debug = sizedView().debugger
    if (!debug.isAttached()) debug.attach()
    const { data } = await debug.sendCommand('Page.captureScreenshot', { format: 'png' })
    await run(`document.querySelector('.browser-frame .web-view').style.background = 'url(data:image/png;base64,${data}) 0 0 / 100% 100%'`)
  }
  for (const theme of ['light', 'dark']) {
    await t.theme(theme)
    await drawPage()
    await t.shot(`toolbar-small-${theme}`, pane)
  }
  await resize({ width: 1280 })
  await until(async () => await sizedView()?.executeJavaScript('innerWidth') === 1280 && await run(`Boolean(document.querySelector('.browser-size__scale'))`), 'the page at Large, scaled')
  for (const theme of ['light', 'dark']) {
    await t.theme(theme)
    await drawPage()
    await t.shot(`toolbar-large-${theme}`, pane)
  }
  await t.click('button[aria-label="Page size"]')
  await until(`Boolean(document.querySelector('.superego-menu [role^="menuitem"]'))`, 'the size menu')
  const menuShot = `(() => { const r = document.querySelector('.panes__column:has(.browser-frame)').getBoundingClientRect(); return { getBoundingClientRect: () => ({ x: r.x, y: r.y, width: r.width, height: 280 }) } })()`
  for (const theme of ['light', 'dark']) {
    await t.theme(theme)
    await t.shot(`toolbar-size-menu-${theme}`, menuShot)
  }
  await run(`document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)

  const preview = await run(`window.superego.call('local', 'thread.list', {}).then((l) => l.find((t) => t.id === '${id}').panes.at(-1).id)`)
  await run(`window.superego.call('local', 'pane.close', { thread: '${id}', pane: '${preview}' })`)
  await until(`!document.querySelector('.browser-frame')`, 'the web page closed')
  await run(`window.superego.call('local', 'pane.open', { thread: '${id}', kind: 'browser', params: { path: 'report.html' } })`)
  await until(`${address} === 'report.html'`, 'the artifact shown')
  await both('artifact')
  // A blank page, opened from the pane menu or ⌘T: its address bar waiting.
  const file = await run(`window.superego.call('local', 'thread.list', {}).then((l) => l.find((t) => t.id === '${id}').panes.at(-1).id)`)
  await run(`window.superego.call('local', 'pane.close', { thread: '${id}', pane: '${file}' })`)
  await until(`!document.querySelector('.browser-frame')`, 'the file closed')
  await run(`window.superego.call('local', 'pane.open', { thread: '${id}', kind: 'browser' })`)
  await until(`Boolean(document.querySelector('input.browser-address'))`, 'a blank page')
  await both('blank')
  for (const r of held.splice(0)) r.destroy()
  server.close()
})
