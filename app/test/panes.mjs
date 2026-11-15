// Screenshots of a thread with three panes in each layout (run by `test/look.sh <dir> panes`): scrolled, then stacked
// from the strip's switch, a pane brought to the front by ⌃Tab and one opened from outside the window, then scrolled again
// by its shortcut. Checks on the way that a stack never passes the window's edge, and that the last pane's handle is
// clear of it and drags the pane wider. Light and dark, into
// $SUPEREGO_SHOWCASE_OUT.
import { app, BrowserWindow, nativeTheme } from 'electron'
import { writeFileSync } from 'node:fs'
import { threads } from './showcase/threads.mjs'

const fail = (message) => { console.error(`panes: FAIL ${message}`); app.exit(1) }
process.on('uncaughtException', (error) => fail(`uncaught: ${error.stack ?? error}`))
app.on('web-contents-created', (_e, contents) => contents.on('console-message', (event) => { if (event.level === 'error') console.error('renderer:', event.message) }))
setTimeout(() => fail('timed out'), 240_000)

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
  const { id } = await run(`window.superego.call('local', 'thread.create', { cwd: ${JSON.stringify(project)} })`)
  await run(`window.superego.call('local', 'thread.submit', { id: '${id}', text: ${JSON.stringify(threads[0].prompt)} })`)
  await until(`window.superego.call('local', 'thread.list', {}).then((l) => ['done', 'error'].includes(l.find((t) => t.id === '${id}')?.status.state))`, 'an answer')
  await run(`window.superego.call('local', 'thread.seen', { id: '${id}' })`)
  await run(`document.querySelector('.app__sidebar .superego-list-item')?.click()`)
  await until(`document.querySelectorAll('.transcript .msg').length >= 2`, 'thread shown')
  // A hidden window's page never has focus, so focus moves wouldn't hold; emulate it (nothing reaches the screen).
  const dbg = win().webContents.debugger
  dbg.attach()
  await dbg.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true })

  const out = process.env.SUPEREGO_SHOWCASE_OUT
  const both = async (name) => {
    for (const theme of ['light', 'dark']) {
      nativeTheme.themeSource = theme
      await sleep(400)
      writeFileSync(`${out}/panes-${name}-${theme}.png`, (await win().webContents.capturePage()).toPNG())
    }
  }
  const paneIds = () => run(`window.superego.call('local', 'thread.list', {}).then((l) => l.find((t) => t.id === '${id}').panes.map((p) => p.id))`)
  const open = async (kind, params, ready) => {
    await run(`window.superego.call('local', 'pane.open', { id: '${id}', kind: '${kind}', params: ${JSON.stringify(params)} })`)
    await until(ready, kind)
    await sleep(400)
  }
  const key = (init) => run(`window.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, ...${JSON.stringify(init)} }))`)
  const shownPanes = () => run(`[...document.querySelectorAll('.panes > [data-column]:not([data-column="thread"])')].filter((c) => getComputedStyle(c).visibility !== 'hidden').map((c) => c.dataset.column)`)

  await open('diff', {}, `!!document.querySelector('.diff-file, .pane-empty')`)
  await open('editor', { path: 'README.md' }, `!!document.querySelector('.file-editor .cm-content')`)
  await open('folder', { path: '' }, `!!document.querySelector('.files-tree__row')`)
  const [diff, editor, folder] = await paneIds()
  if (!folder) fail('three panes')
  // Scrolled: the editor focused, the row past the window's edge.
  await run(`window.superego.call('local', 'pane.focus', { id: '${id}', pane: '${editor}' })`)
  await sleep(600)
  const scrolled = await run(`(() => { const p = document.querySelector('.panes'); return p.scrollWidth > p.clientWidth })()`)
  if (!scrolled) fail('scrolled: the row should run past the window')
  await both('scroll')
  // The last pane focused, its handle in view clear of the window's edge; dragged out, it grows and the row scrolls on.
  await run(`window.superego.call('local', 'pane.focus', { id: '${id}', pane: '${folder}' })`)
  await sleep(600)
  const handle = `[...document.querySelectorAll('.panes > .panes__gap')].at(-1)`
  const clear = await run(`(() => { const p = document.querySelector('.panes').getBoundingClientRect(), h = ${handle}.getBoundingClientRect(); return Math.round(p.right - h.right) })()`)
  if (clear < 16) fail(`the last handle should be clear of the window's edge, not ${clear}px from it`)
  await both('scroll-end')
  const lastWidth = () => run(`document.querySelector('[data-column="${folder}"]').offsetWidth`)
  const before = await lastWidth()
  await run(`(() => { const h = ${handle}; const r = h.getBoundingClientRect(); const x = r.left + r.width / 2, y = r.top + r.height / 2
    h.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: x, clientY: y }))
    window.dispatchEvent(new PointerEvent('pointermove', { clientX: x + 150, clientY: y }))
    window.dispatchEvent(new PointerEvent('pointerup', { clientX: x + 150, clientY: y })) })()`)
  await until(`document.querySelector('[data-column="${folder}"]').offsetWidth >= ${before} + 140`, 'the last pane dragged wider')
  await run(`${handle}.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`)
  await until(`document.querySelector('[data-column="${folder}"]').offsetWidth === ${before}`, 'the last pane put back')
  await run(`window.superego.call('local', 'pane.focus', { id: '${id}', pane: '${editor}' })`)
  await sleep(600)

  // Stacked, from the strip's switch: the focused pane in front, and nothing past the window's edge.
  await run(`document.querySelector('.strip__layout [aria-label="Stack panes"]').click()`)
  await until(`!!document.querySelector('.panes--stack')`, 'stacked')
  await sleep(400)
  const fits = () => run(`(() => { const p = document.querySelector('.panes'); return p.scrollWidth <= p.clientWidth })()`)
  if (!await fits()) fail('stacked: the row passes the window')
  if (JSON.stringify(await shownPanes()) !== JSON.stringify([editor])) fail(`stacked: the focused pane in front, not ${await shownPanes()}`)
  await both('stack')

  // A tab in the strip brings its pane to the front, with the focus; ⌃Tab the next; ⌘⌥← the one before.
  const tab = (pane) => run(`[...document.querySelectorAll('.strip__tab')][${JSON.stringify([undefined, diff, editor, folder])}.indexOf(${JSON.stringify(pane)})].click()`)
  const inFront = async (pane, label) => {
    await until(`document.activeElement?.closest('[data-column]')?.dataset.column === '${pane}'`, `${label}: focus`)
    await sleep(200)
    if (JSON.stringify(await shownPanes()) !== JSON.stringify([pane])) fail(`${label}: ${pane} in front, not ${await shownPanes()}`)
  }
  await tab(diff)
  await inFront(diff, 'strip')
  await key({ key: 'Tab', code: 'Tab', ctrlKey: true })
  await inFront(editor, '⌃Tab')
  await key({ key: 'Tab', code: 'Tab', ctrlKey: true })
  await inFront(folder, '⌃Tab again')
  await key({ key: 'ArrowLeft', code: 'ArrowLeft', metaKey: true, altKey: true })
  await inFront(editor, '⌘⌥←')
  await tab(diff)
  await inFront(diff, 'strip again')
  await both('stack-changes')
  // Opened from outside the window (the agent's open_pane, another client's): in front, the focus left where it was.
  await run(`window.superego.call('local', 'pane.open', { id: '${id}', kind: 'editor', params: { path: 'src/dates.mjs' } })`)
  await until(`document.querySelectorAll('.panes > [data-column]').length === 5`, 'a fourth pane')
  await sleep(400)
  const fourth = (await paneIds()).at(-1)
  if (JSON.stringify(await shownPanes()) !== JSON.stringify([fourth])) fail(`opened: the new pane in front, not ${await shownPanes()}`)
  if (!await fits()) fail('stacked with four: the row passes the window')
  await both('stack-opened')

  // Its shortcut toggles it back.
  await key({ key: '|', code: 'Backslash', metaKey: true, shiftKey: true })
  await until(`!document.querySelector('.panes--stack')`, 'scrolled again')
  console.log(`panes: done in ${out}`)
  writeFileSync(`${process.env.SUPEREGO_HOME}/passed`, '')
  app.exit(0)
})()
