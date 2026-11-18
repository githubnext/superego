// The browser toolbar of Preview and Artifact (run by `test/look.sh <dir> toolbar`): a page with no history yet, one
// with history to go back, the pane holding the keyboard (its "↩ to use the page" hint), and an artifact. Light and dark,
// each cropped to the pane's top, into $SUPEREGO_SHOWCASE_OUT.
import { webContents } from 'electron'
import { writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { openApp } from './harness.mjs'

const page = (title) => `<body style="margin:0;font:15px system-ui;padding:24px"><h1>${title}</h1><a href="/invoices/2024?draft=1">Next</a></body>`
const server = createServer((q, r) => { r.setHeader('content-type', 'text/html'); r.end(page(q.url)) }).listen(0)

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
  const top = `(() => { const r = document.querySelector('.panes__column:has(.web-panes-frame)').getBoundingClientRect(); return { getBoundingClientRect: () => ({ x: r.x, y: r.y, width: r.width, height: 96 }) } })()`
  const both = async (name, before) => {
    for (const theme of ['light', 'dark']) {
      await t.theme(theme)
      if (before) await before()
      await t.shot(`toolbar-${name}-${theme}`, top)
    }
  }
  const address = `document.querySelector('.web-panes-address__text')?.textContent`
  const url = `http://localhost:${server.address().port}/`

  await run(`window.superego.call('local', 'pane.open', { thread: '${id}', kind: 'preview', params: { url: ${JSON.stringify(url)} } })`)
  await until(`${address} === ${JSON.stringify(url)}`, 'the page shown')
  await both('fresh')
  // A link followed: back is offered.
  const view = await until(() => webContents.getAllWebContents().find((w) => w.getURL() === url), 'the page\'s view')
  await view.loadURL(`${url}invoices/2024?draft=1`)
  await until(`${address}.endsWith('/invoices/2024?draft=1') && !document.querySelector('button[aria-label="Back"]').disabled`, 'back offered')
  await both('history')
  // The pane holding the keyboard: Return passes it to the page, and it says so.
  await both('hint', () => until(`(() => { const el = document.querySelector('.web-panes-frame .web-view'); el.focus({ preventScroll: true }); return Boolean(document.querySelector('.web-panes-hint')) })()`, 'the hint'))
  await run(`document.activeElement?.blur()`)

  const preview = await run(`window.superego.call('local', 'thread.list', {}).then((l) => l.find((t) => t.id === '${id}').panes.at(-1).id)`)
  await run(`window.superego.call('local', 'pane.close', { thread: '${id}', pane: '${preview}' })`)
  await until(`!document.querySelector('.web-panes-frame')`, 'the preview closed')
  await run(`window.superego.call('local', 'pane.open', { thread: '${id}', kind: 'artifact', params: { path: 'report.html' } })`)
  await until(`${address} === 'report.html'`, 'the artifact shown')
  await both('artifact')
  server.close()
})
