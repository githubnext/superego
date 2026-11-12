import { expect, it } from 'vitest'
import type { Status, ThreadInfo } from '@superego/protocol'
import type { MachineEntry } from '../src/shared.ts'
import { freeze, groupSessions, threadBeside, type Session } from '../src/renderer/sessions.ts'

const machine = (id: string): MachineEntry => ({ id, label: id === 'local' ? 'This computer' : 'Build box', state: 'connected' })
const thread = (id: string, root: string, activeAt: number, more: Partial<ThreadInfo> = {}): ThreadInfo =>
  ({ id, title: id, cwd: root, createdAt: 0, activeAt, session: { root, name: root.split('/').at(-1)! }, status: { state: 'idle' as Status['state'] }, ...more })

// Two machines with the same project; a thread started by another, in a worktree, a level under it, and its own under
// it; one whose parent is gone (archived), on its own.
const machines = [machine('local'), machine('box')]
const threads = {
  local: [
    thread('parent', '/code/superego', 10),
    thread('child', '/code/superego', 50, { parent: 'parent', cwd: '/code/superego.worktrees/child', worktree: { path: '/code/superego.worktrees/child', branch: 'child' } }),
    thread('grandchild', '/code/superego', 5, { parent: 'child' }),
    thread('solo', '/code/superego', 30),
    thread('site', '/code/site', 40),
    thread('stray', '/code/site', 20, { parent: 'archived' }),
  ],
  box: [thread('far', '/code/superego', 60), thread('far-child', '/code/superego', 70, { parent: 'far' })],
}

/** What the sidebar shows, top to bottom: each session's threads as it lists them (see extensions/threads). */
const shown = (sessions: Session[]) => sessions.flatMap((s) => s.threads.map((t) => `${s.machine.id}/${t.id}`))
/** Where ⌘⇧] goes, press after press, from nothing selected. */
const visits = (sessions: Session[], presses: number, by = 1) => {
  const out: string[] = []
  let at: { machine: string; thread: string } | undefined
  for (let i = 0; i < presses; i++) { at = threadBeside(sessions, at, by); out.push(`${at!.machine}/${at!.thread}`) }
  return out
}

it('steps through the threads in the order the sidebar shows them, children under their parents', () => {
  const sessions = groupSessions(machines, threads, 'recent')
  const order = ['box/far', 'box/far-child', 'local/solo', 'local/parent', 'local/child', 'local/grandchild', 'local/site', 'local/stray']
  expect(shown(sessions)).toEqual(order)
  expect(sessions.map((s) => s.threads.map((t) => s.depth[t.id]))).toEqual([[0, 1], [0, 0, 1, 2], [0, 0]])
  expect(visits(sessions, order.length)).toEqual(order)
  // Around at the ends, both ways.
  expect(visits(sessions, order.length + 1).at(-1)).toBe(order[0])
  expect(visits(sessions, order.length, -1)).toEqual([...order].reverse())
})

it('holds still under the pointer, and stepping goes down the rows as they stand', () => {
  const before = groupSessions(machines, threads, 'recent')
  // Meanwhile: the parent gets busy (it would rise to the top), and starts another thread.
  const later = { ...threads, local: [...threads.local.map((t) => t.id === 'parent' ? { ...t, activeAt: 99 } : t), thread('new-child', '/code/superego', 100, { parent: 'parent' })] }
  const held = freeze(before, groupSessions(machines, later, 'recent'))
  const order = ['box/far', 'box/far-child', 'local/solo', 'local/parent', 'local/child', 'local/grandchild', 'local/new-child', 'local/site', 'local/stray']
  expect(shown(held)).toEqual(order)
  expect(visits(held, order.length)).toEqual(order)
  // Let go, it follows activity again.
  expect(shown(groupSessions(machines, later, 'recent')).slice(0, 5)).toEqual(['local/parent', 'local/new-child', 'local/child', 'local/grandchild', 'local/solo'])
})
