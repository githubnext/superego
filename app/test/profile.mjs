// Profiles the window's renderer (run by `test/profile.sh <dir> [scenario…]`): its CPU and memory in four scenarios,
// with a scripted model (test/profile/turns.mjs) in an isolated app.
// - `idle`: about 30 threads in the sidebar, four of them working (a long `sleep`), nothing happening: first with the
//   window never shown yet (as the other tests run it), then shown, then with a terminal open beside the thread.
// - `streaming`: three threads printing a line every half second, then a fourth streaming long Markdown, code and tool
//   calls, shown; then another the same, not shown.
// - `transcript`: a thread of a few thousand entries (tool calls, outputs, images, edits) opened, scrolled through, and
//   streamed into.
// - `memory`: for PROFILE_MINUTES (12), threads switched, panes opened and closed (editor, diff, terminal, browser,
//   folder) and turns run; the heap measured every two minutes and snapshotted at the start, the middle and the end.
// Each phase samples the renderer's CPU and memory each second (app.getAppMetrics), and counts through the DevTools
// Protocol (Performance.getMetrics: layouts, style recalcs, script time) and test/profile/page.js (React's commits and
// the components rendered, long tasks, DOM mutations, timers and observers by where they were set up); some take a CPU
// profile too (written beside the report, `.cpuprofile`, for DevTools; the profiler's own CPU is in that phase's
// numbers). Into $SUPEREGO_PROFILE_OUT: report.md, report.json.
import { app } from 'electron'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { cpus, totalmem } from 'node:os'
import { basename, join } from 'node:path'
import { openApp } from './harness.mjs'
import { PLAN } from './profile/turns.mjs'
import { brief, growth, summarize } from './profile/heap.mjs'

// A shown window behind others, or see-through, still draws every frame, as one in front does. PROFILE_BACKGROUNDING=1
// leaves Chromium's own throttling of hidden windows on: as the other tests run the app.
if (!process.env.PROFILE_BACKGROUNDING) {
  app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')
  app.commandLine.appendSwitch('disable-renderer-backgrounding')
}

const OUT = process.env.SUPEREGO_PROFILE_OUT
const PROJECT = process.env.SUPEREGO_PROFILE_PROJECT
const wanted = (process.env.SUPEREGO_PROFILE_SCENARIOS ?? '').split(/\s+/).filter(Boolean)
const runs = (scenario) => !wanted.length || wanted.includes(scenario)
const MINUTES = Number(process.env.PROFILE_MINUTES || 12)
const OPACITY = Number(process.env.PROFILE_OPACITY ?? 0)
/** Every fixed phase's length times this: a quick look at 0.1. */
const SCALE = Number(process.env.PROFILE_SCALE || 1)
const tick = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const round = (n, digits = 1) => Math.round(n * 10 ** digits) / 10 ** digits

const report = {
  startedAt: new Date().toISOString(), commit: commitOf(), electron: process.versions.electron, chrome: process.versions.chrome,
  cpu: cpus()[0]?.model, cores: cpus().length, memoryGB: Math.round(totalmem() / 2 ** 30), opacity: OPACITY, backgrounding: Boolean(process.env.PROFILE_BACKGROUNDING), scenarios: {},
}

await openApp({ name: 'profile', timeout: (MINUTES + 45) * 60_000, shots: OUT, main: new URL('../out-profile/main/main.js', import.meta.url).href }, async (t) => {
  const { run, until } = t
  await t.resize(1440, 900)
  // Set up with the window never shown, as the other tests run it; shown after idle's first phase.
  const win = t.win()
  win.setOpacity(OPACITY)
  if (OPACITY < 1) win.setIgnoreMouseEvents(true)

  // ── The DevTools Protocol, and page.js in the page from its start ──
  const cdp = t.contents().debugger
  if (!cdp.isAttached()) cdp.attach('1.3')
  const send = (method, params) => cdp.sendCommand(method, params)
  await send('Page.enable')
  await send('Performance.enable')
  await send('Profiler.enable')
  await send('Profiler.setSamplingInterval', { interval: 1000 })
  await send('HeapProfiler.enable')
  await send('Page.addScriptToEvaluateOnNewDocument', { source: readFileSync(new URL('./profile/page.js', import.meta.url), 'utf8') })
  t.contents().reload()
  await until(`Boolean(window.__profile) && window.superego.machines().then((list) => list.find((m) => m.id === 'local')?.state === 'connected')`, 'the page again, profiled', 60_000)
  await t.emulateFocus()

  // ── Measuring ──
  const metrics = async () => Object.fromEntries((await send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]))
  const cpuTimes = new Map()
  const processes = () => {
    const pid = t.contents().getOSProcessId()
    const list = app.getAppMetrics()
    // CPU as Activity Monitor shows it, a share of one core: from the CPU time each process used since the last sample.
    const now = performance.now()
    const of = (p) => {
      if (!p) return { cpu: 0, rssMB: 0 }
      const was = cpuTimes.get(p.pid)
      cpuTimes.set(p.pid, { at: now, seconds: p.cpu.cumulativeCPUUsage })
      return { cpu: was ? (p.cpu.cumulativeCPUUsage - was.seconds) / ((now - was.at) / 1000) * 100 : 0, rssMB: p.memory.workingSetSize / 1024 }
    }
    const others = list.filter((p) => p.type === 'Tab' && p.pid !== pid).map(of)
    return {
      renderer: of(list.find((p) => p.pid === pid)), gpu: of(list.find((p) => p.type === 'GPU')), browser: of(list.find((p) => p.type === 'Browser')),
      others: { cpu: others.reduce((sum, p) => sum + p.cpu, 0), rssMB: others.reduce((sum, p) => sum + p.rssMB, 0) },
    }
  }
  const stats = (values) => {
    const sorted = [...values].sort((a, b) => a - b)
    const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0
    return { mean: round(values.reduce((a, b) => a + b, 0) / (values.length || 1)), p50: round(at(0.5)), p95: round(at(0.95)), max: round(at(1)) }
  }
  const heap = async () => {
    await send('HeapProfiler.collectGarbage')
    const m = await metrics()
    const { usedSize } = await send('Runtime.getHeapUsage')
    return {
      heapMB: round(usedSize / 1048576), nodes: m.Nodes, listeners: m.JSEventListeners, documents: m.Documents, frames: m.Frames, rendererRssMB: round(processes().renderer.rssMB),
      on: { window: await listenersOn('window'), document: await listenersOn('document') },
    }
  }

  /** The listeners on `window` or `document`, by event: how many. */
  const listenersOn = async (expression) => {
    const { result } = await send('Runtime.evaluate', { expression })
    const { listeners } = await send('DOMDebugger.getEventListeners', { objectId: result.objectId })
    await send('Runtime.releaseObject', { objectId: result.objectId })
    const by = {}
    for (const { type } of listeners) by[type] = (by[type] ?? 0) + 1
    return by
  }

  /**
   * A phase: for `seconds`, or while `during` runs (both, if both given), the renderer sampled each second; with
   * `profile`, a CPU profile of it too.
   */
  const phase = async (scenario, name, { seconds = 0, during, profile = false } = {}) => {
    console.log(`profile: ${scenario}: ${name}…`)
    await run('window.__profile.take()')
    const before = await metrics()
    if (profile) await send('Profiler.start')
    processes()
    const samples = []
    const started = Date.now()
    let finished = !during
    const work = during ? during().finally(() => { finished = true }) : undefined
    while (Date.now() - started < seconds * SCALE * 1000 || !finished) {
      await tick(1000)
      samples.push(processes())
    }
    await work
    const wall = (Date.now() - started) / 1000
    const after = await metrics()
    const page = await run('window.__profile.take()')
    const result = {
      seconds: round(wall),
      renderer: { cpu: stats(samples.map((s) => s.renderer.cpu)), rssMB: { start: round(samples[0]?.renderer.rssMB ?? 0), end: round(samples.at(-1)?.renderer.rssMB ?? 0) } },
      gpu: { cpu: stats(samples.map((s) => s.gpu.cpu)) },
      browser: { cpu: stats(samples.map((s) => s.browser.cpu)) },
      others: { cpu: stats(samples.map((s) => s.others.cpu)) },
      perSecond: {
        commits: round(page.commits / wall), renders: round(page.renders / wall), mutations: round(page.mutations / wall),
        layouts: round((after.LayoutCount - before.LayoutCount) / wall), styleRecalcs: round((after.RecalcStyleCount - before.RecalcStyleCount) / wall),
      },
      busy: {
        taskPct: round((after.TaskDuration - before.TaskDuration) / wall * 100), scriptPct: round((after.ScriptDuration - before.ScriptDuration) / wall * 100),
        layoutPct: round((after.LayoutDuration - before.LayoutDuration) / wall * 100), stylePct: round((after.RecalcStyleDuration - before.RecalcStyleDuration) / wall * 100),
      },
      jsHeapMB: { start: round(before.JSHeapUsedSize / 1048576), end: round(after.JSHeapUsedSize / 1048576) }, nodes: after.Nodes, listeners: after.JSEventListeners,
      longTasks: page.longTasks, components: page.components, callbacks: page.callbacks, reactErrors: page.errors,
      cpuSeries: samples.map((s) => round(s.renderer.cpu)),
    }
    if (profile) {
      const { profile: cpuProfile } = await send('Profiler.stop')
      const file = `${scenario}-${name.replace(/\W+/g, '-')}.cpuprofile`
      writeFileSync(join(OUT, file), JSON.stringify(cpuProfile))
      result.profile = { file, ...hotFunctions(cpuProfile) }
    }
    ;(report.scenarios[scenario] ??= {})[name] = result
    console.log(`profile: ${scenario}: ${name}: renderer ${result.renderer.cpu.mean}% (p95 ${result.renderer.cpu.p95}%), ${result.perSecond.commits} commits/s, ${result.perSecond.renders} renders/s`)
    save()
    return result
  }

  // ── The threads ──
  const list = () => run(`window.superego.call('local', 'thread.list', {})`)
  const stateOf = async (id) => (await list()).find((thread) => thread.id === id)?.status.state
  const start = async (title, cwd = PROJECT) => (await run(`window.superego.call('local', 'thread.start', ${JSON.stringify({ cwd, title })})`)).id
  const sendTo = (id, text) => run(`window.superego.call('local', 'thread.send', ${JSON.stringify({ thread: id, text })})`)
  /** The run just sent to it answered. A wait cut short (its connection closed, say) is waited again. */
  const answered = async (id, label, ms = 120_000) => {
    const end = Date.now() + ms
    for (;;) {
      const read = run(`window.superego.call('local', 'thread.read', ${JSON.stringify({ thread: id, wait: true })})`)
      try {
        await Promise.race([read, tick(end - Date.now()).then(() => t.fail(`waiting for ${label}`))])
        return
      } catch (error) {
        if (Date.now() >= end || String(error.message).startsWith('waiting for')) throw error
        console.log(`profile: waiting for ${label} again: ${error.message}`)
        await tick(1000)
      }
    }
  }
  /** Started on a turn it won't finish: working, its turn taken (so the next send takes the next). */
  const working = async (id, label) => {
    await until(async () => await stateOf(id) === 'working', label)
    await tick(2000)
  }
  const row = (title) => `[...document.querySelectorAll('.threads-project:not(.threads-pinned) .superego-list-item')].find((li) => li.querySelector('.threads__title')?.textContent === ${JSON.stringify(title)})`
  const select = async (title) => {
    await until(`Boolean(${row(title)})`, `${title} listed`)
    await run(`${row(title)}.click()`)
    await until(`document.querySelector('.thread__title')?.textContent === ${JSON.stringify(title)}`, `${title} shown`)
  }
  const elsewhere = [join(process.env.SUPEREGO_HOME, 'tuna'), join(process.env.SUPEREGO_HOME, 'notes-app')]
  for (const dir of elsewhere) mkdirSync(dir, { recursive: true })

  // Their turns in the order they're scripted (test/profile/turns.mjs).
  const titles = { long: 'Audit every export the importer reads', done: [], sleepers: [], printers: [], stream: ['Design the bank sync retries', 'Sketch the retry queue'], memory: 'Look around the modules' }
  console.log('profile: setting up (the long transcript takes a few minutes)…')
  const long = await start(titles.long)
  for (let i = 0; i < PLAN.longMessages; i++) {
    await sendTo(long, `Audit the next ${PLAN.longTurns * PLAN.longCalls} exports, and note what you find.`)
    await answered(long, `the long transcript's answer ${i + 1}`, 5 * 60_000)
  }
  for (let i = 0; i < PLAN.done; i++) {
    const title = `Import batch ${i + 1}`
    titles.done.push(title)
    const id = await start(title)
    await sendTo(id, `Import batch ${i + 1}.`)
    await answered(id, title)
  }
  for (let i = 0; i < PLAN.sleepers; i++) {
    const title = `Wait for export ${i + 1}`
    titles.sleepers.push(title)
    const id = await start(title, elsewhere[i % 2])
    await sendTo(id, 'Wait for the export.')
    await working(id, title)
  }
  const quiet = ['Rename settings tabs', 'Onboarding copy pass', 'Fix flaky sync test', 'Smoke split by area', 'Mentions in the composer', 'Pinned threads', 'Release notes', 'Lint pass', 'Picker keys', 'Staff board', 'Sentry overview', 'Threads list: collapse projects', 'Dark mode contrast', 'Keyboard map', 'Changelog pass', 'Settings search', 'Window restore', 'Rail tooltips']
  for (const [i, title] of quiet.entries()) await start(title, i % 3 === 0 ? PROJECT : elsewhere[i % 2])
  const memory = await start(titles.memory)
  await until(`document.querySelectorAll('.app__sidebar .superego-list-item').length >= 30`, 'about 30 threads listed', 30_000)
  report.threads = await run(`document.querySelectorAll('.app__sidebar .superego-list-item').length`)
  await select(titles.done[0])

  // ── 1. Idle ──
  if (runs('idle')) {
    await tick(5000)
    await phase('idle', 'window never shown', { seconds: 30 })
  }
  win.showInactive()
  if (runs('idle')) {
    await tick(10_000)
    report.scenarios.idle.animations = await run('window.__profile.animations()')
    // The CPU profiler takes some CPU of its own: measured without it, then profiled.
    await phase('idle', 'shown window', { seconds: 120 })
    await phase('idle', 'shown window, profiled', { seconds: 30, profile: true })
    await t.shot('idle')
    // A terminal beside it, idle at its prompt.
    const thread = (await list()).find((th) => th.title === titles.done[0]).id
    await run(`window.superego.call('local', 'pane.open', ${JSON.stringify({ thread, kind: 'terminal' })})`)
    await until(`Boolean(document.querySelector('.terminal-pane__screen canvas'))`, 'the terminal drawn')
    await tick(5000)
    await phase('idle', 'a terminal open', { seconds: 60 })
    await phase('idle', 'a terminal open, profiled', { seconds: 20, profile: true })
    const pane = (await list()).find((th) => th.id === thread).panes.find((p) => p.kind === 'terminal').id
    await run(`window.superego.call('local', 'pane.close', ${JSON.stringify({ thread, pane })})`)
    await until(`!document.querySelector('.terminal-pane')`, 'the terminal closed')
  }

  // A scenario's phase, measured if it's one asked for; else only what it does, which takes the turns it's scripted to
  // (the scenarios after it expect theirs next).
  const measured = (scenario) => (name, options = {}) => runs(scenario) ? phase(scenario, name, options) : options.during?.()

  // ── 2. Streaming ──
  {
    const measure = measured('streaming')
    const printers = []
    for (let i = 0; i < PLAN.printers; i++) {
      const title = `Watch sync ${i + 1}`
      titles.printers.push(title)
      const id = await start(title)
      printers.push(id)
      await sendTo(id, 'Watch the sync.')
      await working(id, title)
    }
    await measure('three threads printing', { seconds: 60 })
    const shown = await start(titles.stream[0])
    await select(titles.stream[0])
    await measure('streaming, shown', {
      profile: true,
      during: async () => { await sendTo(shown, 'Compare a few retry designs for the bank sync, in depth.'); await answered(shown, 'the streamed answer', 10 * 60_000) },
    })
    if (runs('streaming')) await t.shot('streaming')
    const hidden = await start(titles.stream[1])
    await select(titles.done[1])
    await measure('streaming, another thread shown', {
      profile: true,
      during: async () => { await sendTo(hidden, 'Sketch the retry queue, in depth.'); await answered(hidden, 'the second streamed answer', 10 * 60_000) },
    })
  }

  // ── 3. The long transcript ──
  if (runs('transcript')) {
    const scenario = (report.scenarios.transcript ??= {})
    await select(titles.done[2])
    const before = await heap()
    const opened = Date.now()
    await select(titles.long)
    // In once what it shows stops changing.
    let last = -1
    await until(async () => {
      const count = await run(`document.querySelector('.transcript')?.querySelectorAll('*').length ?? 0`)
      const steady = count > 0 && count === last
      last = count
      if (!steady) await tick(500)
      return steady
    }, 'the long transcript in', 120_000)
    scenario.open = { ms: Date.now() - opened - 500, before, after: await heap() }
    const scroll = (direction) => run(`(async () => {
      const el = document.querySelector('.thread__scroll')
      const frame = () => new Promise((r) => requestAnimationFrame(r))
      el.scrollTop = ${direction === 'up' ? 'el.scrollHeight' : '0'}
      await frame(); await frame()
      const gaps = []
      let at = performance.now()
      for (let i = 0; i < 1500; i++) {
        const was = el.scrollTop
        el.scrollTop += ${direction === 'up' ? -150 : 150}
        await frame()
        const now = performance.now()
        gaps.push(now - at)
        at = now
        if (el.scrollTop === was) break
      }
      gaps.sort((a, b) => a - b)
      return { frames: gaps.length, meanMs: gaps.reduce((a, b) => a + b, 0) / gaps.length, p95Ms: gaps[Math.floor(gaps.length * 0.95)], maxMs: gaps.at(-1), over50: gaps.filter((g) => g > 50).length, scrollHeight: el.scrollHeight }
    })()`)
    const scrolling = async (name, direction, profile) => {
      let frames
      const result = await phase('transcript', name, { profile, during: async () => { frames = await scroll(direction) } })
      result.frames = Object.fromEntries(Object.entries(frames).map(([k, v]) => [k, round(v)]))
    }
    await scrolling('scrolling up', 'up', true)
    await scrolling('scrolling down', 'down', false)
    await phase('transcript', 'shown, idle', { seconds: 30 })
    // Every run of work opened, as one reading it all would.
    const runs = `document.querySelectorAll('.thread__scroll details.steps--run')`
    await run(`${runs}.forEach((d) => { d.open = true })`)
    await until(`[...${runs}].every((d) => d.querySelector('.run__steps'))`, 'every run opened', 60_000)
    scenario.opened = await heap()
    await scrolling('every run opened, scrolling up', 'up', true)
    await run(`${runs}.forEach((d) => { d.open = false })`)
  }
  {
    // A run streaming into it, shown: everything before it in the transcript is there to render again.
    const measure = measured('transcript')
    const long = (await list()).find((th) => th.title === titles.long).id
    await select(titles.long)
    await measure('streaming into it', {
      profile: true,
      during: async () => { await sendTo(long, 'Now write up what you found, in depth.'); await answered(long, 'the long transcript\'s new answer', 10 * 60_000) },
    })
  }
  if (runs('transcript')) {
    await select(titles.done[2])
    report.scenarios.transcript.left = await heap()
    save()
  }

  // ── 4. Memory over time ──
  if (runs('memory')) {
    const scenario = (report.scenarios.memory ??= { checkpoints: [], snapshots: {} })
    const snapshot = async (label) => {
      const chunks = []
      const onMessage = (_event, method, params) => { if (method === 'HeapProfiler.addHeapSnapshotChunk') chunks.push(params.chunk) }
      cdp.on('message', onMessage)
      await send('HeapProfiler.takeHeapSnapshot', { reportProgress: false })
      cdp.off('message', onMessage)
      const json = chunks.join('')
      if (process.env.PROFILE_KEEP_SNAPSHOTS) writeFileSync(join(OUT, `memory-${label}.heapsnapshot`), json)
      return summarize(JSON.parse(json))
    }
    // Each checkpoint shows a thread that doesn't change (the turns run in another): what grows is what's kept.
    const baseline = async (label) => {
      await select(titles.done[3])
      await tick(3000)
      const at = { label, minute: round((Date.now() - began) / 60_000), ...await heap() }
      scenario.checkpoints.push(at)
      console.log(`profile: memory: ${label}: heap ${at.heapMB} MB, ${at.nodes} nodes, ${at.listeners} listeners, renderer ${at.rendererRssMB} MB`)
      save()
      return at
    }
    const began = Date.now()
    await baseline('start')
    const first = await snapshot('start')
    scenario.snapshots.start = brief(first)
    const kinds = [['editor', { path: 'README.md' }], ['diff', {}], ['terminal', {}], ['browser', { path: 'page.html' }], ['folder', { path: '' }]]
    const rotation = [...titles.done, ...titles.sleepers, titles.long, ...titles.printers, ...titles.stream].filter(Boolean)
    const threads = await list()
    const idOf = (title) => threads.find((thread) => thread.title === title)?.id
    const panesOf = async (id) => (await list()).find((thread) => thread.id === id)?.panes ?? []
    let cycle = 0, turns = 0, panes = 0
    let middle
    let checkpoint = Date.now() + 2 * 60_000
    const end = began + MINUTES * 60_000
    await phase('memory', 'switching, panes and turns', {
      during: async () => {
        while (Date.now() < end) {
          const title = rotation[cycle % rotation.length]
          const id = idOf(title)
          await select(title)
          const [kind, params] = kinds[cycle % kinds.length]
          await run(`window.superego.call('local', 'pane.open', ${JSON.stringify({ thread: id, kind, params })})`)
          const pane = await until(async () => (await panesOf(id)).find((p) => p.kind === kind)?.id, `${kind} pane opened`)
          await until(`Boolean(document.querySelector('[data-column="${pane}"]'))`, `${kind} pane shown`)
          await tick(1500)
          await run(`window.superego.call('local', 'pane.close', ${JSON.stringify({ thread: id, pane })})`)
          await until(`!document.querySelector('[data-column="${pane}"]')`, `${kind} pane closed`)
          panes++
          if (cycle % 2 === 0) {
            await select(titles.memory)
            await sendTo(memory, `Look at module ${cycle % 12}.`)
            await answered(memory, 'a memory run')
            turns++
          }
          cycle++
          if (Date.now() >= checkpoint) {
            checkpoint += 2 * 60_000
            await baseline(`after ${cycle} cycles`)
            if (!middle && Date.now() - began > MINUTES * 30_000) {
              middle = await snapshot('middle')
              scenario.snapshots.middle = brief(middle)
            }
          }
        }
      },
    })
    scenario.cycles = cycle
    scenario.turns = turns
    scenario.panes = panes
    await baseline('end')
    const last = await snapshot('end')
    scenario.snapshots.end = brief(last)
    scenario.growth = growth(first, last)
    if (middle) scenario.growthSinceMiddle = growth(middle, last)
    save()
  }
})

/** The functions the CPU profile spent its time in: by self time, and by total time (each once per sample). */
function hotFunctions(profile) {
  const byId = new Map(profile.nodes.map((node) => [node.id, node]))
  const parent = new Map()
  for (const node of profile.nodes) for (const child of node.children ?? []) parent.set(child, node.id)
  const keyOf = (node) => {
    const { functionName, url, lineNumber } = node.callFrame
    return `${functionName || '(anonymous)'}${url ? ` ${basename(url)}:${lineNumber + 1}` : ''}`
  }
  const self = new Map(), total = new Map()
  let all = 0
  profile.samples.forEach((id, i) => {
    const ms = (profile.timeDeltas[i] ?? 0) / 1000
    all += ms
    const node = byId.get(id)
    self.set(keyOf(node), (self.get(keyOf(node)) ?? 0) + ms)
    const seen = new Set()
    for (let at = id; at !== undefined; at = parent.get(at)) {
      const key = keyOf(byId.get(at))
      if (seen.has(key)) continue
      seen.add(key)
      total.set(key, (total.get(key) ?? 0) + ms)
    }
  })
  const top = (map, n) => [...map].filter(([key]) => !['(root)', '(idle)', '(program)'].includes(key)).sort((a, b) => b[1] - a[1]).slice(0, n).map(([key, ms]) => [key, round(ms), round(ms / all * 100)])
  return { ms: round(all), idleMs: round(self.get('(idle)') ?? 0), programMs: round(self.get('(program)') ?? 0), gcMs: round(self.get('(garbage collector)') ?? 0), self: top(self, 25), total: top(total, 40) }
}

function commitOf() {
  try { return JSON.parse(readFileSync(new URL('../out-profile/main/commit.json', import.meta.url), 'utf8')) } catch { return undefined }
}

/** report.json, and report.md: the numbers as tables. */
function save() {
  writeFileSync(join(OUT, 'report.json'), JSON.stringify(report, null, 2))
  writeFileSync(join(OUT, 'report.md'), markdown(report))
}

function markdown(r) {
  const lines = [`# Renderer profile`, '', `${r.startedAt}, commit ${r.commit?.commit?.slice?.(0, 10) ?? r.commit?.sha?.slice?.(0, 10) ?? '?'}; Electron ${r.electron}; ${r.cpu} (${r.cores} cores, ${r.memoryGB} GB); window opacity ${r.opacity}${r.backgrounding ? ', hidden windows throttled' : ''}; ${r.threads ?? '?'} threads listed.`, '']
  const phases = Object.entries(r.scenarios).flatMap(([scenario, list]) => Object.entries(list).filter(([, p]) => p?.renderer).map(([name, p]) => [scenario, name, p]))
  lines.push('| Scenario | Phase | s | Renderer CPU % mean / p95 | GPU % | RSS MB end | Commits/s | Renders/s | Layouts/s | Styles/s | Mutations/s | Long tasks (ms) | Task % |')
  lines.push('| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |')
  for (const [scenario, name, p] of phases) {
    lines.push(`| ${scenario} | ${name} | ${p.seconds} | ${p.renderer.cpu.mean} / ${p.renderer.cpu.p95} | ${p.gpu.cpu.mean} | ${p.renderer.rssMB.end} | ${p.perSecond.commits} | ${p.perSecond.renders} | ${p.perSecond.layouts} | ${p.perSecond.styleRecalcs} | ${p.perSecond.mutations} | ${p.longTasks.count} (${p.longTasks.totalMs}) | ${p.busy.taskPct} |`)
  }
  for (const [scenario, name, p] of phases) {
    lines.push('', `## ${scenario}: ${name}`, '')
    if (p.frames) lines.push(`Frames: ${JSON.stringify(p.frames)}`, '')
    lines.push(`Components rendered: ${p.components.map(([n, c]) => `${n} ${c}`).join(', ') || 'none'}`, '')
    lines.push(`Callbacks run: ${p.callbacks.map(([n, c]) => `\`${n}\` ${c}`).join(', ') || 'none'}`, '')
    if (p.profile) {
      lines.push(`CPU profile \`${p.profile.file}\`: ${p.profile.ms} ms sampled, idle ${p.profile.idleMs}, program ${p.profile.programMs}, GC ${p.profile.gcMs}.`, '')
      lines.push('| Self ms | % | Function |', '| ---: | ---: | --- |')
      for (const [key, ms, pct] of p.profile.self.slice(0, 15)) lines.push(`| ${ms} | ${pct} | \`${key}\` |`)
      lines.push('', '| Total ms | % | Function |', '| ---: | ---: | --- |')
      for (const [key, ms, pct] of p.profile.total.slice(0, 25)) lines.push(`| ${ms} | ${pct} | \`${key}\` |`)
    }
  }
  if (r.scenarios.idle?.animations) lines.push('', '## Endless animations while idle', '', ...r.scenarios.idle.animations.map((a) => `- ${a.name} on \`${a.target}\` (${a.props.join(', ')})${a.visible ? '' : ', not visible'}`))
  const t = r.scenarios.transcript
  if (t?.open) lines.push('', '## The long transcript', '', `Opened in ${t.open.ms} ms. Before: ${JSON.stringify(t.open.before)}. Shown: ${JSON.stringify(t.open.after)}. Every run opened: ${JSON.stringify(t.opened)}. Left: ${JSON.stringify(t.left)}.`)
  const m = r.scenarios.memory
  if (m?.checkpoints) {
    lines.push('', '## Memory over time', '', `${m.cycles ?? '?'} cycles, ${m.panes ?? '?'} panes opened and closed, ${m.turns ?? '?'} turns run. Each checkpoint: the same thread shown (one that doesn't change), no panes, after a GC.`, '')
    lines.push('| Checkpoint | Minute | Heap MB | DOM nodes | Listeners | On document | On window | Documents | Renderer RSS MB |', '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |')
    const sum = (by = {}) => Object.values(by).reduce((a, b) => a + b, 0)
    for (const c of m.checkpoints) lines.push(`| ${c.label} | ${c.minute} | ${c.heapMB} | ${c.nodes} | ${c.listeners} | ${sum(c.on?.document)} | ${sum(c.on?.window)} | ${c.documents} | ${c.rendererRssMB} |`)
    const [first, last] = [m.checkpoints[0], m.checkpoints.at(-1)]
    const grown = (where) => Object.entries(last?.on?.[where] ?? {}).map(([type, n]) => [type, n - (first?.on?.[where]?.[type] ?? 0)]).filter(([, n]) => n > 0)
    for (const where of ['document', 'window']) if (grown(where).length) lines.push('', `Listeners on ${where} that grew: ${grown(where).map(([type, n]) => `${type} +${n}`).join(', ')}`)
    for (const [label, s] of Object.entries(m.snapshots ?? {})) lines.push('', `Snapshot ${label}: ${s.totalMB} MB, ${s.nodes} objects, ${s.detached.count} detached DOM (${s.detached.sizeMB} MB): ${s.detached.kinds.map(([k, c]) => `${k} ${c}`).join(', ')}`)
    if (m.growth) {
      lines.push('', 'Grew most, start to end (count):', '', '| Kind | +count | +KB | count now |', '| --- | ---: | ---: | ---: |')
      for (const g of m.growth.byCount.slice(0, 20)) lines.push(`| \`${g.kind}\` | ${g.count} | ${g.sizeKB} | ${g.countNow} |`)
      lines.push('', 'Grew most, start to end (size):', '', '| Kind | +count | +KB | count now |', '| --- | ---: | ---: | ---: |')
      for (const g of m.growth.bySize.slice(0, 20)) lines.push(`| \`${g.kind}\` | ${g.count} | ${g.sizeKB} | ${g.countNow} |`)
    }
  }
  return lines.join('\n') + '\n'
}
