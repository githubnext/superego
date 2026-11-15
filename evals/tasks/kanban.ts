// Level 3: a pane. Acceptance, in the installed app's window (headless) on the run's daemon: in the user's project, a
// thread with the default profile (else the profile the run made) opens the pane kind the run's profile registers, and
// the pane draws the user's threads, and a thread started afterwards (live data).
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { profileDirs, sourcesOf, type Acceptance, type Task } from './shared.ts'

/** Threads in the project before the check, as a user would have: their titles must show on the board. */
const SEEDED = ['Fix the login bug', 'Write the release notes', 'Plan the Q3 roadmap']

/** Pane kinds (or views, which are pane kinds too) a profile's code registers, by name. */
export function kindsIn(dir: string): string[] {
  const kinds = new Set<string>()
  const code = sourcesOf(dir).map((file) => readFileSync(file, 'utf8')).join('\n')
  for (const m of code.matchAll(/\.(?:pane|view)\(\s*(?:['"`]([\w.:-]+)['"`]|([A-Za-z_$][\w$.]*))/g)) {
    if (m[1]) kinds.add(m[1])
    // A constant (`superego.pane(PANE, …)`, `about.name`): its value, wherever the profile defines it.
    else for (const d of code.matchAll(new RegExp(`\\b${m[2]!.split('.').at(-1)}\\s*[:=]\\s*['"\`]([\\w.:-]+)['"\`]`, 'g'))) kinds.add(d[1]!)
  }
  // The pane kinds a profile.ts describes to the agent (`panes: { kanban: '…' }`).
  const panes = /panes\s*:\s*\{([^}]*)\}/.exec(code)?.[1]
  if (panes) for (const m of panes.matchAll(/['"]?([\w.:-]+)['"]?\s*:/g)) kinds.add(m[1]!)
  return [...kinds]
}

export const kanban: Task = {
  id: 'l3-kanban',
  level: 3,
  request: 'Add a kanban board of my threads.',
  async accept({ world, install, out }) {
    const notes: string[] = []
    const dirs = profileDirs(world)
    notes.push(`profiles: ${dirs.map((d) => d.replace(world.home, '~')).join(', ') || 'none'}`)
    const listed = await world.rpc.call<{ name: string; dir: string; allowed: boolean }[]>('action.run', { id: 'profile.list', params: { cwd: world.project }, exposure: 'cli' }).catch(() => [])
    notes.push(`profile.list in the project: ${listed.map((p) => `${p.name}${p.allowed ? '' : ' (not allowed)'}`).join(', ') || 'none'}`)
    // Kinds by profile name, for the profiles a thread in the project can start with.
    const probes = listed.map((p) => ({ profile: p.name === 'default' ? undefined : p.name, kinds: kindsIn(p.dir) })).filter((p) => p.kinds.length)
    // Most likely first: the default profile, and kinds that sound like a board.
    probes.sort((a, b) => Number(Boolean(a.profile)) - Number(Boolean(b.profile)))
    for (const p of probes) p.kinds.sort((a, b) => Number(!/kanban|board/i.test(a)) - Number(!/kanban|board/i.test(b)))
    for (const p of probes) p.kinds = p.kinds.slice(0, 3)
    notes.push(`pane kinds found: ${probes.map((p) => `${p.profile ?? 'default'}: ${p.kinds.join(', ')}`).join('; ') || 'none'}`)
    const unlisted = dirs.filter((d) => !listed.some((p) => p.dir === d))
    if (unlisted.length) notes.push(`profiles a project thread can't use: ${unlisted.map((d) => `${d.replace(world.home, '~')} (${kindsIn(d).join(', ') || 'no kinds'})`).join('; ')}`)

    const checks: Record<string, boolean> = { pane_kind_found: probes.length > 0, pane_opens: false, renders_threads: false, columns_by_status: false, live_updates: false, in_default_profile: false }
    if (!probes.length) return { pass: false, checks, notes, cost: 0 }

    for (const title of SEEDED) await world.rpc.call('thread.create', { cwd: world.project, title })
    const shots = join(out, 'shots')
    mkdirSync(shots, { recursive: true })
    const resultFile = join(out, 'pane-check.json')
    const env: Record<string, string> = { ...world.env, SUPEREGO_HEADLESS: '1', EVAL_PANE_CHECK: JSON.stringify({ main: join(install.out, 'main', 'main.js'), project: world.project, titles: SEEDED, probes, shots, out: resultFile }) }
    const ran = spawnSync(install.electron, [join(import.meta.dirname, '..', 'lib', 'pane-check.mjs')], { env, encoding: 'utf8', timeout: 200_000 })
    let result: { kinds: Record<string, any>; errors: string[]; console: string[] }
    try { result = JSON.parse(readFileSync(resultFile, 'utf8')) } catch {
      notes.push(`window check didn't report: ${(ran.stderr ?? '').slice(-800)}`)
      return { pass: false, checks, notes, cost: 0 }
    }
    if (result.errors.length) notes.push(`window: ${result.errors.join(' | ').slice(0, 600)}`)
    if (result.console.length) notes.push(`console: ${result.console.slice(0, 5).join(' | ').slice(0, 800)}`)
    const artifacts: Record<string, string> = {}
    // The best kind: the one that drew the most.
    const score = (r: any) => (r.opened ? 1 : 0) + (r.failed ? -1 : 0) + SEEDED.filter((t) => r.text.includes(t)).length * 2 + (r.live ? 1 : 0)
    const reports = Object.values(result.kinds).sort((a: any, b: any) => score(b) - score(a))
    for (const r of reports) notes.push(`${r.profile}:${r.kind}: opened=${r.opened} failed=${r.failed} live=${r.live} seeded=${SEEDED.filter((t) => r.text.includes(t)).length}/3 text="${r.text.slice(0, 200).replace(/\s+/g, ' ')}"${r.error ? ` error=${r.error}` : ''}`)
    const best = reports[0] as any
    if (best) {
      // Opened, drawn by the profile's UI: not failed, and not the window's stand-in for a kind it doesn't know.
      checks.pane_opens = best.opened && !best.failed && !best.error && !/No pane of kind/.test(best.text)
      checks.renders_threads = SEEDED.filter((t) => best.text.includes(t)).length >= 2
      checks.columns_by_status = ['idle', 'working', 'done', 'blocked', 'error', 'waiting', 'needs'].filter((s) => best.text.toLowerCase().includes(s)).length >= 2
      checks.live_updates = best.live
      checks.in_default_profile = best.profile === 'default'
      if (best.screenshot) artifacts.screenshot = best.screenshot
      notes.push(`best: ${best.profile}:${best.kind}${best.screenshot ? ` (${basename(best.screenshot)})` : ''}`)
    }
    return { pass: checks.pane_opens && checks.renders_threads, checks, notes, cost: 0, artifacts } satisfies Acceptance
  },
}
