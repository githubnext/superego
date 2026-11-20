// A V8 CPU profile (`Profiler.stop`'s, a .cpuprofile) boiled down: self time by function and by file, and the React
// components the time went to. Kept apart from Electron, to test.

export type CallFrame = { functionName: string; url: string; lineNumber: number; columnNumber: number; scriptId?: string }
export type ProfileNode = { id: number; callFrame: CallFrame; children?: number[]; parent?: number }
export type CpuProfile = { nodes: ProfileNode[]; startTime: number; endTime: number; samples?: number[]; timeDeltas?: number[] }

export type Row = { name: string; where: string; ms: number; percent: number }
export type ComponentRow = Row & { inclusiveMs: number; inclusivePercent: number }
export type ProfileSummary = {
  /** How long it sampled, in ms. */
  ms: number
  /** Shares of one core over that time. */
  busyPercent: number; gcPercent: number; programPercent: number
  functions: Row[]; files: Row[]; components: ComponentRow[]
}

const SPECIAL = new Set(['(idle)', '(program)', '(garbage collector)', '(root)'])

/**
 * Where a script is, short: a path without the dev server's origin and query, a dependency by its name.
 * `http://localhost:5173/src/thread-body.tsx?t=1` → `src/thread-body.tsx`; `…/node_modules/.vite/deps/react-dom_client.js?v=1` → `react-dom_client.js`.
 */
export function shortUrl(url: string): string {
  if (!url) return ''
  let path = url
  try {
    const parsed = new URL(url)
    path = parsed.protocol === 'file:' ? decodeURIComponent(parsed.pathname) : parsed.host && parsed.protocol.startsWith('http') ? parsed.pathname : url
  } catch { /* not a URL (a node: builtin, say): as it is */ }
  const deps = path.lastIndexOf('/.vite/deps/')
  if (deps >= 0) return path.slice(deps + '/.vite/deps/'.length)
  const modules = path.lastIndexOf('/node_modules/')
  if (modules >= 0) return path.slice(modules + '/node_modules/'.length).replace(/^\.pnpm\/[^/]+\/node_modules\//, '')
  // `/@fs/<absolute>` from outside the renderer's root: from the repo's packages on.
  const packages = path.indexOf('/packages/')
  if (path.startsWith('/@fs/') && packages >= 0) return path.slice(packages + 1)
  return path.replace(/^\//, '')
}

/** A dependency's code (React's, a library's), not the app's own: its functions aren't components of ours. */
const isDependency = (url: string) => url.includes('/node_modules/') || url.includes('/.vite/deps/')

/** A React component, by its name: a capitalised function in the app's own code. */
const isComponent = (frame: CallFrame) => /^[A-Z][A-Za-z0-9]*$/.test(frame.functionName) && Boolean(frame.url) && !isDependency(frame.url)

export function summarizeProfile(profile: CpuProfile, top = 30): ProfileSummary {
  const byId = new Map(profile.nodes.map((node) => [node.id, node]))
  const parent = new Map<number, number>()
  for (const node of profile.nodes) for (const child of node.children ?? []) parent.set(child, node.id)
  const samples = profile.samples ?? []
  const deltas = profile.timeDeltas ?? []
  // Sample i lasts until the next one (the last until the profile's end), in µs.
  const times: number[] = []
  let at = profile.startTime
  for (let i = 0; i < samples.length; i++) { at += deltas[i] ?? 0; times.push(at) }
  const total = Math.max(1, profile.endTime - profile.startTime)

  const self = new Map<number, number>()
  for (let i = 0; i < samples.length; i++) {
    const lasts = Math.max(0, (i + 1 < samples.length ? times[i + 1]! : profile.endTime) - times[i]!)
    self.set(samples[i]!, (self.get(samples[i]!) ?? 0) + lasts)
  }

  const functions = new Map<string, { name: string; where: string; us: number }>()
  const files = new Map<string, number>()
  const components = new Map<string, { name: string; where: string; own: number; inclusive: number }>()
  let idle = 0, gc = 0, program = 0
  const component = (frame: CallFrame) => {
    const key = `${frame.functionName} ${frame.url}:${frame.lineNumber}`
    let entry = components.get(key)
    if (!entry) components.set(key, entry = { name: frame.functionName, where: `${shortUrl(frame.url)}:${frame.lineNumber + 1}`, own: 0, inclusive: 0 })
    return entry
  }
  for (const [id, us] of self) {
    const node = byId.get(id)
    if (!node) continue
    const frame = node.callFrame
    if (frame.functionName === '(idle)') { idle += us; continue }
    if (frame.functionName === '(garbage collector)') gc += us
    if (frame.functionName === '(program)') program += us
    const where = SPECIAL.has(frame.functionName) ? '' : `${shortUrl(frame.url) || '(native)'}:${frame.lineNumber + 1}`
    const key = `${frame.functionName}|${where}`
    const fn = functions.get(key) ?? { name: frame.functionName || '(anonymous)', where, us: 0 }
    fn.us += us
    functions.set(key, fn)
    const file = SPECIAL.has(frame.functionName) ? frame.functionName : shortUrl(frame.url) || '(native)'
    files.set(file, (files.get(file) ?? 0) + us)
    // The components on its stack: the innermost gets the time as its own; each, once, as inclusive.
    const seen = new Set<string>()
    let innermost = true
    for (let walk: number | undefined = id; walk !== undefined; walk = parent.get(walk)) {
      const f = byId.get(walk)?.callFrame
      if (!f || !isComponent(f)) continue
      const entry = component(f)
      if (innermost) { entry.own += us; innermost = false }
      const key = `${f.functionName} ${f.url}:${f.lineNumber}`
      if (!seen.has(key)) { entry.inclusive += us; seen.add(key) }
    }
  }
  const pct = (us: number) => Math.round(us / total * 1000) / 10
  const ms = (us: number) => Math.round(us / 100) / 10
  const row = (name: string, where: string, us: number): Row => ({ name, where, ms: ms(us), percent: pct(us) })
  return {
    ms: ms(total),
    busyPercent: pct(total - idle), gcPercent: pct(gc), programPercent: pct(program),
    functions: [...functions.values()].sort((a, b) => b.us - a.us).slice(0, top).map((f) => row(f.name, f.where, f.us)),
    files: [...files].sort((a, b) => b[1] - a[1]).slice(0, top).map(([name, us]) => row(name, '', us)),
    components: [...components.values()].sort((a, b) => b.inclusive - a.inclusive).slice(0, top)
      .map((c) => ({ ...row(c.name, c.where, c.own), inclusiveMs: ms(c.inclusive), inclusivePercent: pct(c.inclusive) })),
  }
}
