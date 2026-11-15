// The kanban task's window check: the installed app, headless, on the run's daemon. It starts a thread in the project
// (with the profile the run made), shows it, opens each candidate pane kind beside it, and reports what the pane drew:
// its text, whether it failed, a screenshot, and whether a thread started afterwards shows up in it (live data).
// Run by evals/tasks/kanban.ts as `Electron pane-check.mjs`, with EVAL_PANE_CHECK set to its JSON input.
import { app, BrowserWindow } from 'electron'
import { writeFileSync } from 'node:fs'

const input = JSON.parse(process.env.EVAL_PANE_CHECK)
const result = { kinds: {}, errors: [], console: [] }
const finish = (code = 0) => { writeFileSync(input.out, JSON.stringify(result, null, 2)); app.exit(code) }
process.on('uncaughtException', (error) => { result.errors.push(`uncaught: ${error.stack ?? error}`); finish(1) })
app.on('web-contents-created', (_e, contents) => contents.on('console-message', (event) => {
  if (event.level === 'error' || event.level === 'warning') result.console.push(String(event.message).slice(0, 500))
}))
setTimeout(() => { result.errors.push('timed out'); finish(1) }, 150_000)

await import(input.main)
void (async () => {
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
  if (!await until(`window.superego.machines().then((list) => list.find((m) => m.id === 'local')?.state === 'connected')`, 30_000)) {
    result.errors.push('the window never connected'); return finish(1)
  }
  win().setContentSize(1500, 900)
  for (const [i, probe] of input.probes.entries()) {
    const title = `Board probe ${i + 1}`
    let thread
    try { thread = await call('thread.create', { cwd: input.project, title, ...(probe.profile ? { profile: probe.profile } : {}) }) } catch (error) {
      result.errors.push(`thread.create (${probe.profile ?? 'default'}): ${error.message}`); continue
    }
    await until(`[...document.querySelectorAll('.superego-list-item')].some((li) => li.textContent.includes(${JSON.stringify(title)}))`)
    await run(`[...document.querySelectorAll('.superego-list-item')].find((li) => li.textContent.includes(${JSON.stringify(title)}))?.click()`)
    await sleep(1500)
    for (const kind of probe.kinds) {
      const key = `${probe.profile ?? 'default'}:${kind}`
      const report = result.kinds[key] = { profile: probe.profile ?? 'default', kind, opened: false, text: '', failed: false, live: false }
      try { await call('pane.open', { id: thread.id, kind }) } catch (error) { report.error = `pane.open: ${error.message}`; continue }
      const list = await call('thread.list', {})
      const pane = list.find((t) => t.id === thread.id)?.panes?.find((p) => p.kind === kind)
      if (!pane) { report.error = 'no pane after pane.open'; continue }
      const column = `document.querySelector('.panes > [data-column="${pane.id}"]')`
      report.opened = Boolean(await until(`Boolean(${column})`, 10_000))
      // Give it time to fetch and draw; done once the seeded threads show, or after a while.
      await until(`(${column}?.innerText ?? '').includes(${JSON.stringify(input.titles[0])})`, 15_000)
      await sleep(1000)
      report.text = String(await run(`${column}?.innerText ?? ''`).catch(() => '')).slice(0, 4000)
      report.failed = Boolean(await run(`Boolean(${column}?.querySelector('.extension-failed'))`).catch(() => false))
      const shot = `${input.shots}/${key.replace(/[^\w.-]+/g, '_')}.png`
      writeFileSync(shot, (await win().webContents.capturePage()).toPNG())
      report.screenshot = shot
      // Live: a thread started now shows up without anything else happening.
      const fresh = `Live check ${Date.now() % 10000}`
      await call('thread.create', { cwd: input.project, title: fresh })
      report.live = Boolean(await until(`(${column}?.innerText ?? '').includes(${JSON.stringify(fresh)})`, 12_000))
    }
  }
  finish(0)
})()
