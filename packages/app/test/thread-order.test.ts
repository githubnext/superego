import { expect, it } from 'vitest'
import type { Status, ThreadInfo } from '@superego/protocol'
import type { MachineEntry } from '../src/shared/bridge.ts'
import { fold, freeze, groupProjects, pinnedFirst, shownRows, sidebarOrder, stillFolded, threadBeside, wayTo, type Project } from '../src/renderer/projects.ts'

const machine = (id: string): MachineEntry => ({ id, label: id === 'local' ? 'This computer' : 'Build box', state: 'connected' })
const thread = (id: string, root: string, activeAt: number, more: Partial<ThreadInfo> = {}): ThreadInfo =>
  ({ id, title: id, cwd: root, createdAt: 0, activeAt, project: { root, name: root.split('/').at(-1)! }, status: { state: 'idle' as Status['state'] }, ...more })

// Two machines with the same project; a thread started by another, in a worktree, a level under it, and its own under
// it; one whose parent is gone (archived), on its own.
const machines = [machine('local'), machine('box')]
const threads = {
  local: [
    thread('parent', '/code/superego', 10),
    thread('child', '/code/superego', 50, { parent: 'parent', cwd: '/code/superego.worktrees/child', facts: { worktrees: { path: '/code/superego.worktrees/child', branch: 'child' } } }),
    thread('grandchild', '/code/superego', 5, { parent: 'child' }),
    thread('solo', '/code/superego', 30),
    thread('site', '/code/site', 40),
    thread('stray', '/code/site', 20, { parent: 'archived' }),
  ],
  box: [thread('far', '/code/superego', 60), thread('far-child', '/code/superego', 70, { parent: 'far' })],
}

/** What the sidebar shows, top to bottom: each project's threads as it lists them (see extensions/threads). */
const shown = (projects: Project[]) => projects.flatMap((s) => s.threads.map((t) => `${s.machine.id}/${t.id}`))
/** Where ⌘⇧] goes, press after press, from nothing selected. */
const visits = (projects: Project[], presses: number, by = 1, pins: { machine: string; thread: string }[] = []) => {
  const out: string[] = []
  let at: { machine: string; thread: string } | undefined
  for (let i = 0; i < presses; i++) { at = threadBeside(pinnedFirst(projects, pins), at, by); out.push(`${at!.machine}/${at!.thread}`) }
  return out
}

it('steps through the threads in the order the sidebar shows them, children under their parents', () => {
  const projects = groupProjects(machines, threads, 'recent')
  const order = ['box/far', 'box/far-child', 'local/solo', 'local/parent', 'local/child', 'local/grandchild', 'local/site', 'local/stray']
  expect(shown(projects)).toEqual(order)
  expect(projects.map((s) => s.threads.map((t) => s.depth[t.id]))).toEqual([[0, 1], [0, 0, 1, 2], [0, 0]])
  expect(visits(projects, order.length)).toEqual(order)
  // Around at the ends, both ways.
  expect(visits(projects, order.length + 1).at(-1)).toBe(order[0])
  expect(visits(projects, order.length, -1)).toEqual([...order].reverse())
})

it('holds still under the pointer, and stepping goes down the rows as they stand', () => {
  const before = groupProjects(machines, threads, 'recent')
  // Meanwhile: the parent gets busy (it would rise to the top), and starts another thread.
  const later = { ...threads, local: [...threads.local.map((t) => t.id === 'parent' ? { ...t, activeAt: 99 } : t), thread('new-child', '/code/superego', 100, { parent: 'parent' })] }
  const held = freeze(before, groupProjects(machines, later, 'recent'))
  const order = ['box/far', 'box/far-child', 'local/solo', 'local/parent', 'local/child', 'local/grandchild', 'local/new-child', 'local/site', 'local/stray']
  expect(shown(held)).toEqual(order)
  expect(visits(held, order.length)).toEqual(order)
  // Let go, it follows activity again.
  expect(shown(groupProjects(machines, later, 'recent')).slice(0, 5)).toEqual(['local/parent', 'local/new-child', 'local/child', 'local/grandchild', 'local/solo'])
})

it('lists pinned threads first, in the order they were pinned, across projects and machines, and again at the top of their projects', () => {
  const projects = groupProjects(machines, threads, 'recent')
  const pins = [{ machine: 'local', thread: 'site' }, { machine: 'box', thread: 'far' }, { machine: 'local', thread: 'solo' }, { machine: 'local', thread: 'parent' }, { machine: 'local', thread: 'archived' }]
  const sidebar = pinnedFirst(projects, pins)
  // The pin of a thread not listed (archived) lists nothing.
  expect(sidebar.pinned.map(({ project, thread }) => `${project.machine.id}/${thread.id} in ${project.name}`)).toEqual(['local/site in site', 'box/far in superego', 'local/solo in superego', 'local/parent in superego'])
  // Each project still has them all: its pinned at its top, in the pins' order, the rest as they sort; what a thread
  // started still right under it.
  expect(shown(sidebar.projects)).toEqual(['box/far', 'box/far-child', 'local/solo', 'local/parent', 'local/child', 'local/grandchild', 'local/site', 'local/stray'])
  const later = pinnedFirst(projects, [{ machine: 'local', thread: 'stray' }, { machine: 'local', thread: 'parent' }, { machine: 'local', thread: 'solo' }])
  expect(shown(later.projects)).toEqual(['box/far', 'box/far-child', 'local/parent', 'local/child', 'local/grandchild', 'local/solo', 'local/stray', 'local/site'])
  // Stepping goes down each thread once: the pinned, then the others.
  const order = ['local/stray', 'local/parent', 'local/solo', 'box/far', 'box/far-child', 'local/child', 'local/grandchild', 'local/site']
  expect(sidebarOrder(later).map((t) => `${t.machine}/${t.thread}`)).toEqual(order)
  expect(visits(projects, order.length, 1, [{ machine: 'local', thread: 'stray' }, { machine: 'local', thread: 'parent' }, { machine: 'local', thread: 'solo' }])).toEqual(order)
  expect(pinnedFirst(projects, []).projects).toBe(projects)
})

/** Each section's rows as shown: `machine/id` (with a ▸ when folded, and how many out of sight under it). */
const rowsOf = (folded: string[], selection?: { machine: string; thread: string }, pins: { machine: string; thread: string }[] = []) => {
  const { pinned, projects } = shownRows(pinnedFirst(groupProjects(machines, threads, 'recent'), pins, folded), selection)
  return [pinned, ...projects].map((s) => [
    `${s.folded ? '▸' : '▾'}${s.tucked.length ? ` ${s.tucked.length}` : ''}`,
    ...s.rows.map((r) => `${'  '.repeat(r.depth)}${r.project.machine.id}/${r.thread.id}${r.folded ? ` ▸ ${r.tucked.length}` : ''}`),
  ])
}
const superego = (machine: string) => fold.project({ key: `${machine}:/code/superego` })

it('folds sections and the threads under a thread, out of sight, the selected one still shown', () => {
  // Folded: box's project, and the parent's threads (the child and its own).
  const folded = [superego('box'), fold.thread('local', 'parent')]
  expect(rowsOf(folded)).toEqual([
    ['▾'],
    ['▸ 2'],
    ['▾', 'local/solo', 'local/parent ▸ 2'],
    ['▾', 'local/site', 'local/stray'],
  ])
  // Selected, the grandchild shows right under the folded parent; far-child on its own in its folded project.
  expect(rowsOf(folded, { machine: 'local', thread: 'grandchild' })[2]).toEqual(['▾', 'local/solo', 'local/parent ▸ 1', '  local/grandchild'])
  expect(rowsOf(folded, { machine: 'box', thread: 'far-child' })[1]).toEqual(['▸ 1', 'box/far-child'])
  // Pinned folds too; its threads still in their projects.
  expect(rowsOf([fold.pinned], undefined, [{ machine: 'local', thread: 'site' }])[0]).toEqual(['▸ 1'])
  expect(rowsOf([fold.pinned], undefined, [{ machine: 'local', thread: 'site' }])[3]).toEqual(['▾', 'local/site', 'local/stray'])
})

it('steps past what is folded, but from the selected thread under a fold', () => {
  const projects = groupProjects(machines, threads, 'recent')
  const sidebar = pinnedFirst(projects, [], [superego('box'), fold.thread('local', 'parent')])
  const order = ['local/solo', 'local/parent', 'local/site', 'local/stray']
  expect(sidebarOrder(sidebar).map((t) => `${t.machine}/${t.thread}`)).toEqual(order)
  expect(threadBeside(sidebar, { machine: 'local', thread: 'solo' }, 1)).toEqual({ machine: 'local', thread: 'parent' })
  expect(threadBeside(sidebar, { machine: 'local', thread: 'parent' }, 1)).toEqual({ machine: 'local', thread: 'site' })
  expect(threadBeside(sidebar, { machine: 'local', thread: 'grandchild' }, 1)).toEqual({ machine: 'local', thread: 'site' })
  expect(threadBeside(sidebar, { machine: 'local', thread: 'grandchild' }, -1)).toEqual({ machine: 'local', thread: 'parent' })
  expect(threadBeside(sidebar, { machine: 'local', thread: 'solo' }, -1)).toEqual({ machine: 'local', thread: 'stray' })
})

it('unfolds the way to a thread: its project and the threads above it, or Pinned for a pinned one', () => {
  const projects = groupProjects(machines, threads, 'recent')
  const folded = [superego('local'), fold.thread('local', 'parent'), fold.thread('local', 'child'), superego('box'), fold.pinned]
  const sidebar = pinnedFirst(projects, [{ machine: 'box', thread: 'far' }], folded)
  expect(wayTo(sidebar, { machine: 'local', thread: 'grandchild' }).sort()).toEqual([superego('local'), fold.thread('local', 'child'), fold.thread('local', 'parent')].sort())
  expect(wayTo(sidebar, { machine: 'local', thread: 'solo' })).toEqual([superego('local')])
  expect(wayTo(sidebar, { machine: 'box', thread: 'far' })).toEqual([fold.pinned])
  // Shown already: nothing to unfold.
  expect(wayTo(sidebar, { machine: 'local', thread: 'site' })).toEqual([])
  expect(wayTo(pinnedFirst(projects, [], [fold.thread('local', 'child')]), { machine: 'local', thread: 'child' })).toEqual([])
})

it('forgets folds of what is no longer listed, where that is known', () => {
  const projects = groupProjects(machines, threads, 'recent')
  const folded = [fold.pinned, superego('local'), fold.project({ key: 'local:/code/gone' }), fold.thread('local', 'parent'), fold.thread('local', 'gone'), fold.thread('off', 'x'), fold.project({ key: 'off:/code/x' })]
  expect(stillFolded(folded, projects, machines, threads)).toEqual([fold.pinned, superego('local'), fold.thread('local', 'parent'), fold.thread('off', 'x'), fold.project({ key: 'off:/code/x' })])
  // Not heard from yet: kept.
  expect(stillFolded(folded, [], machines, {})).toEqual(folded)
})
