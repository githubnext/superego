// Screenshots of each region holding the focus (run by `test/look.sh <dir> focus`): the sidebar, the thread (scrolled,
// and its prompt), the editor (Live, Source, Rendered), Changes, a page, an artifact, a folder; then phone-narrow. Light
// and dark, into $SUPEREGO_SHOWCASE_OUT.
import { writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { openApp } from './harness.mjs'
import { threads } from './showcase/threads.mjs'

// A page wider and taller than its pane, so its scrollbars sit against the ring.
const long = `<body style="margin:0;font:15px system-ui;background:#f6f8fa"><div style="width:1600px;padding:24px">${Array.from({ length: 80 }, (_, i) => `<p>Line ${i + 1}: the page runs right up to its pane's edges.</p>`).join('')}</div></body>`
const server = createServer((_q, r) => { r.setHeader('content-type', 'text/html'); r.end(long) }).listen(0, '127.0.0.1')

await openApp({ name: 'focus', timeout: 240_000 }, async (t) => {
  const { run, until } = t
  await t.resize(1300, 820)
  const project = process.env.SUPEREGO_SHOWCASE_PROJECT
  writeFileSync(join(project, 'artifact.html'), long.replaceAll('#f6f8fa', '#fff8e6'))
  const { id } = await run(`window.superego.call('local', 'thread.start', { cwd: ${JSON.stringify(project)} })`)
  await run(`window.superego.call('local', 'thread.send', { thread: '${id}', text: ${JSON.stringify(threads[0].prompt)} })`)
  await until(`window.superego.call('local', 'thread.list', {}).then((l) => ['done', 'error'].includes(l.find((t) => t.id === '${id}')?.status.state))`, 'an answer')
  await run(`window.superego.call('local', 'thread.seen', { thread: '${id}' })`)
  await run(`document.querySelector('.app__sidebar .superego-list-item')?.click()`)
  await until(`document.querySelectorAll('.transcript .msg').length >= 2`, 'thread shown')
  await t.emulateFocus()

  const focus = (selector) => run(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); el.focus({ preventScroll: true, focusVisible: true }); return Boolean(el) })()`)
  const both = async (name, selector) => {
    for (const theme of ['light', 'dark']) {
      await t.theme(theme)
      if (selector) await until(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); el?.focus({ preventScroll: true, focusVisible: true }); return el && document.activeElement === el })()`, `${name} focused`)
      await t.shot(`focus-${name}-${theme}`)
    }
  }
  const scrollThread = () => run(`(() => { const el = document.querySelector('.thread__scroll'); el.scrollTop = (el.scrollHeight - el.clientHeight) / 2 })()`)
  let pane
  const open = async (kind, params, ready) => {
    if (pane) {
      await run(`window.superego.call('local', 'pane.close', { thread: '${id}', pane: '${pane}' })`)
      await until(`!document.querySelector('[data-column="${pane}"]')`, 'the pane before closed')
    }
    await run(`window.superego.call('local', 'pane.open', { thread: '${id}', kind: '${kind}', params: ${JSON.stringify(params)} })`)
    await until(ready, kind)
    pane = await run(`window.superego.call('local', 'thread.list', {}).then((l) => l.find((t) => t.id === '${id}').panes.at(-1).id)`)
    await t.settled()
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
    await t.settled()
    await both(`editor-${mode.toLowerCase()}`, mode === 'Rendered' ? '.file-editor__rendered' : '.cm-content')
  }
  await run(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 't', metaKey: true, shiftKey: true, bubbles: true }))`)
  await t.settled()
  await both('editor-tree', '.files-tree__row')
  await run(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 't', metaKey: true, shiftKey: true, bubbles: true }))`)
  await open('diff', {}, `!!document.querySelector('.diff-file, .pane-empty')`)
  await both('changes', '[data-column]:not([data-column="thread"])')
  await open('preview', { url: `http://127.0.0.1:${server.address().port}/` }, `!!document.querySelector('.web-panes-frame iframe')`)
  await both('preview', '.web-panes-frame iframe')
  await open('artifact', { path: 'artifact.html' }, `!!document.querySelector('.web-panes-frame iframe')`)
  await both('artifact', '.web-panes-frame iframe')
  await open('folder', { path: '' }, `!!document.querySelector('[data-column]:not([data-column="thread"]) .files-tree__row')`)
  await both('folder', '[data-column]:not([data-column="thread"]) .files-tree__row')
  // Phone-narrow: one column at a time, the sidebar a drawer.
  await open('editor', { path: 'README.md' }, `!!document.querySelector('.file-editor .cm-content')`)
  await run(`[...document.querySelectorAll('.file-editor__mode button')].find((b) => b.textContent === 'Live')?.click()`)
  await t.contents().debugger.sendCommand('Emulation.setDeviceMetricsOverride', { width: 390, height: 820, deviceScaleFactor: 2, mobile: true })
  await until(`innerWidth === 390 && Boolean(document.querySelector('.app__mobilebar'))`, 'a phone’s width')
  await both('narrow-thread', '.thread__scroll')
  await run(`document.querySelector('.panes').scrollLeft = 10000`)
  await t.settled()
  await both('narrow-editor', '.cm-content')
  await run(`document.querySelector('.app__mobilebar button')?.click()`)
  await until(`Boolean(document.querySelector('.app__sidebar'))`, 'the drawer')
  await both('narrow-sidebar', '.app__sidebar .superego-list-item.is-selected')
  server.close()
})
