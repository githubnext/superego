// Screenshots of each region holding the focus (run by `test/look.sh <dir> focus`): the sidebar, the thread (scrolled,
// and its prompt), the editor (Live, Source, Rendered), Changes, a page, an artifact, a folder; then phone-narrow. Light
// and dark, into $SUPEREGO_SHOWCASE_OUT.
import { app, BrowserWindow, nativeTheme } from 'electron'
import { writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { threads } from './showcase/threads.mjs'

const fail = (message) => { console.error(`focus: FAIL ${message}`); app.exit(1) }
process.on('uncaughtException', (error) => fail(`uncaught: ${error.stack ?? error}`))
setTimeout(() => fail('timed out'), 240_000)

// A page wider and taller than its pane, so its scrollbars sit against the ring.
const long = `<body style="margin:0;font:15px system-ui;background:#f6f8fa"><div style="width:1600px;padding:24px">${Array.from({ length: 80 }, (_, i) => `<p>Line ${i + 1}: the page runs right up to its pane's edges.</p>`).join('')}</div></body>`
const server = createServer((_q, r) => { r.setHeader('content-type', 'text/html'); r.end(long) }).listen(0, '127.0.0.1')

await import('../out/main/main.js')
void (async () => {
  await app.whenReady()
  const win = () => BrowserWindow.getAllWindows()[0]
  const run = (js) => win().webContents.executeJavaScript(js)
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const until = async (js, label, ms = 30_000) => {
    for (let i = 0; i < ms / 100; i++) {
      if (win() && !win().webContents.isLoading()) { const value = await run(js).catch(() => undefined); if (value) return value }
      await sleep(100)
    }
    fail(`waiting for ${label}`)
    throw new Error(label)
  }
  await until(`window.superego.machines().then((list) => list.find((m) => m.id === 'local')?.state === 'connected')`, 'local machine')
  win().setContentSize(1300, 820)
  const project = process.env.SUPEREGO_SHOWCASE_PROJECT
  writeFileSync(join(project, 'artifact.html'), long.replaceAll('#f6f8fa', '#fff8e6'))
  const { id } = await run(`window.superego.call('local', 'thread.create', { cwd: ${JSON.stringify(project)} })`)
  await run(`window.superego.call('local', 'thread.submit', { id: '${id}', text: ${JSON.stringify(threads[0].prompt)} })`)
  await until(`window.superego.call('local', 'thread.list', {}).then((l) => ['done', 'error'].includes(l.find((t) => t.id === '${id}')?.status.state))`, 'an answer')
  await run(`window.superego.call('local', 'thread.seen', { id: '${id}' })`)
  await run(`document.querySelector('.app__sidebar .superego-list-item')?.click()`)
  await until(`document.querySelectorAll('.transcript .msg').length >= 2`, 'thread shown')
  // A hidden window's page never has focus, so :focus styles never apply; emulate it (nothing reaches the screen).
  const dbg = win().webContents.debugger
  dbg.attach()
  await dbg.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true })

  const out = process.env.SUPEREGO_SHOWCASE_OUT
  const focus = (selector) => run(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); el.focus({ preventScroll: true, focusVisible: true }); return Boolean(el) })()`)
  const both = async (name, selector) => {
    for (const theme of ['light', 'dark']) {
      nativeTheme.themeSource = theme
      await sleep(400)
      if (selector) await until(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); el?.focus({ preventScroll: true, focusVisible: true }); return el && document.activeElement === el })()`, `${name} focused`)
      await sleep(200)
      writeFileSync(`${out}/focus-${name}-${theme}.png`, (await win().webContents.capturePage()).toPNG())
    }
  }
  const scrollThread = () => run(`(() => { const el = document.querySelector('.thread__scroll'); el.scrollTop = (el.scrollHeight - el.clientHeight) / 2 })()`)
  let pane
  const open = async (kind, params, ready) => {
    if (pane) await run(`window.superego.call('local', 'pane.close', { id: '${id}', pane: '${pane}' })`)
    await run(`window.superego.call('local', 'pane.open', { id: '${id}', kind: '${kind}', params: ${JSON.stringify(params)} })`)
    await until(ready, kind)
    pane = await run(`window.superego.call('local', 'thread.list', {}).then((l) => l.find((t) => t.id === '${id}').panes.at(-1).id)`)
    await sleep(600)
  }

  await both('sidebar', '.app__sidebar .superego-list-item.is-selected')
  await scrollThread()
  await both('thread-alone', '.thread__scroll')
  await both('prompt-alone', '.composer textarea')
  await open('editor', { path: 'README.md' }, `!!document.querySelector('.file-editor .cm-content')`)
  await scrollThread()
  await both('thread', '.thread__scroll')
  for (const mode of ['Live', 'Source', 'Rendered']) {
    await run(`[...document.querySelectorAll('.file-editor__mode button')].find((b) => b.textContent === '${mode}')?.click()`)
    await sleep(300)
    await both(`editor-${mode.toLowerCase()}`, mode === 'Rendered' ? '.file-editor__rendered' : '.cm-content')
  }
  await run(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 't', metaKey: true, shiftKey: true, bubbles: true }))`)
  await sleep(500)
  await both('editor-tree', '.files-tree__row')
  await run(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 't', metaKey: true, shiftKey: true, bubbles: true }))`)
  await open('diff', {}, `!!document.querySelector('.diff-file, .pane-empty')`)
  await both('changes', '[data-column]:not([data-column="thread"])')
  await open('preview', { url: `http://127.0.0.1:${server.address().port}/` }, `!!document.querySelector('.frame-pane iframe')`)
  await both('preview', '.frame-pane iframe')
  await open('artifact', { path: 'artifact.html' }, `!!document.querySelector('.frame-pane iframe')`)
  await both('artifact', '.frame-pane iframe')
  await open('folder', { path: '' }, `!!document.querySelector('[data-column]:not([data-column="thread"]) .files-tree__row')`)
  await both('folder', '[data-column]:not([data-column="thread"]) .files-tree__row')
  // Phone-narrow: one column at a time, the sidebar a drawer.
  await open('editor', { path: 'README.md' }, `!!document.querySelector('.file-editor .cm-content')`)
  await run(`[...document.querySelectorAll('.file-editor__mode button')].find((b) => b.textContent === 'Live')?.click()`)
  await dbg.sendCommand('Emulation.setDeviceMetricsOverride', { width: 390, height: 820, deviceScaleFactor: 2, mobile: true })
  await sleep(600)
  await both('narrow-thread', '.thread__scroll')
  await run(`document.querySelector('.panes').scrollLeft = 10000`)
  await sleep(600)
  await both('narrow-editor', '.cm-content')
  await run(`document.querySelector('.app__mobilebar button')?.click()`)
  await sleep(400)
  await both('narrow-sidebar', '.app__sidebar .superego-list-item.is-selected')
  console.log(`focus: done in ${out}`)
  server.close()
  app.exit(0)
})()
