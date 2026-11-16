// The sidebar's order (see extensions/threads): threads grouped into projects, held still under the pointer, and nested.
import { expect, it } from 'vitest'
import type { ThreadInfo, Status } from '@superego/protocol'
import type { MachineEntry } from '../src/shared/bridge.ts'
import { freeze, groupProjects, nest } from '../src/renderer/projects.ts'

const machine = (id: string, state: MachineEntry['state'] = 'connected'): MachineEntry => ({ id, label: id === 'local' ? 'This computer' : 'Build box', state })
const thread = (id: string, root: string, state: Status['state'], createdAt: number, activeAt: number): ThreadInfo =>
  ({ id, title: id, cwd: `${root}/x`, createdAt, activeAt, project: { root, name: root.split('/').at(-1)! }, status: { state } })
const machines = [machine('local'), machine('box', 'disconnected')]
const threads = {
  local: [thread('old-busy', '/code/superego', 'working', 1, 50), thread('new-done', '/code/site', 'done', 30, 31), thread('mid-asks', '/code/superego', 'blocked', 20, 40)],
  box: [thread('far', '/code/superego', 'idle', 10, 10)],
}
const shape = (projects: ReturnType<typeof groupProjects>) => projects.map((s) => [s.name, s.machine.id, s.threads.map((t) => t.id)])

it('groups threads into projects: a project on a machine, the machine a fact about it', () => {
  expect(shape(groupProjects(machines, threads, 'recent'))).toEqual([
    ['superego', 'local', ['old-busy', 'mid-asks']], ['site', 'local', ['new-done']], ['superego', 'box', ['far']],
  ])
  expect(shape(groupProjects(machines, threads, 'created'))).toEqual([
    ['site', 'local', ['new-done']], ['superego', 'local', ['mid-asks', 'old-busy']], ['superego', 'box', ['far']],
  ])
  const byStatus = groupProjects(machines, threads, 'status')
  expect(shape(byStatus)[0]).toEqual(['superego', 'local', ['mid-asks', 'old-busy']])
  expect(byStatus[0]!.status.state).toBe('blocked')
})

it('holds the order still while the pointer is over it, taking in what changed', () => {
  const before = groupProjects(machines, threads, 'recent')
  const later = { ...threads, local: [...threads.local, thread('newest', '/code/new', 'working', 60, 60)].map((t) => t.id === 'mid-asks' ? { ...t, activeAt: 99 } : t) }
  const held = freeze(before, groupProjects(machines, later, 'recent'))
  expect(shape(held)).toEqual([
    ['superego', 'local', ['old-busy', 'mid-asks']], ['site', 'local', ['new-done']], ['superego', 'box', ['far']], ['new', 'local', ['newest']],
  ])
})

it('puts the threads a thread started under it, a level in; one whose parent is elsewhere on its own', () => {
  const t = (id: string, parent?: string) => ({ ...thread(id, '/code/superego', 'idle', 0, 0), ...(parent ? { parent } : {}) })
  const order = [t('child-b', 'parent'), t('parent'), t('grandchild', 'child-a'), t('child-a', 'parent'), t('orphan', 'archived'), t('other')]
  const nested = nest(order)
  expect(nested.threads.map((thread) => [thread.id, nested.depth[thread.id]])).toEqual([
    ['parent', 0], ['child-b', 1], ['child-a', 1], ['grandchild', 2], ['orphan', 0], ['other', 0],
  ])
})
