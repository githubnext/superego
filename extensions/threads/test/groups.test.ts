import { describe, expect, it } from 'vitest'
import type { MachineEntry } from '@mu/app/ui'
import type { SessionInfo, Status } from '@mu/protocol'
import { ago, groupSessions } from '../src/groups.ts'

const machine = (id: string, state: MachineEntry['state'] = 'connected'): MachineEntry => ({ id, label: id === 'local' ? 'This computer' : 'Build box', state })
const session = (id: string, state: Status['state'], createdAt: number, activeAt: number): SessionInfo => ({ id, title: id, cwd: '/', createdAt, activeAt, status: { state } })
const machines = [machine('local'), machine('box', 'disconnected')]
const sessions = {
  local: [session('old-busy', 'working', 1, 50), session('new-done', 'done', 30, 31), session('mid-asks', 'blocked', 20, 40)],
  box: [session('far', 'idle', 10, 10)],
}
const ids = (groups: ReturnType<typeof groupSessions>) => groups.map((g) => [g.title, g.note, g.rows.map((r) => r.session.id)])

describe('groupSessions', () => {
  it('newest first, by machine, noting offline machines', () => {
    expect(ids(groupSessions(machines, sessions, 'created'))).toEqual([
      ['This computer', undefined, ['new-done', 'mid-asks', 'old-busy']],
      ['Build box', 'offline', ['far']],
    ])
  })
  it('recently active first, by machine', () => {
    expect(ids(groupSessions(machines, sessions, 'recent'))[0]).toEqual(['This computer', undefined, ['old-busy', 'mid-asks', 'new-done']])
  })
  it('needs you first, across machines, leaving out empty groups', () => {
    expect(ids(groupSessions(machines, sessions, 'status'))).toEqual([
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
