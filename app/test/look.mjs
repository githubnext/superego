// Screenshots of the window's layout (run by test/look.sh): the sidebar open, folded to dots and closed; the thread
// alone (and dragged narrower) and with Changes beside it (and a file past it); a long title, parent and branch; thread
// details, their menu and Settings → Layout; a phone, its drawer open, a data view in it, the thread's sheet; a data view
// as a space; light and dark. Into $SUPEREGO_SHOWCASE_OUT.
import { app, BrowserWindow, nativeTheme } from 'electron'
import { writeFileSync } from 'node:fs'
import { threads } from './showcase/threads.mjs'

const fail = (message) => { console.error(`look: FAIL ${message}`); app.exit(1) }
process.on('uncaughtException', (error) => fail(`uncaught: ${error.stack ?? error}`))
app.on('web-contents-created', (_e, contents) => contents.on('console-message', (event) => { if (event.level === 'error') console.error('renderer:', event.message) }))
setTimeout(() => fail('timed out'), 180_000)

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
  const [width, height] = (process.env.LOOK_SIZE ?? '1100x760').split('x').map(Number)
  win().setContentSize(width, height)
  const project = process.env.SUPEREGO_SHOWCASE_PROJECT
  const state = (id) => `window.superego.call('local', 'thread.list', {}).then((list) => list.find((s) => s.id === '${id}')?.status.state)`
  const turnOn = async (id, text) => {
    await run(`window.superego.call('local', 'thread.seen', { id: '${id}' })`)
    await run(`window.superego.call('local', 'thread.submit', { id: '${id}', text: ${JSON.stringify(text)} })`)
    await until(`${state(id)}.then((s) => s === 'done' || s === 'error')`, `answer in ${id}`)
  }
  const ids = []
  for (const thread of threads.slice(0, 2)) {
    const { id } = await run(`window.superego.call('local', 'thread.create', { cwd: ${JSON.stringify(project)} })`)
    ids.push(id)
    await turnOn(id, thread.prompt)
    for (const text of thread.followUps) await turnOn(id, text)
  }
  // One left unseen, one shown.
  const id = ids[0]
  await run(`window.superego.call('local', 'thread.seen', { id: '${id}' })`)
  const title = await run(`window.superego.call('local', 'thread.list', {}).then((list) => list.find((t) => t.id === '${id}').title)`)
  await run(`[...document.querySelectorAll('.superego-list-item, .threads-rail__dot')].find((li) => (li.textContent + li.getAttribute('aria-label')).includes(${JSON.stringify(title)}.slice(0, 12)))?.click()`)
  await until(`document.querySelectorAll('.transcript .msg').length >= 2`, 'thread shown')
  const out = process.env.SUPEREGO_SHOWCASE_OUT
  const shot = async (name) => writeFileSync(`${out}/${name}.png`, (await win().webContents.capturePage()).toPNG())
  const setting = (key, value) => run(`window.superego.call('app', 'app.settings.set', { key: '${key}', value: ${JSON.stringify(value)} })`)
  const end = () => run(`document.querySelectorAll('.thread__scroll').forEach((el) => { el.scrollTop = el.scrollHeight })`)
  const both = async (name) => {
    for (const theme of ['light', 'dark']) {
      nativeTheme.themeSource = theme
      await sleep(400)
      await end()
      await sleep(200)
      await shot(`${name}-${theme}`)
    }
  }
  await both('open')
  // A right-click on a space in the rail: its menu.
  await run(`(() => { const b = document.querySelector('.app__rail .superego-context[data-view="threads.list"] button'); const r = b.getBoundingClientRect()
    b.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 })) })()`)
  await until(`!!document.querySelector('.view-menu')`, 'rail menu')
  await sleep(200)
  await both('rail-menu')
  await run(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
  await until(`!document.querySelector('.view-menu')`, 'rail menu closed')
  // The thread alone, dragged narrower from its handle at the row's end, then put back with a double click.
  const handle = `[...document.querySelectorAll('.panes__gap')].at(-1)`
  const dragBy = (dx) => run(`(() => { const h = ${handle}; const r = h.getBoundingClientRect(); const x = r.left + r.width / 2, y = r.top + r.height / 2
    h.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: x, clientY: y }))
    window.dispatchEvent(new PointerEvent('pointermove', { clientX: x + ${dx}, clientY: y }))
    window.dispatchEvent(new PointerEvent('pointerup', { clientX: x + ${dx}, clientY: y })) })()`)
  await dragBy(-360)
  await sleep(300)
  console.log('dragged:', await run(`document.querySelector('.panes__column--thread').offsetWidth`))
  await both('open-dragged')
  await run(`${handle}.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`)
  await sleep(300)
  console.log('reset:', await run(`document.querySelector('.panes__column--thread').offsetWidth`))
  console.log('open:', await run(`window.superego.call('local', 'pane.open', { id: '${id}', kind: 'diff' }).then((r) => JSON.stringify(r), (e) => 'ERR ' + e.message)`))
  await until(`!!document.querySelector('.diff-pane, .diff-file')`, 'changes')
  console.log('pane:', await run(`document.querySelector('.panes__column:last-child')?.innerText.slice(0, 200)`))
  await sleep(500)
  await both('open-changes')
  // Changes focused, a file beside it off to the right.
  await run(`window.superego.call('local', 'pane.open', { id: '${id}', kind: 'editor', params: { path: 'README.md' } })`)
  await until(`!!document.querySelector('.file-editor')`, 'editor')
  const panesOf = () => run(`window.superego.call('local', 'thread.list', {}).then((l) => l.find((t) => t.id === '${id}').panes.map((p) => p.id))`)
  const [diffId, editorId] = await panesOf()
  await run(`window.superego.call('local', 'pane.focus', { id: '${id}', pane: '${diffId}' })`)
  await sleep(300)
  await run(`document.querySelector('[data-column="${diffId}"]')?.focus()`)
  await both('open-changes-file')
  await run(`window.superego.call('local', 'pane.close', { id: '${id}', pane: '${editorId}' })`)
  await run(`document.activeElement?.blur()`)
  await sleep(300)
  await setting('threads.view', 'rail')
  await sleep(300)
  await both('dots-changes')
  // Focus shown: the thread holds the keyboard.
  await run(`document.querySelector('.composer textarea')?.focus()`)
  await both('dots-changes-composer')
  await run(`document.activeElement?.blur()`)
  const paneId = await run(`window.superego.call('local', 'thread.list', {}).then((l) => l.find((t) => t.id === '${id}').panes[0].id)`)
  await run(`window.superego.call('local', 'pane.close', { id: '${id}', pane: '${paneId}' })`)
  await sleep(300)
  await both('dots')
  await setting('threads.view', 'list')
  await run(`window.dispatchEvent(new KeyboardEvent('keydown', { key: '/', metaKey: true, bubbles: true }))`)
  await sleep(300)
  await both('closed')
  // A long title, a parent and a long branch, then archived: the title bar fits the window, wide and at its narrowest.
  await run(`window.dispatchEvent(new KeyboardEvent('keydown', { key: '/', metaKey: true, bubbles: true }))`)
  const long = 'Make the next and previous thread keys follow the order the sidebar shows them in, children under their parents'
  const { id: longId } = await run(`window.superego.call('local', 'thread.create', { cwd: ${JSON.stringify(project)}, worktree: true, parent: '${id}', title: ${JSON.stringify(long)} })`)
  await until(`([...document.querySelectorAll('.superego-list-item')].find((li) => li.textContent.includes('Make the next'))?.click(), document.querySelector('.thread__title')?.title === ${JSON.stringify(long)})`, 'long thread shown')
  const tight = async (name) => {
    await both(name)
    for (const narrow of [860, 600]) {
      win().setContentSize(narrow, height)
      await sleep(300)
      await both(`${name}-${narrow}`)
    }
    win().setContentSize(width, height)
    await sleep(300)
  }
  await tight('long')
  await run(`window.superego.call('local', 'thread.archive', { id: '${longId}' })`)
  await until(`!!document.querySelector('.thread__unarchive')`, 'archived')
  await tight('long-archived')
  // Thread details beside the thread (⌘I), then a phone's width: the thread under its bar, and the drawer open.
  await until(`([...document.querySelectorAll('.superego-list-item')].find((li) => li.textContent.includes(${JSON.stringify(title)}.slice(0, 12)))?.click(), document.querySelector('.thread__title')?.title === ${JSON.stringify(title)})`, 'first thread shown again')
  await run(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'i', metaKey: true, bubbles: true }))`)
  await until(`!!document.querySelector('.threads-details')`, 'details')
  await both('details')
  // Its ··· menu, then Settings → Layout from there.
  await run(`document.querySelector('.placed-view .view-menu__button').click()`)
  await until(`[...document.querySelectorAll('.view-menu .superego-menu__item')].some((i) => i.textContent === 'Move to')`, 'view menu')
  await run(`[...document.querySelectorAll('.view-menu .superego-menu__item')].find((i) => i.textContent === 'Move to').focus()`)
  await run(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))`)
  await sleep(300)
  await both('details-menu')
  await run(`[...document.querySelectorAll('.view-menu .superego-menu__item')].find((i) => i.textContent.startsWith('Customise layout')).click()`)
  await until(`!!document.querySelector('.layout-settings .layout-row')`, 'Settings → Layout')
  await sleep(300)
  await both('settings-layout')
  await run(`[...document.querySelectorAll('.layout-settings__tabs button')].find((b) => b.textContent === 'Phone').click()`)
  await sleep(200)
  await both('settings-layout-phone')
  await run(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
  await until(`!document.querySelector('.layout-settings')`, 'Settings closed')
  await run(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'i', metaKey: true, bubbles: true }))`)
  await until(`!document.querySelector('.threads-details')`, 'details hidden')
  // The window goes no narrower than 600: zoomed, its page is a phone's 375.
  win().setContentSize(600, height)
  win().webContents.setZoomFactor(1.6)
  // Laid out again from the wide window: a theme changed at once can miss the next shot.
  await sleep(1500)
  await both('phone')
  await run(`document.querySelector('.app__mobilebar button')?.click()`)
  await until(`!!document.querySelector('.app__sidebar')`, 'drawer')
  await both('phone-drawer')
  // A data view (the skills, placed as a space): in the drawer, switched to from its foot.
  await setting('app.layout', { place: { 'skills.view': 'space' } })
  await until(`!!document.querySelector('.app__drawer-bar [aria-label="Skills"]')`, 'Skills in the drawer')
  await run(`document.querySelector('.app__drawer-bar [aria-label="Skills"]').click()`)
  await until(`document.querySelector('.data-view--space')?.textContent.includes('$release')`, 'skills listed')
  await both('phone-data-view')
  await run(`document.querySelector('.app__drawer-bar [aria-label="Threads"]').click()`)
  await run(`document.querySelector('.app__scrim').click()`)
  // The thread's sheet: what the title bar holds wide, the panes to open, and (the model pressed) the details.
  await run(`document.querySelector('button.app__mobiletitle').click()`)
  await until(`!!document.querySelector('.thread-sheet')`, 'sheet')
  await both('phone-sheet')
  await run(`document.querySelector('.thread-sheet .threads-model').click()`)
  await until(`!!document.querySelector('.thread-sheet .threads-details')`, 'details in the sheet')
  await both('phone-sheet-details')
  await run(`document.querySelector('.thread-sheet .threads-model').click()`)
  await run(`document.querySelector('.app__scrim--sheet').click()`)
  // Wide again: the data view as a space, its button in the rail.
  win().webContents.setZoomFactor(1)
  win().setContentSize(width, height)
  await sleep(1000)
  await until(`!!document.querySelector('.app__rail [aria-label="Skills"]')`, 'Skills in the rail')
  await run(`document.querySelector('.app__rail [aria-label="Skills"]').click()`)
  await until(`document.querySelector('.data-view--space')?.textContent.includes('$release')`, 'skills space')
  await sleep(1500)
  await both('data-view')
  await setting('app.layout', {})
  console.log(`look: done in ${out}`)
  writeFileSync(`${process.env.SUPEREGO_HOME}/passed`, '')
  app.exit(0)
})()
