import { expect, it } from 'vitest'
import { groupProjects, type MachineEntry } from '@superego/app/ui'
import type { Status, ThreadInfo } from '@superego/protocol'
import { nextUnread } from '../src/unread.ts'

const machine = (id: string): MachineEntry => ({ id, label: id, state: 'connected' })
const thread = (id: string, root: string, activeAt: number, state: Status['state']): ThreadInfo =>
  ({ id, title: id, cwd: root, createdAt: 0, activeAt, project: { root, name: root }, status: { state } })

// Sorted by recent activity: box's project first (far), then local's /a (a1, a2), then /b (b1, b2).
const projects = groupProjects([machine('local'), machine('box')], {
  local: [thread('a1', '/a', 50, 'done'), thread('a2', '/a', 40, 'idle'), thread('b1', '/b', 30, 'error'), thread('b2', '/b', 20, 'blocked')],
  box: [thread('far', '/a', 60, 'done')],
}, 'recent')
const at = (machine: string, thread: string) => ({ machine, thread })

it('goes to the next unread thread in the sidebar\'s order, around to the start, never the one shown', () => {
  expect(projects.flatMap((s) => s.threads.map((t) => t.id))).toEqual(['far', 'a1', 'a2', 'b1', 'b2'])
  expect(nextUnread(projects, at('local', 'a1'), 'all')).toEqual(at('local', 'b1'))
  expect(nextUnread(projects, at('local', 'b2'), 'all')).toEqual(at('box', 'far'))
  expect(nextUnread(projects, undefined, 'all')).toEqual(at('box', 'far'))
})

it('stays in the project shown when asked to, and finds nothing when only the thread shown is unread', () => {
  expect(nextUnread(projects, at('local', 'b2'), 'project')).toEqual(at('local', 'b1'))
  expect(nextUnread(projects, at('local', 'a2'), 'project')).toEqual(at('local', 'a1'))
  expect(nextUnread(projects, at('local', 'a1'), 'project')).toBeUndefined()
})
