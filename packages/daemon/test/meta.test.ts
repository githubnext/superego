import { describe, expect, it } from 'vitest'
import { defineAction, obj, Router, str, type SettingsSnapshot } from '@superego/protocol'
import { metaExtension, type MachineDirectory } from '../src/meta.ts'
import type { DaemonContext } from '../src/daemon.ts'

type Tool = { name: string; execute(params: unknown, api: unknown): Promise<{ output: { text: string }[] }> }
const run = async (tools: readonly unknown[], name: string, params: unknown) => {
  const tool = (tools as Tool[]).find((t) => t.name === name)!
  return JSON.parse((await tool.execute(params, {})).output[0]!.text) as unknown
}

describe('the meta agent', () => {
  const snapshot = async (): Promise<SettingsSnapshot> => ({
    sections: [{ id: 'agent', title: 'Agent', order: 1, settings: [{ key: 'agent.model', title: 'Model', default: null, type: 'string' }] }],
    values: { 'agent.model': 'faux/faux-1' },
  })

  it("runs the machine's command-line actions, never the restart, and reads its settings", async () => {
    const router = new Router<DaemonContext>()
    router.register(defineAction({ id: 'echo.say', title: 'Say', runs: 'machine', expose: ['cli'], params: obj({ text: str() }), run: ({ text }) => ({ said: text }) }))
    router.register(defineAction({ id: 'hidden.thing', title: 'Hidden', runs: 'machine', expose: ['ui'], params: obj({}), run: () => null }))
    router.register(defineAction({ id: 'daemon.restart', title: 'Restart', runs: 'machine', expose: ['cli'], params: obj({}), run: () => null }))
    const { tools = [] } = metaExtension({ router, snapshot })
    expect((tools as unknown as Tool[]).map((t) => t.name)).toEqual(['superego_settings', 'superego_actions', 'superego_run'])
    expect((await run(tools, 'superego_actions', {}) as { id: string }[]).map((a) => a.id)).toEqual(['echo.say'])
    expect(await run(tools, 'superego_run', { id: 'echo.say', params: { text: 'hi' } })).toEqual({ said: 'hi' })
    await expect(run(tools, 'superego_run', { id: 'hidden.thing' })).rejects.toThrow()
    await expect(run(tools, 'superego_run', { id: 'daemon.restart' })).rejects.toThrow(/stop this agent/)
    expect(await run(tools, 'superego_settings', {})).toEqual([{ id: 'agent', title: 'Agent', settings: [{ key: 'agent.model', title: 'Model', type: { type: 'string' }, default: null, value: 'faux/faux-1' }] }])
  })

  it('adds, renames, disables and removes machines in the list it is given', async () => {
    let list: ReturnType<MachineDirectory['list']> = []
    const directory: MachineDirectory = {
      list: () => list,
      add: async ({ label, target = '' }) => { const added = { id: `m${list.length + 1}`, label: label ?? target, target, enabled: true }; list = [...list, added]; return added },
      update: async (id, patch) => { list = list.map((m) => m.id === id ? { ...m, ...patch } : m) },
      remove: async (id) => { list = list.filter((m) => m.id !== id) },
    }
    const { tools = [] } = metaExtension({ router: new Router(), snapshot, machines: () => directory })
    await run(tools, 'superego_machines', { op: 'add', target: 'me@box', name: 'box' })
    await run(tools, 'superego_machines', { op: 'rename', machine: 'box', name: 'Build box' })
    await run(tools, 'superego_machines', { op: 'disable', machine: 'Build box' })
    expect(await run(tools, 'superego_machines', { op: 'list' })).toEqual([{ id: 'm1', label: 'Build box', target: 'me@box', enabled: false }])
    await run(tools, 'superego_machines', { op: 'remove', machine: 'm1' })
    expect(list).toEqual([])
    await expect(run(tools, 'superego_machines', { op: 'enable', machine: 'nope' })).rejects.toThrow(/No machine nope/)
  })
})
