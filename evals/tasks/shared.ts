// What a task is, and what acceptance checks share.
import { readdirSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { Install } from '../lib/install.ts'
import type { World } from '../lib/env.ts'
import { entriesOf, metricsOf, type Thread } from '../lib/transcript.ts'
import { sleep } from '../lib/env.ts'

export type Checks = Record<string, boolean>
export type Acceptance = { pass: boolean; checks: Checks; notes: string[]; cost: number; artifacts?: Record<string, string> }
export type AcceptContext = { world: World; install: Install; out: string }

export type Task = {
  id: string
  level: number
  /** What the user types, as they would. */
  request: string
  accept(ctx: AcceptContext): Promise<Acceptance>
}

/** The cheap model acceptance probes run on. */
export const PROBE_MODEL = 'anthropic/claude-haiku-4-5'

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
    const thread = (await world.rpc.call<Thread[]>('thread.list', {})).find((t) => t.id === id)
    if (!thread || thread.status.state !== 'working') return thread
    await sleep(2000)
  }
  await world.rpc.call('thread.abort', { id }).catch(() => {})
  return undefined
}

/** A probe thread's cost, from its transcript. */
export async function costOf(world: World, id: string) {
  return metricsOf(await entriesOf(world.rpc, id)).cost
}
