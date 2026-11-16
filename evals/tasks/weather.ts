// Level 1: a tool for the agent. Acceptance: in the user's project, a new thread (default profile) loads, has a
// weather tool, and calling it works. Then the same call with no network: the profile's copy in `superego/testing`'s
// daemon, a scripted model calling the tool with the arguments the probe used, under a sandbox that refuses every
// connection; the tool should answer with a message, not crash or hang.
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { World } from '../lib/env.ts'
import type { Install } from '../lib/install.ts'
import { entriesOf, toolCalls, type Thread } from '../lib/transcript.ts'
import { costOf, PROBE_MODEL, profileDirs, settle, type Acceptance, type Task } from './shared.ts'

const PROBE = 'Use your tool that fetches the current weather to get the weather in Copenhagen: call it exactly once. ' +
  "Don't use bash, curl or any other way. If you have no such tool, say NO_WEATHER_TOOL and stop. Then reply with only the tool's raw result."

const BUILTIN = new Set(['read', 'write', 'edit', 'bash', 'ls', 'grep', 'find', 'open_pane', 'show_images', 'ask_user', 'task_start', 'task_finish'])

/** A tool's answer that reads as a message: no stack trace, no JavaScript error leaking out. */
const graceful = (text: string) => text.trim().length > 0 && !/\n\s+at .+:\d+:\d+/.test(text) && !/is not a function|Cannot read propert|undefined is not/i.test(text)

/** No connections out but to unix sockets: what a machine with no network is like, for the tool and anything it runs. */
const NO_NETWORK = '(version 1)\n(allow default)\n(deny network-outbound (remote ip "*:*"))\n'

export const weather: Task = {
  id: 'l1-weather',
  level: 1,
  request: 'Give my agents a tool that fetches the current weather for a city.',
  async accept({ world, install, out }) {
    const notes: string[] = []
    const checks: Record<string, boolean> = { profile_loads: false, tool_registered: false, tool_runs: false, offline_graceful: false }
    let cost = 0
    const dirs = profileDirs(world)
    notes.push(`profiles: ${dirs.map((d) => d.replace(world.home, '~')).join(', ') || 'none'}`)
    const listed = await world.rpc.call<{ name: string; dir: string; allowed: boolean }[]>('action.run', { id: 'profile.list', params: { cwd: world.project }, exposure: 'cli' }).catch(() => [])
    notes.push(`profile.list in the project: ${listed.map((p) => `${p.name}${p.allowed ? '' : ' (not allowed)'}`).join(', ') || 'none'}`)

    // A new thread in the project, as the user would start one: its default profile.
    const probe = async (profile?: string) => {
      let thread: Thread
      try {
        thread = await world.rpc.call('thread.create', { cwd: world.project, title: `Weather probe${profile ? ` (${profile})` : ''}`, model: PROBE_MODEL, prompt: PROBE, ...(profile ? { profile } : {}) })
      } catch (error) {
        notes.push(`probe ${profile ?? 'default'}: thread.create failed: ${(error as Error).message}`)
        return { loads: false, registered: false, runs: false }
      }
      const settled = await settle(world, thread.id)
      const entries = await entriesOf(world.rpc, thread.id)
      cost += await costOf(world, thread.id)
      const errors = entries.flatMap((e) => (e.model ?? []).filter((m: any) => m.role === 'assistant' && m.stopReason === 'error').map((m: any) => m.errorMessage))
      if (errors.length) notes.push(`probe ${profile ?? 'default'}: model errors: ${errors.join(' | ').slice(0, 500)}`)
      const calls = toolCalls(entries)
      const call = calls.find((c) => /weather|forecast/i.test(c.name)) ?? calls.find((c) => !BUILTIN.has(c.name))
      notes.push(`probe ${profile ?? 'default'}: calls ${calls.map((c) => c.name).join(', ') || 'none'}${call ? `; ${call.name} → ${call.isError ? 'ERROR ' : ''}${(call.result ?? '').slice(0, 300).replace(/\s+/g, ' ')}` : ''}`)
      const runs = Boolean(call?.result !== undefined && (call.isError ? graceful(call.result!) : /\d/.test(call.result!)))
      return { loads: !errors.some((e) => /profile|load|allow/i.test(e ?? '')), registered: Boolean(call), runs, call, profile: settled?.profile ?? thread.profile }
    }

    const main = await probe()
    Object.assign(checks, { profile_loads: main.loads, tool_registered: main.registered, tool_runs: main.runs })
    // Not in the default profile: is it anywhere? (Reported, not passing.)
    if (!main.registered) {
      const other = listed.find((p) => p.name !== 'default')
      if (other) checks.registered_in_other_profile = (await probe(other.name)).registered
    }
    if (main.call && main.profile?.dir) {
      const offline = offlineCall(world, install, out, main.profile, main.call.name, main.call.args ?? {})
      notes.push(`offline: ${offline.note}`)
      checks.offline_graceful = offline.graceful
    }
    return { pass: checks.profile_loads! && checks.tool_registered! && checks.tool_runs! && checks.offline_graceful!, checks, notes, cost } satisfies Acceptance
  },
}

/**
 * The tool called once with no network, deterministically: the profile copied (without its tsconfig, so no type check
 * stands in the way), a test beside it that starts `superego/testing`'s daemon with it and a model scripted to call the
 * tool, run by `superego extension test`'s runner on the app's own runtime, under the no-network sandbox.
 */
function offlineCall(world: World, install: Install, out: string, profile: { name: string; dir?: string }, tool: string, args: Record<string, unknown>): { graceful: boolean; note: string } {
  const copy = join(world.dir, 'offline', 'profile')
  rmSync(join(world.dir, 'offline'), { recursive: true, force: true })
  mkdirSync(copy, { recursive: true })
  cpSync(profile.dir!, copy, { recursive: true, filter: (src) => !/\/(node_modules|\.git)(\/|$)/.test(src) && !src.endsWith('/tsconfig.json') })
  const result = join(world.dir, 'offline', 'result.json')
  writeFileSync(join(copy, 'eval-offline.test.ts'), `import { it } from 'vitest'
import { writeFileSync } from 'node:fs'
import { callTool, say, testDaemon } from 'superego/testing'

it('calls the tool with no network', async () => {
  const daemon = await testDaemon({ profile: ${JSON.stringify(copy)}, profileName: ${JSON.stringify(profile.name)}, model: [callTool(${JSON.stringify(tool)}, ${JSON.stringify(args)}), say('Done.')] })
  try {
    const started = Date.now()
    const thread = await daemon.thread('What is the weather?')
    const history = await daemon.call('thread.history', { id: thread.id, before: Number.MAX_SAFE_INTEGER, limit: 200 })
    writeFileSync(${JSON.stringify(result)}, JSON.stringify({ ms: Date.now() - started, entries: history.entries }))
  } finally {
    await daemon.close()
  }
}, 90_000)
`)
  const sandbox = join(world.dir, 'offline', 'no-network.sb')
  writeFileSync(sandbox, NO_NETWORK)
  const ran = spawnSync('sandbox-exec', ['-f', sandbox, install.electron, join(install.out, 'main', 'author-test.js'), '--types', join(world.dataDir, 'types'), copy, 'eval-offline.test.ts'], {
    cwd: copy, env: { ...world.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', timeout: 150_000,
  })
  writeFileSync(join(out, 'offline.log'), `${ran.stdout ?? ''}\n${ran.stderr ?? ''}`)
  if (!existsSync(result)) return { graceful: false, note: `the test didn't finish (exit ${ran.status}${ran.signal ? `, ${ran.signal}` : ''}): ${`${ran.stdout}${ran.stderr}`.slice(-400).replace(/\s+/g, ' ')}` }
  const { ms, entries } = JSON.parse(readFileSync(result, 'utf8')) as { ms: number; entries: any[] }
  const call = toolCalls(entries).find((c) => c.name === tool)
  if (call?.result === undefined) return { graceful: false, note: `no result from ${tool} in ${ms}ms` }
  // A message, either as an error result or as a result that says it couldn't (not made-up weather).
  const ok = graceful(call.result) && (call.isError || /unavailable|could not|couldn't|failed|error|unable|network|offline|reach/i.test(call.result))
  return { graceful: ok, note: `${tool} → ${call.isError ? 'ERROR ' : ''}${call.result.slice(0, 300).replace(/\s+/g, ' ')} (${ms}ms)` }
}
