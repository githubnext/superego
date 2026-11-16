// The kanban task's window check. For each profile a thread in the project can start with, it starts a thread with
// it, shows it (its profile's UI loads), asks the window which pane kinds that profile registered
// (window.superegoRegistered), opens each beside the thread, and reports what the pane drew: its text, whether it
// failed, a screenshot of the pane, and whether a thread started afterwards shows up in it (live data).
// Run by evals/tasks/kanban.ts as `Electron pane-check.mjs`, with EVAL_WINDOW_CHECK set to its JSON input.
import { openWindow } from './window.mjs'

// Not awaited at the top: Electron's `ready` comes only once the entry module has run.
void openWindow().then(async (w) => {
  if (!w) return
  const { input, result, finish, run, sleep, until, call, show, shoot, registered } = w
  result.kinds = {}
  result.registered = {}
  for (const [i, probe] of input.probes.entries()) {
    const name = probe.profile ?? 'default'
    const title = `Board probe ${i + 1} (${Date.now() % 100000})`
    let thread
    try { thread = await call('thread.create', { cwd: input.project, title, ...(probe.profile ? { profile: probe.profile } : {}) }) } catch (error) {
      result.errors.push(`thread.create (${name}): ${error.message}`); continue
    }
    await show(title)
    // The pane kinds of the thread's profile, as the window registered them: the profile's UI, and its data views.
    const dir = (await call('thread.list', {})).find((t) => t.id === thread.id)?.profile?.dir
    let kinds = []
    for (let tries = 0; tries < 10 && !kinds.length; tries++) {
      const now = await registered()
      if (!now) { result.errors.push('window.superegoRegistered is missing: an app from before it'); break }
      kinds = [...new Set(now.panes.filter((p) => p.profile && (!dir || p.profile.replace(/\/private(?=\/tmp)/g, "").includes(dir.replace(/^\/private(?=\/tmp)/, "")))).map((p) => p.kind))]
      if (!kinds.length) await sleep(500)
    }
    result.registered[name] = kinds
    // Most likely first: kinds that sound like a board.
    kinds.sort((a, b) => Number(!/kanban|board/i.test(a)) - Number(!/kanban|board/i.test(b)))
    for (const kind of kinds.slice(0, 3)) {
      const key = `${name}:${kind}`
      const report = result.kinds[key] = { profile: name, kind, opened: false, text: '', failed: false, live: false }
      try { await call('pane.open', { id: thread.id, kind }) } catch (error) { report.error = `pane.open: ${error.message}`; continue }
      const pane = (await call('thread.list', {})).find((t) => t.id === thread.id)?.panes?.find((p) => p.kind === kind)
      if (!pane) { report.error = 'no pane after pane.open'; continue }
      const column = `document.querySelector('.panes > [data-column="${pane.id}"]')`
      report.opened = Boolean(await until(`Boolean(${column})`, 10_000))
      // Give it time to fetch and draw; done once the seeded threads show, or after a while.
      await until(`(${column}?.innerText ?? '').includes(${JSON.stringify(input.titles[0])})`, 15_000)
      await sleep(1000)
      report.text = String(await run(`${column}?.innerText ?? ''`).catch(() => '')).slice(0, 4000)
      report.failed = Boolean(await run(`Boolean(${column}?.querySelector('.extension-failed'))`).catch(() => false))
      report.screenshot = await shoot(`${input.shots}/${key.replace(/[^\w.-]+/g, '_')}.png`, column)
      // Live: a thread started now shows up without anything else happening.
      const fresh = `Live check ${Date.now() % 10000}`
      await call('thread.create', { cwd: input.project, title: fresh })
      report.live = Boolean(await until(`(${column}?.innerText ?? '').includes(${JSON.stringify(fresh)})`, 12_000))
    }
  }
  finish(0)
})
