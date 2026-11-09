import { describe, expect, it } from 'vitest'
import type { MachineEntry } from '@mu/app/ui'
import type { ThreadInfo, Status } from '@mu/protocol'
import { ago, groupThreads } from '../src/groups.ts'

const machine = (id: string, state: MachineEntry['state'] = 'connected'): MachineEntry => ({ id, label: id === 'local' ? 'This computer' : 'Build box', state })
const thread = (id: string, state: Status['state'], createdAt: number, activeAt: number): ThreadInfo => ({ id, title: id, cwd: '/', createdAt, activeAt, status: { state } })
const machines = [machine('local'), machine('box', 'disconnected')]
const threads = {
  local: [thread('old-busy', 'working', 1, 50), thread('new-done', 'done', 30, 31), thread('mid-asks', 'blocked', 20, 40)],
  box: [thread('far', 'idle', 10, 10)],
}
const ids = (groups: ReturnType<typeof groupThreads>) => groups.map((g) => [g.title, g.note, g.rows.map((r) => r.thread.id)])

describe('groupThreads', () => {
  it('newest first, by machine, noting offline machines', () => {
    expect(ids(groupThreads(machines, threads, 'created'))).toEqual([
      ['This computer', undefined, ['new-done', 'mid-asks', 'old-busy']],
      ['Build box', 'offline', ['far']],
    ])
  })
  it('recently active first, by machine', () => {
    expect(ids(groupThreads(machines, threads, 'recent'))[0]).toEqual(['This computer', undefined, ['old-busy', 'mid-asks', 'new-done']])
  })
  it('needs you first, across machines, leaving out empty groups', () => {
    expect(ids(groupThreads(machines, threads, 'status'))).toEqual([
      ['Needs you', undefined, ['mid-asks']], ['Working', undefined, ['old-busy']], ['Done', undefined, ['new-done']], ['Idle', undefined, ['far']],
    ])
  })
})

it('says how long ago briefly', () => {
  const now = Date.parse('2026-11-04T12:00:00Z')
  expect(ago(now - 20_000, now)).toBe('now')
  expect(ago(now - 5 * 60_000, now)).toBe('5m')
  expect(ago(now - 3 * 3_600_000, now)).toBe('3h')
})
