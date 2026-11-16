// What's unread: one rule (protocol's `unread`, listed by `unreadThreads`) for the threads rail, the unread bell and
// ⌘., the app icon's count, notifications and `<id> unread`.
import { expect, it } from 'vitest'
import { unread, unreadThreads, type Status, type ThreadInfo } from '@superego/protocol'
import type { MachineEntry } from '../src/shared/bridge.ts'
import { threadNotification } from '../src/shared/notifications.ts'
import { groupProjects, unreadList } from '../src/renderer/projects.ts'

const thread = (id: string, status: Status, more: Partial<ThreadInfo> = {}): ThreadInfo =>
  ({ id, title: id, cwd: '/', createdAt: 0, activeAt: 0, project: { root: '/', name: '/' }, status, ...more })

it('counts a result, a failure or a question; not work, nothing, or waiting for sign-in', () => {
  expect(unread(thread('a', { state: 'done' }))).toBe(true)
  expect(unread(thread('a', { state: 'error' }))).toBe(true)
  expect(unread(thread('a', { state: 'blocked' }))).toBe(true)
  expect(unread(thread('a', { state: 'working' }))).toBe(false)
  expect(unread(thread('a', { state: 'idle' }))).toBe(false)
  expect(unread(thread('a', { state: 'blocked', kind: 'auth', msg: 'Sign in' }))).toBe(false)
})

it("doesn't count threads in no list, nor a quiet one unless it needs you", () => {
  expect(unread(thread('a', { state: 'done' }, { archived: true }))).toBe(false)
  expect(unread(thread('a', { state: 'done' }, { hidden: true }))).toBe(false)
  expect(unread(thread('a', { state: 'done' }, { parent: 'p', quiet: true }))).toBe(false)
  expect(unread(thread('a', { state: 'error' }, { parent: 'p', quiet: true }))).toBe(false)
  expect(unread(thread('a', { state: 'blocked' }, { parent: 'p', quiet: true }))).toBe(true)
  // Handed to the user: it counts as any thread does.
  expect(unread(thread('a', { state: 'done' }, { parent: 'p' }))).toBe(true)
})

it('notifies of exactly the threads it counts', () => {
  const all = [
    thread('done', { state: 'done' }), thread('idle', { state: 'idle' }), thread('auth', { state: 'blocked', kind: 'auth' }),
    thread('child', { state: 'done' }, { quiet: true }), thread('asks', { state: 'blocked' }, { quiet: true }), thread('gone', { state: 'error' }, { archived: true }),
  ]
  expect(all.map((t) => Boolean(threadNotification('box', t)))).toEqual(all.map(unread))
})

it("lists every machine's but the one being looked at, a question first, then failures, then results, newest first", () => {
  const threads = [
    { machine: 'box', thread: thread('a', { state: 'done' }, { activeAt: 1 }) },
    { machine: 'box', thread: thread('b', { state: 'blocked' }) },
    { machine: 'studio', thread: thread('a', { state: 'error' }) },
    { machine: 'studio', thread: thread('c', { state: 'working' }) },
    { machine: 'studio', thread: thread('d', { state: 'done' }, { activeAt: 2 }) },
  ]
  const ids = (list: typeof threads) => list.map(({ machine, thread }) => `${machine}/${thread.id}`)
  expect(ids(unreadThreads(threads))).toEqual(['box/b', 'studio/a', 'studio/d', 'box/a'])
  expect(ids(unreadThreads(threads, { machine: 'box', thread: 'b' }))).toEqual(['studio/a', 'studio/d', 'box/a'])
  // The same id on another machine is another thread.
  expect(unreadThreads(threads, { machine: 'studio', thread: 'b' })).toHaveLength(4)
  expect(unreadThreads([])).toEqual([])
})

it("lists the window's projects the same way, each thread with its project", () => {
  const machine = (id: string): MachineEntry => ({ id, label: id, state: 'connected' })
  const at = (id: string, root: string, activeAt: number, state: Status['state']) => thread(id, { state }, { cwd: root, activeAt, project: { root, name: root } })
  const projects = groupProjects([machine('local'), machine('box')], {
    local: [at('a1', '/a', 50, 'done'), at('a2', '/a', 40, 'idle'), at('b1', '/b', 30, 'error'), at('b2', '/b', 20, 'blocked')],
    box: [at('far', '/a', 60, 'done')],
  })
  expect(unreadList(projects, { machine: 'local', thread: 'b1' }).map((w) => w.thread.id)).toEqual(['b2', 'far', 'a1'])
  expect(unreadList(projects).map((w) => [w.project.root, w.thread.id])).toEqual([['/b', 'b2'], ['/b', 'b1'], ['/a', 'far'], ['/a', 'a1']])
})
