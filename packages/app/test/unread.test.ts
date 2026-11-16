import { expect, it } from 'vitest'
import type { Json, Status, ThreadInfo } from '@superego/protocol'
import { threadNotice, unread, unreadCount } from '../src/shared.ts'

const thread = (id: string, status: Status, more: Partial<ThreadInfo> = {}): ThreadInfo =>
  ({ id, title: id, cwd: '/', createdAt: 0, activeAt: 0, project: { root: '/', name: '/' }, status, ...more })
const toParent: Record<string, Json> = { 'thread-reports': { toParent: true } }

it('counts a result, a failure or a question; not work, nothing, or waiting for sign-in', () => {
  expect(unread(thread('a', { state: 'done' }))).toBe(true)
  expect(unread(thread('a', { state: 'error' }))).toBe(true)
  expect(unread(thread('a', { state: 'blocked' }))).toBe(true)
  expect(unread(thread('a', { state: 'working' }))).toBe(false)
  expect(unread(thread('a', { state: 'idle' }))).toBe(false)
  expect(unread(thread('a', { state: 'blocked', kind: 'auth', msg: 'Sign in' }))).toBe(false)
})

it("doesn't count threads in no list, nor a child working for its parent unless it needs you", () => {
  expect(unread(thread('a', { state: 'done' }, { archived: true }))).toBe(false)
  expect(unread(thread('a', { state: 'done' }, { hidden: true }))).toBe(false)
  expect(unread(thread('a', { state: 'done' }, { parent: 'p', ext: toParent }))).toBe(false)
  expect(unread(thread('a', { state: 'error' }, { parent: 'p', ext: toParent }))).toBe(false)
  expect(unread(thread('a', { state: 'blocked' }, { parent: 'p', ext: toParent }))).toBe(true)
  // Handed to the user: it counts as any thread does.
  expect(unread(thread('a', { state: 'done' }, { parent: 'p' }))).toBe(true)
})

it('notifies of exactly the threads it counts', () => {
  const all = [
    thread('done', { state: 'done' }), thread('idle', { state: 'idle' }), thread('auth', { state: 'blocked', kind: 'auth' }),
    thread('child', { state: 'done' }, { ext: toParent }), thread('asks', { state: 'blocked' }, { ext: toParent }), thread('gone', { state: 'error' }, { archived: true }),
  ]
  expect(all.map((t) => Boolean(threadNotice('box', t)))).toEqual(all.map(unread))
})

it("counts every machine's, but the one being looked at", () => {
  const threads = [
    { machine: 'box', thread: thread('a', { state: 'done' }) },
    { machine: 'box', thread: thread('b', { state: 'blocked' }) },
    { machine: 'studio', thread: thread('a', { state: 'error' }) },
    { machine: 'studio', thread: thread('c', { state: 'working' }) },
  ]
  expect(unreadCount(threads)).toBe(3)
  expect(unreadCount(threads, { machine: 'box', thread: 'b' })).toBe(2)
  // The same id on another machine is another thread.
  expect(unreadCount(threads, { machine: 'studio', thread: 'b' })).toBe(3)
  expect(unreadCount([])).toBe(0)
})
