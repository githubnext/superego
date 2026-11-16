// What a task is, and what acceptance checks share.
import { readdirSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { ProfileInfo } from '@superego/protocol'
import type { Install } from '../lib/install.ts'
import { sleep, type World } from '../lib/env.ts'
import { entriesOf, metricsOf, type Thread } from '../lib/transcript.ts'

export type Checks = Record<string, boolean>
export type Acceptance = { pass: boolean; checks: Checks; notes: string[]; cost: number; artifacts?: Record<string, string> }
export type AcceptContext = { world: World; install: Install; out: string }

export type Task = {
  id: string
  level: number
  /** What the user types, as they would. */
  request: string
  /** Make the user's project what the task needs, before the request. */
  setup?(world: World): void
  accept(ctx: AcceptContext): Promise<Acceptance>
}

/** The cheap model acceptance probes run on. */
export const PROBE_MODEL = 'anthropic/claude-haiku-5-5'
/** A mid-sized model, for a probe that has to follow a profile's instructions (a lead handing work out). */
export const LEAD_MODEL = 'anthropic/claude-sonnet-5-5'

/** Profile folders the run left: the user's, and any project's under the home (not in node_modules or dot folders). */
export function profileDirs(world: World): string[] {
  const found: string[] = []
  const user = join(world.dataDir, 'profiles')
  if (existsSync(user)) for (const name of readdirSync(user)) if (existsSync(join(user, name, 'profile.ts')) || existsSync(join(user, name, 'profile.js'))) found.push(join(user, name))
  const walk = (dir: string, depth: number) => {
    if (depth > 5) return
    let entries: string[] = []
    try { entries = readdirSync(dir) } catch { return }
    for (const name of entries) {
      const path = join(dir, name)
      if (name === '.superego' && dir !== world.home) {
        const profiles = join(path, 'profiles')
        if (existsSync(profiles)) for (const p of readdirSync(profiles)) found.push(join(profiles, p))
        continue
      }
      if (name.startsWith('.') || name === 'node_modules') continue
      // A link to nowhere (an agent's dangling symlink) is no profile folder.
      try { if (statSync(path).isDirectory()) walk(path, depth + 1) } catch {}
    }
  }
  walk(world.home, 0)
  return found
}

/** Source files of a profile folder (not its node_modules). */
export function sourcesOf(dir: string): string[] {
  const files: string[] = []
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      if (name === 'node_modules' || name.startsWith('.')) continue
      const path = join(d, name)
      if (statSync(path).isDirectory()) walk(path)
      else if (/\.(ts|tsx|js|mjs|jsx)$/.test(name)) files.push(path)
    }
  }
  walk(dir)
  return files
}

/** Wait until a thread stops working; its info then. */
export async function settle(world: World, id: string, ms = 180_000): Promise<Thread | undefined> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const thread = (await world.rpc.call('thread.list', {})).find((t) => t.id === id)
    if (!thread || thread.status.state !== 'working') return thread
    await sleep(2000)
  }
  await stopThread(world, id)
  return undefined
}

/** Stop a thread, saying so on the console if that fails (it can have stopped by itself meanwhile). */
export async function stopThread(world: World, id: string) {
  await world.rpc.call('thread.stop', { thread: id }).catch((error) => console.error(`eval: stopping ${id}:`, error))
}

/** The profiles a thread in the project can start with (`profile.list`), noted; none, and why, if that fails. */
export async function projectProfiles(world: World, notes: string[]): Promise<ProfileInfo[]> {
  try {
    const listed = await world.rpc.action<ProfileInfo[]>('profile.list', { cwd: world.project })
    notes.push(`profile.list in the project: ${listed.map((p) => `${p.name}${p.allowed ? '' : ' (not allowed)'}`).join(', ') || 'none'}`)
    return listed
  } catch (error) {
    notes.push(`profile.list in the project failed: ${(error as Error).message}`)
    return []
  }
}

/** A probe thread's cost, from its transcript. */
export async function costOf(world: World, id: string) {
  return metricsOf(await entriesOf(world.rpc, id)).cost
}

/**
 * Wait until a thread and every thread under it (by `parent`) are quiet a while, so reports have time to arrive; or stop
 * them all at `ms` or once they've cost `cost`. Their info then, and why it stopped.
 */
export async function quiet(world: World, root: string, { ms, cost }: { ms: number; cost: number }): Promise<{ threads: Thread[]; stop: string }> {
  const end = Date.now() + ms
  let still = 0
  const family = async () => {
    // Archived too: a lead may put its workers away once it's reviewed them.
    const all = [...await world.rpc.call('thread.list', {}), ...await world.rpc.call('thread.list', { archived: true })]
    const ids = new Set([root])
    for (let grew = true; grew;) { grew = false; for (const t of all) if (t.parent && ids.has(t.parent) && !ids.has(t.id)) { ids.add(t.id); grew = true } }
    return all.filter((t) => ids.has(t.id))
  }
  while (true) {
    await sleep(3000)
    const threads = await family()
    const over = Date.now() > end ? 'time limit' : threads.reduce((s, t) => s + (t.cost ?? 0), 0) > cost ? 'cost limit' : undefined
    if (over) {
      for (const t of threads) if (t.status.state === 'working') await stopThread(world, t.id)
      await sleep(2000)
      return { threads: await family(), stop: over }
    }
    still = threads.some((t) => t.status.state === 'working') ? 0 : still + 1
    if (still >= 5) return { threads, stop: 'quiet' }
  }
}
