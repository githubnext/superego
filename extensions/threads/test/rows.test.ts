// The UI half's thread tool rows and `thread:` links, in a window: what a run of them says, how each row reads, and
// where a thread link is claimed and what following one does.
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ToolRowCall } from '@superego/app/ui'
import { DescribedCall, describeRun, linkHandler, mainKind, toolRow } from '@superego/app/internals'
import { mountUi, testThread, type TestWindow } from '@superego/sdk/testing'
import threads from '../src/ui.tsx'

const thread = testThread({ id: '1', title: 't' })
const where = { machine: 'local', thread }
let ui: TestWindow
beforeEach(async () => { ui = await mountUi({ extensions: [threads] }) })
afterEach(async () => { await ui.unmount() })

const rowOf = (name: string) => toolRow(ui.registry, name, where)
const tool = (name: string) => ({ type: 'toolCall' as const, id: name, name, arguments: {} })
const call = (name: string, args: Record<string, unknown>, more: Partial<ToolRowCall> = {}): ToolRowCall =>
  ({ machine: { id: 'local', label: 'This Mac', state: 'connected' }, thread, call: { id: 'c', name, arguments: args }, state: 'done', ...more })
/** The thread a row names, by its `ThreadRef`'s id. */
const named = (name: string, c: ToolRowCall) => (rowOf(name).subject?.(c) as { props?: { id?: string } } | undefined)?.props?.id

it('says what a run of thread tools did, and reads each row', () => {
  expect(describeRun([tool('thread_start'), tool('thread_read'), tool('thread_read')], rowOf)).toEqual(['Started a thread and read 2 threads'])
  expect(mainKind([tool('thread_list'), tool('read')], rowOf)).toBe('read')
  expect(renderToStaticMarkup(createElement(DescribedCall, { row: rowOf('thread_list'), call: call('thread_list', {}) }))).not.toContain('row__arg')
  const failed = renderToStaticMarkup(createElement(DescribedCall, { row: rowOf('thread_start'), call: call('thread_start', { title: 'Dates' }, { state: 'error', result: { text: 'no', isError: true } }) }))
  expect(failed).toContain('Couldn’t start a thread')
  expect(failed).toContain('>Dates<')
  // Its own, not another's: a thread that goes without the tools (Ego) still shows them.
  expect(toolRow(ui.registry, 'thread_read', { machine: 'local', thread: { ...thread, without: ['thread-tools'] } }).verbs?.[0]).toBe('Read')
})

it('names the thread each call is about, and leaves out what only repeats it', () => {
  const sent = { text: 'Sent to [Dates](thread:42).', isError: false }
  // Started: by the id it answered with. Read, messaged, archived: by the tools' `thread` param.
  const started = call('thread_start', { prompt: 'Look into the dates', title: 'Dates' }, { result: { text: 'Started [Dates](thread:42) (id 42).', isError: false, details: { id: '42', title: 'Dates' } } })
  expect(named('thread_start', started)).toBe('42')
  expect(rowOf('thread_start').body?.(started)).toBeNull()
  expect(named('thread_read', call('thread_read', { thread: '42', wait: true }))).toBe('42')
  const messaged = call('thread_send', { thread: '42', text: 'Also ISO dates.' }, { result: sent })
  expect(named('thread_send', messaged)).toBe('42')
  expect(rowOf('thread_send').body?.(messaged)).toBeNull()
  const archived = call('thread_archive', { thread: '42' }, { result: { text: 'Archived [Dates](thread:42).', isError: false } })
  expect(named('thread_archive', archived)).toBe('42')
  expect(rowOf('thread_archive').body?.(archived)).toBeNull()
  // Not yet done, or about no other thread: said as it is.
  expect(rowOf('thread_send').body?.(call('thread_send', { thread: '42', text: 'hi' }, { state: 'working' }))).toBeUndefined()
  expect(rowOf('thread_archive').subject?.(call('thread_archive', {}))).toBe('this thread')
  expect(rowOf('thread_start').subject?.(call('thread_start', { prompt: 'p' }, { state: 'working' }))).toBe('a thread')
})

it('claims thread: links in a thread, and opens one there, or beside it', async () => {
  expect(linkHandler(ui.registry, 'thread:42', 'link', {})).toBeUndefined()
  expect(linkHandler(ui.registry, 'thread:42', 'code', where)).toBeUndefined()
  const handler = linkHandler(ui.registry, 'thread:42', 'link', where)!
  const dispatch = vi.spyOn(ui.registry.router, 'dispatch').mockResolvedValue(undefined as never)
  await handler.open('thread:42', { ...where, beside: false, kind: 'link' })
  expect(dispatch).toHaveBeenLastCalledWith('thread.select', { machine: 'local', thread: '42' }, expect.objectContaining({ source: 'thread link' }))
  await handler.open('thread:42', { ...where, beside: true, kind: 'link' })
  expect(dispatch).toHaveBeenLastCalledWith('pane.open', { thread: '1', kind: 'thread', params: { thread: '42' } }, expect.objectContaining({ machine: 'local' }))
  // Itself, beside itself, is just shown.
  await handler.open('thread:1', { ...where, beside: true, kind: 'link' })
  expect(dispatch).toHaveBeenLastCalledWith('thread.select', { machine: 'local', thread: '1' }, expect.anything())
})
