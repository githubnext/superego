// Profiling the windows' renderers as they run, for finding what burns CPU on a real machine rather than in a test's
// replay (app/test/profile.sh does that). For each window, through the debugger on its page: a CPU profile, Chromium's
// own counts (layouts, style recalcs, task time), and what it showed (its thread, panes, running animations); for every
// process, its CPU over the same seconds (`app.getAppMetrics()`), named by the window or web view it draws; and a trace
// of the lot (`contentTracing`). Written to <dataDir>/profiles/<time>/, with a summary to read first.
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app, contentTracing, webContents, type WebContents } from 'electron'
import { RpcError } from '@superego/protocol'
import type { AppWindow } from './app-windows.ts'
import { summarizeProfile, type CpuProfile, type ProfileSummary } from './profile-summary.ts'

export type ProfileOptions = {
  dataDir: string
  seconds: number
  windows: AppWindow[]
  /** Record a trace (all processes) too. */
  trace: boolean
}

/** What a window showed as it was profiled, from its page. */
export type PageInfo = {
  title?: string; visibility?: string; focused?: boolean
  tabs?: { label: string; pane?: string; state: string }[]
  nodes?: number; images?: number; canvases?: number; iframes?: number
  /** Animations running, by name and what they animate. */
  animations?: Record<string, number>
  /** Images not drawn yet (the first 20). */
  loadingImages?: { title: string; asked: boolean; inView: boolean }[]
}

export type WindowResult = {
  window: string
  pid: number
  /** The thread it said it shows (`app.shown`). */
  shown?: { machine: string; thread: string }
  page?: PageInfo
  /** Per second, or as a share of one core (%), over the profile. */
  metrics?: Record<string, number>
  profile?: ProfileSummary
  cpuprofile?: string
  error?: string
}

export type ProcessResult = { pid: number; type: string; name: string; cpu: number; memoryMB: number }

export type ProfileResult = { dir: string; seconds: number; summary: string; trace?: string; traceError?: string; windows: WindowResult[]; processes: ProcessResult[] }

const TRACE_CATEGORIES = [
  'toplevel', 'v8.execute', 'blink', 'cc', 'gpu', 'viz', 'devtools.timeline', 'disabled-by-default-devtools.timeline',
  'disabled-by-default-devtools.timeline.frame', 'blink.user_timing', 'loading',
]

/** What the page shows, read in the page itself (no side effects). */
const PAGE_INFO = `(() => {
  const describe = (el) => {
    if (!el || !el.tagName) return '?'
    const cls = typeof el.className === 'string' ? el.className.trim().split(/\\s+/).filter(Boolean).slice(0, 2).join('.') : ''
    return el.tagName.toLowerCase() + (cls ? '.' + cls : '')
  }
  const animations = {}
  for (const a of document.getAnimations()) {
    if (a.playState !== 'running') continue
    const key = (a.animationName || a.transitionProperty || a.constructor.name) + ' on ' + describe(a.effect && a.effect.target)
    animations[key] = (animations[key] || 0) + 1
  }
  const tabs = [...document.querySelectorAll('.strip__tab')].map((el) => ({
    label: (el.querySelector('.strip__label') || el).textContent.trim(),
    ...(el.dataset.pane ? { pane: el.dataset.pane } : {}),
    state: el.classList.contains('is-focused') ? 'focused' : el.classList.contains('is-shown') ? 'shown' : 'away',
  }))
  // Images not drawn yet: whether each is being read (is-asked) and on the screen.
  const loadingImages = [...document.querySelectorAll('.image-frame.is-loading')].slice(0, 20).map((el) => {
    const r = el.getBoundingClientRect()
    return { title: el.title, asked: el.classList.contains('is-asked'), inView: r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth }
  })
  return {
    title: document.title, visibility: document.visibilityState, focused: document.hasFocus(), tabs, loadingImages,
    nodes: document.getElementsByTagName('*').length, images: document.images.length,
    canvases: document.querySelectorAll('canvas').length, iframes: document.querySelectorAll('iframe').length, animations,
  }
})()`

/** Profile `windows` for `seconds`, all at once. Fails only when nothing could be profiled. */
export async function profileRenderers({ dataDir, seconds, windows, trace }: ProfileOptions): Promise<ProfileResult> {
  if (!windows.length) throw new RpcError('not_found', 'No window to profile')
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace('Z', '')
  const dir = join(dataDir, 'profiles', stamp)
  await mkdir(dir, { recursive: true })

  const before = cpuTimes()
  const sessions = await Promise.all(windows.map((window) => start(window)))
  let traceError: string | undefined
  let tracing = false
  if (trace) {
    try {
      await contentTracing.startRecording({ included_categories: TRACE_CATEGORIES, excluded_categories: ['*'] })
      tracing = true
    } catch (error) {
      traceError = (error as Error).message
      console.error('profile: trace:', error)
    }
  }
  const startedAt = performance.now()
  await new Promise((resolve) => setTimeout(resolve, seconds * 1000))
  const wall = (performance.now() - startedAt) / 1000
  const after = cpuTimes()
  let tracePath: string | undefined
  if (tracing) {
    try { tracePath = await contentTracing.stopRecording(join(dir, 'trace.json')) } catch (error) {
      traceError = (error as Error).message
      console.error('profile: trace:', error)
    }
  }
  const results = await Promise.all(sessions.map((session) => session.stop(dir, wall)))
  const processes = processCpu(before, after, wall)
  const result: ProfileResult = {
    dir, seconds: Math.round(wall * 10) / 10, summary: join(dir, 'summary.md'), windows: results, processes,
    ...(tracePath ? { trace: tracePath } : {}), ...(traceError ? { traceError } : {}),
  }
  await writeFile(join(dir, 'summary.json'), JSON.stringify(result, null, 2) + '\n')
  await writeFile(result.summary, markdown(result))
  if (results.every((r) => r.error)) throw new RpcError('failed', `Couldn't profile: ${results.map((r) => `${r.window}: ${r.error}`).join('; ')}`)
  return result
}

/** Start profiling one window's page; `stop` ends it and writes what it found. A window that can't be profiled says why. */
async function start(window: AppWindow) {
  const contents = window.contents
  const base: WindowResult = { window: window.id, pid: contents.isDestroyed() ? 0 : contents.getOSProcessId(), ...(window.shown ? { shown: window.shown } : {}) }
  const failed = (error: unknown) => ({ stop: async () => ({ ...base, error: (error as Error).message }) })
  if (contents.isDestroyed()) return failed(new Error('The window closed'))
  const debug = contents.debugger
  try { debug.attach('1.3') } catch (error) { console.error(`profile: window ${window.id}:`, error); return failed(error) }
  const send = <T>(method: string, params?: object) => debug.sendCommand(method, params) as Promise<T>
  try {
    const page = (await send<{ result: { value?: PageInfo } }>('Runtime.evaluate', { expression: PAGE_INFO, returnByValue: true })).result.value
    await send('Performance.enable', { timeDomain: 'timeTicks' })
    const metricsBefore = await metrics(send)
    await send('Profiler.enable')
    await send('Profiler.setSamplingInterval', { interval: 250 })
    await send('Profiler.start')
    return {
      async stop(dir: string, wall: number): Promise<WindowResult> {
        try {
          const { profile } = await send<{ profile: CpuProfile }>('Profiler.stop')
          const metricsAfter = await metrics(send)
          const cpuprofile = join(dir, `window-${window.id}.cpuprofile`)
          await writeFile(cpuprofile, JSON.stringify(profile))
          return { ...base, ...(page ? { page } : {}), metrics: rates(metricsBefore, metricsAfter, wall), profile: summarizeProfile(profile), cpuprofile }
        } catch (error) {
          console.error(`profile: window ${window.id}:`, error)
          return { ...base, error: (error as Error).message }
        } finally { detach(debug) }
      },
    }
  } catch (error) {
    console.error(`profile: window ${window.id}:`, error)
    detach(debug)
    return failed(error)
  }
}

function detach(debug: Electron.Debugger) {
  // Detaching a debugger whose page went away throws; there's nothing left to detach then.
  try { if (debug.isAttached()) debug.detach() } catch (error) { console.error('profile: detach:', error) }
}

async function metrics(send: <T>(method: string, params?: object) => Promise<T>) {
  const { metrics } = await send<{ metrics: { name: string; value: number }[] }>('Performance.getMetrics')
  return Object.fromEntries(metrics.map((m) => [m.name, m.value]))
}

/** Chromium's counts over the profile: durations as a share of one core, counts per second, sizes as they ended. */
function rates(before: Record<string, number>, after: Record<string, number>, wall: number): Record<string, number> {
  const delta = (name: string) => (after[name] ?? 0) - (before[name] ?? 0)
  const round = (n: number) => Math.round(n * 10) / 10
  return {
    taskPercent: round(delta('TaskDuration') / wall * 100),
    scriptPercent: round(delta('ScriptDuration') / wall * 100),
    layoutPercent: round(delta('LayoutDuration') / wall * 100),
    stylePercent: round(delta('RecalcStyleDuration') / wall * 100),
    layoutsPerSecond: round(delta('LayoutCount') / wall),
    styleRecalcsPerSecond: round(delta('RecalcStyleCount') / wall),
    nodes: after.Nodes ?? 0,
    listeners: after.JSEventListeners ?? 0,
    heapMB: round((after.JSHeapUsedSize ?? 0) / 1e6),
  }
}

/** Each process's CPU time so far (seconds), with what it is. */
function cpuTimes() {
  return new Map(app.getAppMetrics().map((m) => [m.pid, { metric: m, cpu: m.cpu.cumulativeCPUUsage }]))
}

function processCpu(before: ReturnType<typeof cpuTimes>, after: ReturnType<typeof cpuTimes>, wall: number): ProcessResult[] {
  // What each renderer draws: an app window, a web view in a pane, …
  const drawn = new Map<number, string[]>()
  for (const contents of webContents.getAllWebContents()) {
    if (contents.isDestroyed()) continue
    const pid = contents.getOSProcessId()
    drawn.set(pid, [...drawn.get(pid) ?? [], describe(contents)])
  }
  return [...after.values()].map(({ metric, cpu }) => {
    const was = before.get(metric.pid)?.cpu
    const used = cpu !== undefined && was !== undefined ? (cpu - was) / wall * 100 : metric.cpu.percentCPUUsage
    return {
      pid: metric.pid, type: metric.type, name: drawn.get(metric.pid)?.join(', ') ?? metric.name ?? metric.serviceName ?? metric.type,
      cpu: Math.round(used * 10) / 10, memoryMB: Math.round(metric.memory.workingSetSize / 1024),
    }
  }).sort((a, b) => b.cpu - a.cpu)
}

function describe(contents: WebContents) {
  const type = contents.getType()
  const url = contents.getURL()
  if (type === 'window') return `window ${contents.id}${url ? ` (${shortUrl(url)})` : ''}`
  return `${type === 'browserView' ? 'web view' : type} ${shortUrl(url) || '(blank)'}`
}

const shortUrl = (url: string) => url.length > 80 ? `${url.slice(0, 77)}…` : url

/** The summary to read first. */
function markdown(result: ProfileResult): string {
  const lines = [`# Renderer profile, ${result.seconds} s`, '', `Written to ${result.dir}.`, '']
  lines.push('## Processes (CPU as a share of one core)', '', '| pid | CPU % | MB | what |', '| ---: | ---: | ---: | --- |')
  for (const p of result.processes) lines.push(`| ${p.pid} | ${p.cpu} | ${p.memoryMB} | ${p.type}: ${p.name} |`)
  for (const w of result.windows) {
    lines.push('', `## Window ${w.window} (pid ${w.pid})`, '')
    if (w.error) { lines.push(`Not profiled: ${w.error}`); continue }
    if (w.shown) lines.push(`Shows thread ${w.shown.machine}/${w.shown.thread}.`)
    const page = w.page
    if (page) {
      lines.push(`Page: ${page.visibility}${page.focused ? ', focused' : ''}; ${page.nodes} nodes, ${page.images} images, ${page.canvases} canvases, ${page.iframes} iframes.`)
      if (page.tabs?.length) lines.push(`Tabs: ${page.tabs.map((t) => `${t.label} (${t.state})`).join(', ')}.`)
      const animations = Object.entries(page.animations ?? {}).sort((a, b) => b[1] - a[1])
      if (animations.length) lines.push(`Running animations: ${animations.map(([what, n]) => `${n}× ${what}`).join('; ')}.`)
      if (page.loadingImages?.length) lines.push(`Images not drawn yet: ${page.loadingImages.map((i) => `${i.title || '(untitled)'}${i.asked ? ', being read' : ', waiting'}${i.inView ? ', in view' : ''}`).join('; ')}.`)
    }
    if (w.metrics) {
      const m = w.metrics
      lines.push('', `Main thread busy ${m.taskPercent}% (script ${m.scriptPercent}%, layout ${m.layoutPercent}%, style ${m.stylePercent}%); ${m.layoutsPerSecond} layouts/s, ${m.styleRecalcsPerSecond} style recalcs/s; ${m.nodes} nodes, ${m.listeners} listeners, ${m.heapMB} MB heap.`)
    }
    if (w.profile) {
      const p = w.profile
      lines.push(`Sampled ${p.ms} ms: busy ${p.busyPercent}% of one core (GC ${p.gcPercent}%, program ${p.programPercent}%).`, '')
      lines.push('### Functions by self time', '', '| % | ms | function | where |', '| ---: | ---: | --- | --- |')
      for (const f of p.functions) lines.push(`| ${f.percent} | ${f.ms} | ${f.name} | ${f.where} |`)
      lines.push('', '### Files by self time', '', '| % | ms | file |', '| ---: | ---: | --- |')
      for (const f of p.files) lines.push(`| ${f.percent} | ${f.ms} | ${f.name} |`)
      lines.push('', '### Components (innermost on the stack: its own work; inclusive: with what it called)', '', '| own % | inclusive % | component | where |', '| ---: | ---: | --- | --- |')
      for (const c of p.components) lines.push(`| ${c.percent} | ${c.inclusivePercent} | ${c.name} | ${c.where} |`)
      lines.push('', `CPU profile: ${w.cpuprofile} (open it in DevTools' Performance panel).`)
    }
  }
  if (result.trace) lines.push('', `Trace: ${result.trace} (open it in https://ui.perfetto.dev or chrome://tracing).`)
  if (result.traceError) lines.push('', `No trace: ${result.traceError}`)
  return lines.join('\n') + '\n'
}
