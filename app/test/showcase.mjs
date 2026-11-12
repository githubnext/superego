// Runs the scripted threads (test/showcase/threads.mjs) in the real app and screenshots each one: top, middle and end,
// light and dark, into $SUPEREGO_SHOWCASE_OUT. Run by test/showcase.sh.
import { app, BrowserWindow, nativeTheme } from 'electron'
import { writeFileSync } from 'node:fs'
import { threads } from './showcase/threads.mjs'

const fail = (message) => { console.error(`showcase: FAIL ${message}`); app.exit(1) }
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
  win().setContentSize(1440, 900)

  const project = process.env.SUPEREGO_SHOWCASE_PROJECT
  const state = (id) => `window.superego.call('local', 'thread.list', {}).then((list) => list.find((s) => s.id === '${id}')?.status.state)`
  /** Send `text` and wait for the answer: seen first, so "done" can only mean this run finished. */
  const turnOn = async (id, text) => {
    await run(`window.superego.call('local', 'thread.seen', { id: '${id}' })`)
    await run(`window.superego.call('local', 'thread.submit', { id: '${id}', text: ${JSON.stringify(text)} })`)
    await until(`${state(id)}.then((s) => s === 'done' || s === 'error')`, `answer in ${id}`)
  }
  const ids = []
  for (const thread of threads) {
    const { id } = await run(`window.superego.call('local', 'thread.create', { cwd: ${JSON.stringify(project)} })`)
    ids.push(id)
    await turnOn(id, thread.prompt)
    for (const text of thread.followUps) await turnOn(id, text)
  }

  const out = process.env.SUPEREGO_SHOWCASE_OUT
  const shot = async (name) => writeFileSync(`${out}/${name}.png`, (await win().webContents.capturePage()).toPNG())
  for (const [index, id] of ids.entries()) {
    await run(`window.superego.call('local', 'thread.seen', { id: '${id}' })`)
    await run(`[...document.querySelectorAll('.superego-list-item')].find((li) => li.dataset.thread === '${id}' || li.textContent.includes(${JSON.stringify(threads[index].prompt.slice(0, 20))}))?.click()`)
    // Shown once the title bar names it and its transcript is in (a thread may be just a prompt and its answer).
    const title = await run(`window.superego.call('local', 'thread.list', {}).then((list) => list.find((t) => t.id === '${id}').title)`)
    await until(`document.querySelector('.thread__title')?.title === ${JSON.stringify(title)} && document.querySelectorAll('.transcript .msg').length >= 2`, `thread ${index + 1} shown`)
    for (const theme of ['light', 'dark']) {
      nativeTheme.themeSource = theme
      await sleep(400)
      for (const [where, at] of [['top', 0], ['middle', 0.5], ['end', 1]]) {
        await run(`(() => { const el = document.querySelector('.thread__scroll'); el.scrollTop = (el.scrollHeight - el.clientHeight) * ${at} })()`)
        await sleep(250)
        await shot(`thread${index + 1}-${theme}-${where}`)
      }
    }
    // Every run and step opened, to see what's folded away.
    nativeTheme.themeSource = 'light'
    await run(`document.querySelectorAll('.transcript details').forEach((d) => { d.open = true })`)
    await sleep(300)
    for (const [where, at] of [['top', 0], ['middle', 0.4]]) {
      await run(`(() => { const el = document.querySelector('.thread__scroll'); el.scrollTop = (el.scrollHeight - el.clientHeight) * ${at} })()`)
      await sleep(250)
      await shot(`thread${index + 1}-light-expanded-${where}`)
    }
    nativeTheme.themeSource = 'system'
  }
  // A Markdown file beside the first thread, rendered and in live preview, light and dark.
  await run(`[...document.querySelectorAll('.superego-list-item')].find((li) => li.dataset.thread === '${ids[0]}' || li.textContent.includes(${JSON.stringify(threads[0].prompt.slice(0, 20))}))?.click()`)
  await run(`window.superego.call('local', 'pane.open', { id: '${ids[0]}', kind: 'editor', params: { path: 'README.md' } })`)
  for (const mode of ['Rendered', 'Live']) {
    await until(`document.querySelector('.file-editor__mode') && ([...document.querySelectorAll('.file-editor__mode button')].find((b) => b.textContent === '${mode}').click(), true)`, `${mode} shown`)
    for (const theme of ['light', 'dark']) {
      nativeTheme.themeSource = theme
      await sleep(400)
      await shot(`editor-${mode.toLowerCase()}-${theme}`)
    }
  }
  nativeTheme.themeSource = 'system'
  console.log(`showcase: ${ids.length} threads in ${out}`)
  app.exit(0)
})()
