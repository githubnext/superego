// Screenshots of the window's layout (run by test/look.sh): the sidebar open, folded to dots and closed; the thread
// alone and with Changes beside it (and a file past it); a long title, parent and branch; light and dark. Into $SUPEREGO_SHOWCASE_OUT.
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
  console.log(`look: done in ${out}`)
  app.exit(0)
})()
