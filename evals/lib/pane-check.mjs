// The kanban task's window check. For each profile a thread in the project can start with, it starts a thread with
// it, shows it (its profile's UI loads), asks the window which pane kinds that profile registered
// (window.superegoRegistered), opens each beside the thread, and reports what the pane drew: its text, whether it
// failed, a screenshot of the pane, and whether a thread started afterwards shows up in it (live data).
// Run by evals/tasks/kanban.ts as `Electron pane-check.mjs`, with EVAL_WINDOW_CHECK set to its JSON input.
import { windowCheck } from './window.mjs'

await windowCheck(async (w) => {
  const { input, result, run, until, soon, call, show, shot, registered } = w
  result.kinds = {}
  result.registered = {}
  for (const [i, probe] of input.probes.entries()) {
    const name = probe.profile ?? 'default'
    const title = `Board probe ${i + 1} (${Date.now() % 100000})`
    let thread
    try { thread = await call('thread.start', { cwd: input.project, title, ...(probe.profile ? { profile: probe.profile } : {}) }) } catch (error) {
      result.errors.push(`thread.start (${name}): ${error.message}`); continue
    }
    await show(title)
    // The pane kinds of the thread's profile, as the window registered them: the profile's UI, and its data views.
    const dir = (await call('thread.list', {})).find((t) => t.id === thread.id)?.profile?.dir
    const kindsNow = async () => {
      const now = await registered()
      if (!now) throw new Error('window.superegoRegistered is missing: an app from before it')
      return [...new Set(now.panes.filter((p) => p.profile && (!dir || p.profile.replace(/\/private(?=\/tmp)/g, "").includes(dir.replace(/^\/private(?=\/tmp)/, "")))).map((p) => p.kind))]
    }
    // Its profile's UI loads as the thread shows: its pane kinds, once there (none, after a while, is the finding).
    let kinds = []
    try { kinds = await until(async () => { const found = await kindsNow(); return found.length && found }, 'its pane kinds', 5000) } catch (error) {
      if (/superegoRegistered is missing/.test(error.message)) result.errors.push(error.message)
    }
    result.registered[name] = kinds
    // Most likely first: kinds that sound like a board.
    kinds.sort((a, b) => Number(!/kanban|board/i.test(a)) - Number(!/kanban|board/i.test(b)))
    for (const kind of kinds.slice(0, 3)) {
      const key = `${name}:${kind}`
      const report = result.kinds[key] = { profile: name, kind, opened: false, text: '', failed: false, live: false }
      try { await call('pane.open', { thread: thread.id, kind }) } catch (error) { report.error = `pane.open: ${error.message}`; continue }
      const pane = (await call('thread.list', {})).find((t) => t.id === thread.id)?.panes?.find((p) => p.kind === kind)
      if (!pane) { report.error = 'no pane after pane.open'; continue }
      const column = `document.querySelector('.panes > [data-column="${pane.id}"]')`
      report.opened = Boolean(await soon(`Boolean(${column})`, 10_000))
      // Drawn once the seeded threads show (or, after a while, as it is), and at rest.
      await soon(`(${column}?.innerText ?? '').includes(${JSON.stringify(input.titles[0])})`, 15_000)
      await w.settled()
      report.text = String(await run(`${column}?.innerText ?? ''`).catch(() => '')).slice(0, 4000)
      report.failed = Boolean(await run(`Boolean(${column}?.querySelector('.extension-failed'))`).catch(() => false))
      report.screenshot = await shot(`${input.shots}/${key.replace(/[^\w.-]+/g, '_')}.png`, column)
      // Live: a thread started now shows up without anything else happening.
      const fresh = `Live check ${Date.now() % 10000}`
      await call('thread.start', { cwd: input.project, title: fresh })
      report.live = Boolean(await soon(`(${column}?.innerText ?? '').includes(${JSON.stringify(fresh)})`, 12_000))
    }
  }
})
