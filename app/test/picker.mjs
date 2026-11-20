// Select element in the Browser pane (run by `test/look.sh <dir> picker`): the page in pick mode, an element under the
// pointer outlined and labelled; the element picked, in the card at the pane's foot with its image; added, a chip in
// the composer. Light and dark, into $SUPEREGO_SHOWCASE_OUT. On the way it checks what only the app can: the picker
// runs in the page's view (in a world of the app's own, its answer awaited), a real click picks, and the image is taken.
import { webContents } from 'electron'
import { createServer } from 'node:http'
import { openApp } from './harness.mjs'

const page = `<!doctype html><title>Pricing</title><body style="margin:0;font:15px system-ui;color:#222;background:#fafafa">
<main style="padding:32px;display:grid;grid-template-columns:repeat(2,1fr);gap:16px">
  <section class="plan"><h2>Hobby</h2><p>For side projects.</p><button class="cta" style="font:inherit;padding:8px 16px;border:0;border-radius:8px;background:#e6e4f0">Start free</button></section>
  <section class="plan plan--pro"><h2>Pro</h2><p>For teams that ship.</p><button class="cta primary" style="font:600 15px system-ui;padding:8px 16px;border:0;border-radius:8px;background:#6e56cf;color:white">Start trial</button></section>
</main></body>`
const server = createServer((q, r) => { r.setHeader('content-type', 'text/html'); r.end(page) }).listen(0)

await openApp({ name: 'picker', timeout: 180_000 }, async (t) => {
  const { run, until } = t
  await t.resize(1200, 640)
  const project = process.env.SUPEREGO_SHOWCASE_PROJECT
  const { id } = await run(`window.superego.call('local', 'thread.start', { cwd: ${JSON.stringify(project)}, title: 'Pricing page' })`)
  await until(`[...document.querySelectorAll('.superego-list-item')].some((li) => li.textContent.includes('Pricing page'))`, 'the thread listed')
  await run(`[...document.querySelectorAll('.superego-list-item')].find((li) => li.textContent.includes('Pricing page')).click()`)
  await until(`document.querySelector('.thread__title')?.textContent === 'Pricing page'`, 'the thread shown')
  await t.emulateFocus()
  const url = `http://localhost:${server.address().port}/pricing`
  await run(`window.superego.call('local', 'pane.open', { thread: '${id}', kind: 'browser', params: { url: ${JSON.stringify(url)} } })`)
  const view = await until(() => webContents.getAllWebContents().find((w) => w.getURL() === url && !w.isLoading()), 'the page\'s view')
  const pageDriver = t.on(() => view, 'page')
  // The page hears no click while picking.
  await view.executeJavaScript(`document.addEventListener('click', (e) => { window.heard = (window.heard ?? 0) + 1 })`)

  const pane = `document.querySelector('.panes__column:has(.browser-frame)')`
  // The page is a view of its own over the window, not in its screenshots: drawn into its box for them.
  const drawPage = async () => {
    const debug = view.debugger
    if (!debug.isAttached()) debug.attach()
    const { data } = await debug.sendCommand('Page.captureScreenshot', { format: 'png' })
    debug.detach()
    await run(`document.querySelector('.browser-frame .web-view').style.background = 'url(data:image/png;base64,${data}) 0 0 / 100% 100%'`)
  }
  const inPage = (js) => view.executeJavaScript(js)

  for (const theme of ['light', 'dark']) {
    await t.theme(theme)
    await t.click('button[aria-label="Select element"]')
    await until(() => inPage(`Boolean(document.querySelector('superego-picker'))`), 'the page in pick mode')
    await until(`document.querySelector('button[aria-label="Select element"]').getAttribute('aria-pressed') === 'true'`, 'the button pressed')
    await pageDriver.hover('button.primary')
    await new Promise((resolve) => setTimeout(resolve, 300))
    await drawPage()
    await t.shot(`picker-picking-${theme}`, pane)
    // A real click picks it: the card, with its image.
    await pageDriver.mouse('button.primary')
    await until(`document.querySelector('.browser-picked__selector')?.textContent === 'button.cta.primary'`, 'the card')
    await until(`document.querySelector('.browser-picked__image')?.naturalWidth > 0`, 'its image')
    if (await inPage(`Boolean(document.querySelector('superego-picker'))`)) t.fail('the layer left on the page')
    if (await inPage(`window.heard ?? 0`)) t.fail('the page heard the click')
    await drawPage()
    await t.shot(`picker-card-${theme}`, pane)
    if (theme === 'light') await t.click('button[aria-label="Dismiss"]')
  }
  // Added: a chip in the composer, which has the keyboard.
  await t.click('.browser-picked .superego-button--primary', 'Add to prompt')
  await until(`document.querySelector('.composer-item .attachment__name')?.textContent.startsWith('<button.cta> · localhost:')`, 'the chip')
  await until(`document.activeElement?.matches('.composer textarea')`, 'the composer focused')
  const dock = `document.querySelector('.dock')`
  // The chip, and pointed at, its card: the image, the label, the selector.
  const withCard = `(() => { const r = document.querySelector('.dock').getBoundingClientRect(); return { getBoundingClientRect: () => ({ x: r.x, y: r.y - 200, width: r.width, height: r.height + 200 }) } })()`
  for (const theme of ['light', 'dark']) {
    await t.theme(theme)
    await t.shot(`picker-chip-${theme}`, dock)
    await t.hover('.composer-item')
    await until(`Boolean(document.querySelector('.composer-item__card img'))`, 'the chip\'s card')
    await t.shot(`picker-chip-card-${theme}`, withCard)
    await t.hover('.composer textarea')
    await until(`!document.querySelector('.composer-item__card')`, 'the card gone')
  }
  server.close()
})
