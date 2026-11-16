// The window checks' shared start: the installed app, headless, on the run's daemon (its environment), its main loaded
// from `input.main`. Each check (pane-check.mjs, badge-check.mjs) runs as `Electron <check>.mjs` with its JSON input in
// EVAL_WINDOW_CHECK, writes its result to `input.out`, and quits.
import { app, BrowserWindow } from 'electron'
import { writeFileSync } from 'node:fs'

/** The window, once connected: run from a promise the entry module doesn't await (Electron's `ready` waits for it). */
export async function openWindow() {
  const input = JSON.parse(process.env.EVAL_WINDOW_CHECK)
  const result = { errors: [], console: [] }
  const finish = (code = 0) => { writeFileSync(input.out, JSON.stringify(result, null, 2)); app.exit(code) }
  process.on('uncaughtException', (error) => { result.errors.push(`uncaught: ${error.stack ?? error}`); finish(1) })
  app.on('web-contents-created', (_e, contents) => contents.on('console-message', (event) => {
    if (event.level === 'error' || event.level === 'warning') result.console.push(String(event.message).slice(0, 500))
  }))
  setTimeout(() => { result.errors.push('timed out'); finish(1) }, 170_000)

  await import(input.main)
  await app.whenReady()
  const win = () => BrowserWindow.getAllWindows()[0]
  const run = (js) => win().webContents.executeJavaScript(js)
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const until = async (js, ms = 20_000) => {
    for (let i = 0; i < ms / 200; i++) {
      if (win() && !win().webContents.isLoading()) { const value = await run(js).catch(() => undefined); if (value) return value }
      await sleep(200)
    }
    return undefined
  }
  const call = (method, params) => run(`window.superego.call('local', ${JSON.stringify(method)}, ${JSON.stringify(params)})`)
  /** The sidebar's row for a thread, by its title (an expression). */
  const row = (title) => `[...document.querySelectorAll('.superego-list-item')].find((li) => li.textContent.includes(${JSON.stringify(title)}))`
  /** Show a thread, by its title in the sidebar; its profile's UI loads as it shows. */
  const show = async (title) => {
    await until(`Boolean(${row(title)})`)
    await run(`${row(title)}?.click()`)
    await sleep(2500)
  }
  /** A screenshot of the window, or of an element's box (an expression), as PNG. */
  const shoot = async (path, element) => {
    const box = element && await run(`(() => { const r = ${element}?.getBoundingClientRect(); return r && { x: Math.floor(r.x), y: Math.floor(r.y), width: Math.ceil(r.width), height: Math.ceil(r.height) } })()`).catch(() => undefined)
    writeFileSync(path, (await win().webContents.capturePage(box && box.width && box.height ? box : undefined)).toPNG())
    return path
  }
  /** What the window's extensions registered now (window.superegoRegistered: panes, slots and views, by owner). */
  const registered = () => run('window.superegoRegistered?.() ?? null')
  if (!await until(`window.superego.machines().then((list) => list.find((m) => m.id === 'local')?.state === 'connected')`, 30_000)) {
    result.errors.push('the window never connected'); finish(1)
    return undefined
  }
  win().setContentSize(1500, 1000)
  return { input, result, finish, win, run, sleep, until, call, row, show, shoot, registered }
}
