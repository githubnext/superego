// Level 1: a tool for the agent. Acceptance: in the user's project, a new thread (default profile) loads, has a
// weather tool, and calling it works, or fails with a message rather than crashing.
import { entriesOf, toolCalls } from '../lib/transcript.ts'
import { costOf, PROBE_MODEL, profileDirs, settle, type Acceptance, type Task } from './shared.ts'

const PROBE = 'Use your tool that fetches the current weather to get the weather in Copenhagen: call it exactly once. ' +
  "Don't use bash, curl or any other way. If you have no such tool, say NO_WEATHER_TOOL and stop. Then reply with only the tool's raw result."

const BUILTIN = new Set(['read', 'write', 'edit', 'bash', 'ls', 'grep', 'find', 'open_pane', 'show_images', 'ask_user', 'task_start', 'task_finish'])

export const weather: Task = {
  id: 'l1-weather',
  level: 1,
  request: 'Give my agents a tool that fetches the current weather for a city.',
  async accept({ world }) {
    const notes: string[] = []
    const checks = { profile_loads: false, tool_registered: false, tool_runs: false }
    let cost = 0
    const dirs = profileDirs(world)
    notes.push(`profiles: ${dirs.map((d) => d.replace(world.home, '~')).join(', ') || 'none'}`)
    const listed = await world.rpc.call<{ name: string; dir: string; allowed: boolean }[]>('action.run', { id: 'profile.list', params: { cwd: world.project }, exposure: 'cli' }).catch(() => [])
    notes.push(`profile.list in the project: ${listed.map((p) => `${p.name}${p.allowed ? '' : ' (not allowed)'}`).join(', ') || 'none'}`)

    // A new thread in the project, as the user would start one: its default profile.
    const probe = async (profile?: string) => {
      let thread: { id: string }
      try {
        thread = await world.rpc.call('thread.create', { cwd: world.project, title: `Weather probe${profile ? ` (${profile})` : ''}`, model: PROBE_MODEL, prompt: PROBE, ...(profile ? { profile } : {}) })
      } catch (error) {
        notes.push(`probe ${profile ?? 'default'}: thread.create failed: ${(error as Error).message}`)
        return { loads: false, registered: false, runs: false }
      }
      await settle(world, thread.id)
      const entries = await entriesOf(world.rpc, thread.id)
      cost += await costOf(world, thread.id)
      const errors = entries.flatMap((e) => (e.model ?? []).filter((m: any) => m.role === 'assistant' && m.stopReason === 'error').map((m: any) => m.errorMessage))
      if (errors.length) notes.push(`probe ${profile ?? 'default'}: model errors: ${errors.join(' | ').slice(0, 500)}`)
      const calls = toolCalls(entries)
      const call = calls.find((c) => /weather|forecast/i.test(c.name)) ?? calls.find((c) => !BUILTIN.has(c.name))
      notes.push(`probe ${profile ?? 'default'}: calls ${calls.map((c) => c.name).join(', ') || 'none'}${call ? `; ${call.name} → ${call.isError ? 'ERROR ' : ''}${(call.result ?? '').slice(0, 300).replace(/\s+/g, ' ')}` : ''}`)
      const graceful = (text: string) => text.trim().length > 0 && !/\n\s+at .+:\d+:\d+/.test(text) && !/is not a function|Cannot read propert|undefined is not/i.test(text)
      const runs = Boolean(call?.result !== undefined && (call.isError ? graceful(call.result!) : /\d/.test(call.result!)))
      return { loads: !errors.some((e) => /profile|load|allow/i.test(e ?? '')), registered: Boolean(call), runs }
    }

    const main = await probe()
    Object.assign(checks, { profile_loads: main.loads, tool_registered: main.registered, tool_runs: main.runs })
    // Not in the default profile: is it anywhere? (Reported, not passing.)
    if (!main.registered) {
      const other = listed.find((p) => p.name !== 'default')
      if (other) {
        const elsewhere = await probe(other.name)
        ;(checks as any).registered_in_other_profile = elsewhere.registered
      }
    }
    return { pass: checks.profile_loads && checks.tool_registered && checks.tool_runs, checks, notes, cost } satisfies Acceptance
  },
}
