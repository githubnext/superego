// A Browser pane's page beside the thread kept in view (run by `test/look.sh <dir> keptpage`): scrolled partly under the
// thread, a still of it in its place, under the thread; scrolled back beside it, the page itself, with the focus;
// maximized; in front of a stack. Light and dark, the whole window, into $SUPEREGO_SHOWCASE_OUT. The page is a view of its
// own over the window, not in its screenshots: each view shown is drawn over the screenshot at its bounds, above
// everything, its four corners rounded as its box's, as the window draws it (an inset sheet in its column).
import { webContents } from 'electron'
import { createServer } from 'node:http'
import { openApp } from './harness.mjs'
import { threads } from './showcase/threads.mjs'

const rows = ['Button', 'Card', 'Dialog', 'Menu', 'Popover', 'Tooltip'].map((name) => `<tr><td>${name}</td><td><code>ui/${name.toLowerCase()}</code></td></tr>`).join('')
const page = `<!doctype html><title>Styles</title><body style="margin:0;font:15px system-ui;color:#222;background:#fafafa"><main style="padding:24px 32px">
<h1 style="margin:0 0 16px">Styles</h1><table style="width:100%;border-collapse:collapse" cellpadding="8">${rows}</table></main></body>`
const server = createServer((_q, r) => { r.setHeader('content-type', 'text/html'); r.end(page) }).listen(0)

await openApp({ name: 'keptpage', timeout: 180_000 }, async (t) => {
  const { run, until } = t
  await t.resize(1300, 820)
  const project = process.env.SUPEREGO_SHOWCASE_PROJECT
  const { id } = await run(`window.superego.call('local', 'thread.start', { cwd: ${JSON.stringify(project)} })`)
  await run(`window.superego.call('local', 'thread.send', { thread: '${id}', text: ${JSON.stringify(threads[0].prompt)} })`)
  await until(`window.superego.call('local', 'thread.list', {}).then((l) => ['done', 'error'].includes(l.find((t) => t.id === '${id}')?.status.state))`, 'an answer')
  await run(`window.superego.call('local', 'thread.seen', { thread: '${id}' })`)
  await run(`document.querySelector('.app__sidebar .superego-list-item')?.click()`)
  await until(`document.querySelectorAll('.transcript .msg').length >= 2`, 'thread shown')
  await t.emulateFocus()

  const url = `http://localhost:${server.address().port}/`
  await run(`window.superego.call('local', 'pane.open', { thread: '${id}', kind: 'browser', params: { url: ${JSON.stringify(url)} } })`)
  const view = await until(() => webContents.getAllWebContents().find((w) => w.getURL() === url && !w.isLoading()), "the page's view")
  await run(`window.superego.call('local', 'pane.open', { thread: '${id}', kind: 'editor', params: { path: 'README.md' } })`)
  await until(`!!document.querySelector('.file-editor .cm-content')`, 'the editor')
  const [browser, editor] = await run(`window.superego.call('local', 'thread.list', {}).then((l) => l.find((t) => t.id === '${id}').panes.map((p) => p.id))`)
  await run(`window.superego.call('local', 'pane.focus', { thread: '${id}', pane: '${editor}' })`)
  const scrollLeft = () => run(`document.querySelector('.panes').scrollLeft`)
  await until(async () => { const was = await scrollLeft(); await t.settled(); await t.settled(); return was === await scrollLeft() }, 'the row at rest')

  const placed = () => t.win().contentView.children.find((v) => v.webContents === view)
  const live = () => { const v = placed(); return v?.getVisible() && v.getBounds().x >= 0 && v.getBounds().y >= 0 }
  // Shown, where its box now is (after a maximize, a stack): the page itself, not a still.
  const settledAt = async () => {
    if (!live() || await run(`!!document.querySelector('.web-view__still')`)) return false
    const zoom = t.contents().getZoomFactor(), b = placed().getBounds()
    const box = await run(`(() => { const r = document.querySelector('.browser-frame .web-view').getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height } })()`)
    return ['x', 'y', 'width', 'height'].every((k) => Math.abs(b[k] / zoom - box[k]) < 1.5)
  }
  // The view drawn over the window's screenshot where the window draws it: at its bounds, above everything.
  const shot = async (name) => {
    for (const theme of ['light', 'dark']) {
      await t.theme(theme)
      await t.settled()
      const over = []
      if (live()) {
        const debug = view.debugger
        debug.attach()
        const { data } = await debug.sendCommand('Page.captureScreenshot', { format: 'png' })
        debug.detach()
        const zoom = t.contents().getZoomFactor(), b = placed().getBounds()
        const radius = await run(`parseFloat(getComputedStyle(document.querySelector('.browser-frame .web-view')).borderTopLeftRadius) || 0`)
        over.push({ data, x: b.x / zoom, y: b.y / zoom, width: b.width / zoom, height: b.height / zoom, radius })
      }
      await run(`(() => { for (const v of ${JSON.stringify(over)}) { const img = document.createElement('img'); img.className = 'look-native-view'; img.src = 'data:image/png;base64,' + v.data
        Object.assign(img.style, { position: 'fixed', left: v.x + 'px', top: v.y + 'px', width: v.width + 'px', height: v.height + 'px', borderRadius: v.radius + 'px', zIndex: 2147483647, pointerEvents: 'none' }); document.body.append(img) } })()`)
      if (over.length) await until(`[...document.querySelectorAll('.look-native-view')].every((img) => img.complete)`, 'the view drawn')
      await t.shot(`keptpage-${name}-${theme}`)
      await run(`document.querySelectorAll('.look-native-view').forEach((img) => img.remove())`)
    }
  }

  // Partly under the thread: a still in its place, the thread over it.
  await run(`(() => { const row = document.querySelector('.panes'), edge = document.querySelector('.panes__gap--thread').getBoundingClientRect().right
    row.scrollLeft += document.querySelector('.web-view').getBoundingClientRect().left - edge + 220 })()`)
  await until(() => !live(), 'the view out of sight')
  await until(`document.querySelector('.web-view__still')?.complete === true`, 'a still in its place')
  await shot('under')
  // Beside it: the page itself.
  await run(`window.superego.call('local', 'pane.focus', { thread: '${id}', pane: '${browser}' })`)
  await until(live, 'the page shown beside the thread')
  await until(`!document.querySelector('.web-view__still')`, 'no still')
  // With the focus: the ring round its column.
  await run(`document.querySelector('.browser-frame .web-view').focus()`)
  await until(`!!document.querySelector('[data-column="${browser}"]:focus-within')`, 'the focus in the page')
  await shot('beside')
  // Maximized, and at the front of a stack: the page an inset sheet still.
  await run(`document.querySelector('[data-column="${browser}"] .panes__maximize').click()`)
  await until(`document.querySelector('.panes > .is-maximized')?.dataset.column === '${browser}'`, 'maximized')
  await until(settledAt, 'the page shown maximized')
  await shot('maximized')
  await run(`document.querySelector('[data-column="${browser}"] .panes__maximize').click()`)
  await until(`!document.querySelector('.panes.has-maximized')`, 'restored')
  await run(`document.querySelector('.strip__layout [aria-label="Stack panes"]').click()`)
  await until(`!!document.querySelector('.panes--stack')`, 'stacked')
  await run(`window.superego.call('local', 'pane.focus', { thread: '${id}', pane: '${browser}' })`)
  await until(settledAt, 'the page shown in front of the stack')
  await shot('stack')
  server.close()
})
