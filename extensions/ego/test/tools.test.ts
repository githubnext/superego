import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { defineAction, obj, opt, Router, str, unknown, type MachineEntry, type SettingsSnapshot, type ThreadInfo } from '@superego/protocol'
import { egoTools, egoPrompt, type EgoMachines, type EgoThreads } from '../src/tools.ts'

type Tool = { name: string; execute(params: unknown, api: unknown, context?: unknown): Promise<{ output: { text: string }[] }> }
const text = async (tools: readonly unknown[], name: string, params: unknown) => {
  const tool = (tools as Tool[]).find((t) => t.name === name)!
  return (await tool.execute(params, { conversationId: 1 }, {})).output[0]!.text
}
const run = async (tools: readonly unknown[], name: string, params: unknown) => JSON.parse(await text(tools, name, params)) as unknown

const thread = (id: string, title: string, extra: Partial<ThreadInfo> = {}): ThreadInfo =>
  ({ id, title, cwd: '/p', createdAt: 0, activeAt: 0, project: { root: '/p', name: 'p' }, status: { state: 'idle' }, ...extra })

/** What the tools run actions with: `router`'s, as the daemon gives an extension its own. */
const on = (router: Router) => ({ dispatch: (id: string, params: unknown) => router.dispatch(id, params, {}, { source: 'ego' }), actions: router.list.bind(router) })

describe("Ego's tools", () => {
  const snapshot = async (): Promise<SettingsSnapshot> => ({
    sections: [{ id: 'agent', title: 'Agent', order: 1, settings: [{ key: 'agent.model', title: 'Model', default: null, type: 'string' }] }],
    values: { 'agent.model': 'faux/faux-1' },
  })
  const threads = (started: Parameters<EgoThreads['start']>[0][] = []): EgoThreads => ({
    info: async (id) => [thread('1', 'Fix login'), thread('2', 'Notes', { project: { root: '/q', name: 'q' } })].find((t) => t.id === id),
    list: async () => [thread('1', 'Fix login'), thread('2', 'Notes', { project: { root: '/q', name: 'q' } })],
    start: async (params) => { started.push(params); return thread('3', params.title ?? 'New', { cwd: params.cwd }) },
    answer: async () => undefined,
  })

  it('reads settings, actions, profiles, machines, threads and files, and changes settings and machines; nothing else', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'superego-ego-'))
    try {
      const router = new Router()
      router.register(defineAction({ id: 'echo.say', title: 'Say', runs: 'machine', expose: ['cli'], params: obj({ text: str() }), run: ({ text }) => ({ said: text }) }))
      const set: unknown[] = []
      router.register(defineAction({ id: 'settings.set', title: 'Set', runs: 'machine', expose: ['cli'], params: obj({ key: str(), value: unknown() }), run: (params) => { set.push(params); return null } }))
      router.register(defineAction({ id: 'profile.list', title: 'Profiles', runs: 'machine', expose: ['cli'], params: obj({ cwd: opt(str()) }), run: ({ cwd }) => [{ name: 'default', dir: cwd }] }))
      const box: MachineEntry = { id: 'm1', label: 'box', state: 'connected', remote: { route: 'ssh me@box superego connect --start', enabled: true, ssh: true } }
      const machines: EgoMachines = { list: () => [box], add: async () => box, update: async () => box, remove: async () => {} }
      const { tools = [] } = egoTools({ dir, ...on(router), snapshot, machines, threads: threads() })
      const names = (tools as unknown as Tool[]).map((t) => t.name)
      expect(names.sort()).toEqual(['ls', 'read', 'superego_actions', 'superego_machines', 'superego_mcp_servers', 'superego_profiles', 'superego_set_setting', 'superego_settings', 'thread_list', 'thread_read', 'thread_start'])
      // Setup (settings, machines) is what it changes itself; files, profiles, skills and code go to threads, so it has
      // no tool that writes or runs anything.
      for (const mutating of ['write', 'edit', 'bash', 'superego_run', 'thread_send']) expect(names).not.toContain(mutating)
      expect(await text(tools, 'superego_set_setting', { key: 'web.access', value: 'local' })).toBe('Set web.access to "local".')
      expect(set).toEqual([{ key: 'web.access', value: 'local' }])
      // Not what outside agents may do: one of them could be asking.
      await expect(run(tools, 'superego_set_setting', { key: 'outside.startThreads', value: true })).rejects.toThrow(/Only the user/)
      expect(set).toHaveLength(1)
      // What it reads.
      expect((await run(tools, 'superego_actions', {}) as { id: string }[]).map((a) => a.id)).toEqual(['echo.say', 'settings.set', 'profile.list'])
      expect(await run(tools, 'superego_settings', {})).toEqual([{ id: 'agent', title: 'Agent', settings: [{ key: 'agent.model', title: 'Model', type: { type: 'string' }, default: null, value: 'faux/faux-1' }] }])
      expect(await run(tools, 'superego_machines', { op: 'list' })).toEqual([{ id: 'm1', label: 'box', state: 'connected', route: 'ssh me@box superego connect --start', enabled: true }])
      expect(await run(tools, 'superego_profiles', { cwd: 'proj' })).toEqual([{ name: 'default', dir: join(dir, 'proj') }])
      await mkdir(join(dir, 'profiles'))
      await writeFile(join(dir, 'settings.json'), '{}')
      expect(await text(tools, 'ls', {})).toBe(`${dir}:\nprofiles/\nsettings.json`)
      const listed = await text(tools, 'thread_list', {})
      expect(listed).toContain('p (/p):\n- [Fix login](thread:1): idle, in /p')
      expect(listed).toContain('q (/q):\n- [Notes](thread:2)')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('adds, renames, disables and removes machines in the list it is given', async () => {
    let list: MachineEntry[] = []
    const entry = (id: string, label: string, target: string, enabled = true): MachineEntry =>
      ({ id, label, state: enabled ? 'connecting' : 'disabled', remote: { route: `ssh ${target}`, enabled, ssh: true } })
    const machines: EgoMachines = {
      list: () => list,
      add: async ({ label, target = '' }) => { const added = entry(`m${list.length + 1}`, label ?? target, target); list = [...list, added]; return added },
      update: async (id, { label, enabled }) => {
        list = list.map((m) => m.id === id ? entry(m.id, label ?? m.label, m.remote!.route.slice(4), enabled ?? m.remote!.enabled) : m)
        return list.find((m) => m.id === id)!
      },
      remove: async (id) => { list = list.filter((m) => m.id !== id) },
    }
    const { tools = [] } = egoTools({ dir: '/data', ...on(new Router()), snapshot, machines, threads: threads() })
    await run(tools, 'superego_machines', { op: 'add', target: 'me@box', name: 'box' })
    await run(tools, 'superego_machines', { op: 'rename', machine: 'box', name: 'Build box' })
    await run(tools, 'superego_machines', { op: 'disable', machine: 'Build box' })
    expect(await run(tools, 'superego_machines', { op: 'list' })).toEqual([{ id: 'm1', label: 'Build box', state: 'disabled', route: 'ssh me@box', enabled: false }])
    await run(tools, 'superego_machines', { op: 'remove', machine: 'm1' })
    expect(list).toEqual([])
    await expect(run(tools, 'superego_machines', { op: 'enable', machine: 'nope' })).rejects.toThrow(/No machine nope/)
  })

  it('hands work to a thread of its own, where the work belongs, and names it', async () => {
    const started: Parameters<EgoThreads['start']>[0][] = []
    const { tools = [] } = egoTools({ dir: '/data', ...on(new Router()), snapshot, threads: threads(started) })
    expect(await text(tools, 'thread_start', { prompt: 'Add a profile', cwd: 'profiles', title: 'Profile' })).toBe('Started [Profile](thread:3) (id 3), in /data/profiles.')
    expect(started).toEqual([{ prompt: 'Add a profile', title: 'Profile', cwd: '/data/profiles' }])
  })

  it('starts none when told why not, for the conversation asking, as the call is made', async () => {
    const started: Parameters<EgoThreads['start']>[0][] = []
    const asked: number[] = []
    let why: string | undefined = 'Not for outside agents.'
    const { tools = [] } = egoTools({ dir: '/data', ...on(new Router()), snapshot, threads: threads(started), refuseStart: async (conversation) => { asked.push(conversation); return why } })
    await expect(text(tools, 'thread_start', { prompt: 'Add a profile', cwd: 'profiles' })).rejects.toThrow('Not for outside agents.')
    expect(started).toEqual([])
    why = undefined
    await text(tools, 'thread_start', { prompt: 'Add a profile', cwd: 'profiles' })
    expect(started).toHaveLength(1)
    expect(asked).toEqual([1, 1])
  })
})

describe('egoPrompt', () => {
  const prompt = egoPrompt({ name: 'Superego', id: 'superego', dataDir: '/data', agentsDir: '/agents', hostname: 'here' })

  it('briefs builders with the extension commands, without Node', () => {
    expect(prompt).toContain('`superego extension\n  new <name> --user [--ui]`')
    expect(prompt).toContain('`superego extension test --user`')
    expect(prompt).toContain('the superego skill, which every thread has')
    expect(prompt).toContain('No Node, npx or tsc')
    expect(prompt).not.toContain('--skill')
  })

  it('takes the obvious default rather than asking', () => {
    expect(prompt).toContain('take the obvious default and start the thread, saying what\n  you assumed')
    expect(prompt).not.toContain("Ask the user when you can't tell")
  })
})
