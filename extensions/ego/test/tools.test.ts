import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { defineAction, obj, opt, Router, str, unknown, type SettingsSnapshot, type ThreadInfo } from '@superego/protocol'
import { metaExtension, type EgoThreads, type MachineDirectory } from '../src/tools.ts'

type Tool = { name: string; execute(params: unknown, api: unknown, context?: unknown): Promise<{ output: { text: string }[] }> }
const text = async (tools: readonly unknown[], name: string, params: unknown) => {
  const tool = (tools as Tool[]).find((t) => t.name === name)!
  return (await tool.execute(params, { conversationId: 1 }, {})).output[0]!.text
}
const run = async (tools: readonly unknown[], name: string, params: unknown) => JSON.parse(await text(tools, name, params)) as unknown

const thread = (id: string, title: string, extra: Partial<ThreadInfo> = {}): ThreadInfo =>
  ({ id, title, cwd: '/p', createdAt: 0, activeAt: 0, session: { root: '/p', name: 'p' }, status: { state: 'idle' }, ...extra })

/** What the tools run actions with: `router`'s, as the daemon gives an extension its own. */
const on = (router: Router) => ({ dispatch: (id: string, params: unknown) => router.dispatch(id, params, {}, { source: 'ego' }), actions: router.list.bind(router) })

describe('Ego, the meta agent', () => {
  const snapshot = async (): Promise<SettingsSnapshot> => ({
    sections: [{ id: 'agent', title: 'Agent', order: 1, settings: [{ key: 'agent.model', title: 'Model', default: null, type: 'string' }] }],
    values: { 'agent.model': 'faux/faux-1' },
  })
  const threads = (started: Parameters<EgoThreads['start']>[0][] = []): EgoThreads => ({
    info: async (id) => [thread('1', 'Fix login'), thread('2', 'Notes', { session: { root: '/q', name: 'q' } })].find((t) => t.id === id),
    list: async () => [thread('1', 'Fix login'), thread('2', 'Notes', { session: { root: '/q', name: 'q' } })],
    start: async (params) => { started.push(params); return thread('3', params.title ?? 'New', { cwd: params.cwd }) },
    answer: async () => undefined,
  })

  it('reads settings, actions, profiles, machines, threads and files, and changes settings and machines; nothing else', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'superego-meta-'))
    try {
      const router = new Router()
      router.register(defineAction({ id: 'echo.say', title: 'Say', runs: 'machine', expose: ['cli'], params: obj({ text: str() }), run: ({ text }) => ({ said: text }) }))
      const set: unknown[] = []
      router.register(defineAction({ id: 'settings.set', title: 'Set', runs: 'machine', expose: ['cli'], params: obj({ key: str(), value: unknown() }), run: (params) => { set.push(params); return null } }))
      router.register(defineAction({ id: 'profile.list', title: 'Profiles', runs: 'machine', expose: ['cli'], params: obj({ cwd: opt(str()) }), run: ({ cwd }) => [{ name: 'default', dir: cwd }] }))
      const machines: MachineDirectory = { list: () => [{ id: 'm1', label: 'box', target: 'me@box', enabled: true }], add: async () => ({ id: 'm2', label: 'x' }), update: async () => {}, remove: async () => {} }
      const { tools = [] } = metaExtension({ dir, ...on(router), snapshot, machines: () => machines, threads: threads() })
      const names = (tools as unknown as Tool[]).map((t) => t.name)
      expect(names.sort()).toEqual(['ls', 'read', 'superego_actions', 'superego_machines', 'superego_profiles', 'superego_set_setting', 'superego_settings', 'thread_list', 'thread_read', 'thread_start'])
      // Setup (settings, machines) is what it changes itself; files, profiles, skills and code go to threads, so it has
      // no tool that writes or runs anything.
      for (const mutating of ['write', 'edit', 'bash', 'superego_run', 'thread_send']) expect(names).not.toContain(mutating)
      expect(await text(tools, 'superego_set_setting', { key: 'web.access', value: 'local' })).toBe('Set web.access to "local".')
      expect(set).toEqual([{ key: 'web.access', value: 'local' }])
      // Not what outside agents may do: one of them could be asking.
      await expect(run(tools, 'superego_set_setting', { key: 'mcp.startThreads', value: true })).rejects.toThrow(/Only the user/)
      expect(set).toHaveLength(1)
      // What it reads.
      expect((await run(tools, 'superego_actions', {}) as { id: string }[]).map((a) => a.id)).toEqual(['echo.say', 'settings.set', 'profile.list'])
      expect(await run(tools, 'superego_settings', {})).toEqual([{ id: 'agent', title: 'Agent', settings: [{ key: 'agent.model', title: 'Model', type: { type: 'string' }, default: null, value: 'faux/faux-1' }] }])
      expect(await run(tools, 'superego_machines', { op: 'list' })).toEqual(machines.list())
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
    let list: ReturnType<MachineDirectory['list']> = []
    const directory: MachineDirectory = {
      list: () => list,
      add: async ({ label, target = '' }) => { const added = { id: `m${list.length + 1}`, label: label ?? target, target, enabled: true }; list = [...list, added]; return added },
      update: async (id, patch) => { list = list.map((m) => m.id === id ? { ...m, ...patch } : m) },
      remove: async (id) => { list = list.filter((m) => m.id !== id) },
    }
    const { tools = [] } = metaExtension({ dir: '/data', ...on(new Router()), snapshot, machines: () => directory, threads: threads() })
    await run(tools, 'superego_machines', { op: 'add', target: 'me@box', name: 'box' })
    await run(tools, 'superego_machines', { op: 'rename', machine: 'box', name: 'Build box' })
    await run(tools, 'superego_machines', { op: 'disable', machine: 'Build box' })
    expect(await run(tools, 'superego_machines', { op: 'list' })).toEqual([{ id: 'm1', label: 'Build box', target: 'me@box', enabled: false }])
    await run(tools, 'superego_machines', { op: 'remove', machine: 'm1' })
    expect(list).toEqual([])
    await expect(run(tools, 'superego_machines', { op: 'enable', machine: 'nope' })).rejects.toThrow(/No machine nope/)
  })

  it('hands work to a thread of its own, where the work belongs, and names it', async () => {
    const started: Parameters<EgoThreads['start']>[0][] = []
    const { tools = [] } = metaExtension({ dir: '/data', ...on(new Router()), snapshot, threads: threads(started) })
    expect(await text(tools, 'thread_start', { prompt: 'Add a profile', cwd: 'profiles', title: 'Profile' })).toBe('Started [Profile](thread:3) (id 3), in /data/profiles.')
    expect(started).toEqual([{ prompt: 'Add a profile', title: 'Profile', cwd: '/data/profiles' }])
  })
})
