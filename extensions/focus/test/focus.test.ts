// The focus set: a thread in and out with the threads under it, a new sub-thread joining, archived ones leaving, and
// what focus mode shows.
import { expect, it } from 'vitest'
import type { MachineEntry } from '@superego/app/ui'
import type { Status, ThreadInfo } from '@superego/protocol'
import { focus, isFocused, joined, needsYou, shows, stillListed, toggle, unfocus } from '../src/focus.ts'

const thread = (id: string, parent?: string, status: Status = { state: 'idle' }): ThreadInfo =>
  ({ id, title: id, cwd: '/a', createdAt: 0, activeAt: 0, project: { root: '/a', name: 'a' }, status, ...(parent ? { parent } : {}) })
const threads = { local: [thread('a'), thread('a1', 'a'), thread('a11', 'a1'), thread('b')] }
const at = (id: string, machine = 'local') => ({ machine, thread: id })
const machine = (id: string, state: MachineEntry['state'] = 'connected'): MachineEntry => ({ id, label: id, state })

it('focuses a thread with the threads under it, and unfocuses them with it', () => {
  const set = focus([], at('a'), threads)
  expect(set).toEqual([at('a'), at('a1'), at('a11')])
  expect(unfocus([...set, at('b')], at('a'), threads)).toEqual([at('b')])
  expect(toggle([at('b')], at('b'), threads)).toEqual([])
  expect(isFocused(toggle([], at('b', 'box'), threads), at('b', 'box'))).toBe(true)
})

it('takes in a thread a focused one starts, and no other', () => {
  expect(joined([at('a')], 'local', thread('new', 'a'))).toEqual([at('a'), at('new')])
  expect(joined([at('a')], 'local', thread('new', 'b'))).toBeUndefined()
  expect(joined([at('a')], 'box', thread('new', 'a'))).toBeUndefined()
  expect(joined([at('a')], 'local', thread('new'))).toBeUndefined()
})

it('lets archived threads go, where that is known', () => {
  const set = [at('a'), at('gone'), at('far', 'box'), at('away', 'off')]
  expect(stillListed(set, [machine('local'), machine('box'), machine('off', 'disconnected')], { local: threads.local, off: [] }))
    .toEqual([at('a'), at('far', 'box'), at('away', 'off')])
})

it('shows what is in focus, and every thread that needs you', () => {
  expect(shows([at('a')], 'local', thread('a'))).toBe(true)
  expect(shows([at('a')], 'local', thread('b'))).toBe(false)
  expect(shows([], 'local', thread('q', undefined, { state: 'blocked', kind: 'question' }))).toBe(true)
  expect(needsYou(thread('e', undefined, { state: 'error' }))).toBe(true)
  expect(needsYou(thread('d', undefined, { state: 'done' }))).toBe(false)
})
