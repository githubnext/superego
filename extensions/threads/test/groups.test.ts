import { expect, it } from 'vitest'
import type { MachineEntry } from '@superego/app/ui'
import type { ThreadInfo, Status } from '@superego/protocol'
import { groupSessions } from '../../../packages/app/src/renderer/sessions.ts'
import { ago, freeze } from '../src/groups.ts'

const machine = (id: string, state: MachineEntry['state'] = 'connected'): MachineEntry => ({ id, label: id === 'local' ? 'This computer' : 'Build box', state })
const thread = (id: string, root: string, state: Status['state'], createdAt: number, activeAt: number): ThreadInfo =>
  ({ id, title: id, cwd: `${root}/x`, createdAt, activeAt, session: { root, name: root.split('/').at(-1)! }, status: { state } })
const machines = [machine('local'), machine('box', 'disconnected')]
const threads = {
  local: [thread('old-busy', '/code/superego', 'working', 1, 50), thread('new-done', '/code/site', 'done', 30, 31), thread('mid-asks', '/code/superego', 'blocked', 20, 40)],
  box: [thread('far', '/code/superego', 'idle', 10, 10)],
}
const shape = (sessions: ReturnType<typeof groupSessions>) => sessions.map((s) => [s.name, s.machine.id, s.threads.map((t) => t.id)])

it('groups threads into sessions: a project on a machine, the machine a fact about it', () => {
  expect(shape(groupSessions(machines, threads, 'recent'))).toEqual([
    ['superego', 'local', ['old-busy', 'mid-asks']], ['site', 'local', ['new-done']], ['superego', 'box', ['far']],
  ])
  expect(shape(groupSessions(machines, threads, 'created'))).toEqual([
    ['site', 'local', ['new-done']], ['superego', 'local', ['mid-asks', 'old-busy']], ['superego', 'box', ['far']],
  ])
  const byStatus = groupSessions(machines, threads, 'status')
  expect(shape(byStatus)[0]).toEqual(['superego', 'local', ['mid-asks', 'old-busy']])
  expect(byStatus[0]!.status.state).toBe('blocked')
})

it('holds the order still while the pointer is over it, taking in what changed', () => {
  const before = groupSessions(machines, threads, 'recent')
  const later = { ...threads, local: [...threads.local, thread('newest', '/code/new', 'working', 60, 60)].map((t) => t.id === 'mid-asks' ? { ...t, activeAt: 99 } : t) }
  const held = freeze(before, groupSessions(machines, later, 'recent'))
  expect(shape(held)).toEqual([
    ['superego', 'local', ['old-busy', 'mid-asks']], ['site', 'local', ['new-done']], ['superego', 'box', ['far']], ['new', 'local', ['newest']],
  ])
})

it('says how long ago briefly', () => {
  const now = Date.parse('2026-11-04T12:00:00Z')
  expect(ago(now - 20_000, now)).toBe('now')
  expect(ago(now - 5 * 60_000, now)).toBe('5m')
  expect(ago(now - 3 * 3_600_000, now)).toBe('3h')
})
