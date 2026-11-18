// Panes' heads (run by `test/look.sh <dir> panehead`): an editor (its bar under its tab), a folder and a Browser pane (its
// toolbar), at rest and with what's under each scrolled up beneath it, light and dark, cropped to the window's top,
// into $SUPEREGO_SHOWCASE_OUT. Checks on the way that a head shades only while what's right under it is scrolled.
import { createServer } from 'node:http'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { openApp } from './harness.mjs'

const server = createServer((q, r) => { r.setHeader('content-type', 'text/html'); r.end('<body style="margin:0;font:15px system-ui;padding:24px"><h1>Invoices</h1><p>Page.</p></body>') }).listen(0)

await openApp({ name: 'panehead', timeout: 240_000 }, async (t) => {
  const { run, until } = t
  await t.resize(2200, 700)
  const project = process.env.SUPEREGO_SHOWCASE_PROJECT
  writeFileSync(join(project, 'long.md'), Array.from({ length: 200 }, (_, i) => `Line ${i + 1}: the ledger's entries, one after another.`).join('\n'))
  mkdirSync(join(project, 'entries'))
  for (let i = 1; i <= 60; i++) writeFileSync(join(project, 'entries', `${String(i).padStart(3, '0')}.md`), 'x')
  const { id } = await run(`window.superego.call('local', 'thread.start', { cwd: ${JSON.stringify(project)}, title: 'Ledger' })`)
  await until(`[...document.querySelectorAll('.superego-list-item')].some((li) => li.textContent.includes('Ledger'))`, 'listed')
  await run(`[...document.querySelectorAll('.superego-list-item')].find((li) => li.textContent.includes('Ledger')).click()`)
  await until(`document.querySelector('.thread__title')?.textContent === 'Ledger'`, 'shown')
  await t.emulateFocus()
  await run(`window.superego.call('local', 'pane.open', { thread: '${id}', kind: 'editor', params: { path: 'long.md' } })`)
  await until(`!!document.querySelector('.file-editor .cm-content')`, 'editor')
  await run(`window.superego.call('local', 'pane.open', { thread: '${id}', kind: 'folder', params: { path: 'entries' } })`)
  await until(`!!document.querySelector('.files-tree__row')`, 'folder')
  await run(`window.superego.call('local', 'pane.open', { thread: '${id}', kind: 'browser', params: { url: 'http://localhost:${server.address().port}/' } })`)
  await until(`!!document.querySelector('.browser-address__text')`, 'browser')
  await t.settled()
  // All in view at once: narrower columns than they'd open at.
  await run(`document.querySelectorAll('.panes > .panes__column').forEach((c, i) => { c.style.width = i ? '560px' : '420px' }); document.querySelector('.panes').scrollLeft = 0`)
  await t.settled()
  const top = `({ getBoundingClientRect: () => ({ x: 0, y: 0, width: 2200, height: 200 }) })`
  const scroll = (y) => run(`[...document.querySelectorAll('.panes__column:not(.panes__column--thread) .panes__body *')].filter((s) => ['auto', 'scroll'].includes(getComputedStyle(s).overflowY) && s.scrollHeight > s.clientHeight + 10).forEach((s) => { s.scrollTop = ${y} })`)
  const shaded = () => run(`[...document.querySelectorAll('[data-scrolled]')].map((el) => el.matches('.panes__tab') ? el.querySelector('.panes__label').textContent : 'editor bar').sort()`)
  for (const theme of ['light', 'dark']) {
    await t.theme(theme)
    await scroll(0)
    await until(`!document.querySelector('[data-scrolled]')`, 'at rest')
    await t.shot(`panehead-rest-${theme}`, top)
    await scroll(400)
    // The folder's list meets its tab; the editor's text meets its bar, not its tab.
    await until(`document.querySelectorAll('[data-scrolled]').length === 2`, 'scrolled')
    if (JSON.stringify(await shaded()) !== JSON.stringify(['editor bar', 'entries/'])) t.fail(`scrolled: the folder's tab and the editor's bar shaded, not ${await shaded()}`)
    await t.settled()
    await new Promise((r) => setTimeout(r, 200))
    await t.shot(`panehead-scrolled-${theme}`, top)
  }
  server.close()
})
