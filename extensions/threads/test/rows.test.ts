// The UI half's thread tool rows and `thread:` links, in the registry: what a run of them says, how a row reads, and
// where a thread link is claimed and what following one does.
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it, vi } from 'vitest'
import { defineApp, type ThreadInfo } from '@superego/protocol'
// The registry isn't part of the UI API (the window builds it), so it's taken from where it's made.
import { createRegistry, defineUiExtension, linkHandler, toolRow, type ToolRowCall } from '../../../packages/app/src/renderer/extension.tsx'
import { DescribedCall, describeRun, mainKind, registerToolRows } from '../../../packages/app/src/renderer/tool-rows.tsx'
import { registerLinks, registerRows } from '../src/rows.tsx'

const app = defineApp({ name: 'superego', id: 'superego' })
const thread: ThreadInfo = { id: '1', title: 't', cwd: '/', createdAt: 0, activeAt: 0, project: { root: '/', name: '/' }, status: { state: 'idle' } }
const where = { machine: 'local', thread }
// Only the rows and links, not the sidebar.
const threads = defineUiExtension({ name: 'threads', required: true, setup(superego) { registerRows(superego); registerLinks(superego) } })
const registry = createRegistry(app, [threads], registerToolRows)
const rowOf = (name: string) => toolRow(registry, name, where)
const tool = (name: string) => ({ type: 'toolCall' as const, id: name, name, arguments: {} })
const call = (name: string, args: Record<string, unknown>, more: Partial<ToolRowCall> = {}): ToolRowCall =>
  ({ machine: { id: 'local', label: 'This Mac', state: 'connected' } as never, thread, call: { id: 'c', name, arguments: args }, state: 'done', ...more })

it('says what a run of thread tools did, and reads each row', () => {
  expect(describeRun([tool('thread_start'), tool('thread_read'), tool('thread_read')], rowOf)).toEqual(['Started a thread and read 2 threads'])
  expect(mainKind([tool('thread_list'), tool('read')], rowOf)).toBe('read')
  expect(renderToStaticMarkup(createElement(DescribedCall, { row: rowOf('thread_list'), call: call('thread_list', {}) }))).not.toContain('row__arg')
  const failed = renderToStaticMarkup(createElement(DescribedCall, { row: rowOf('thread_start'), call: call('thread_start', { title: 'Dates' }, { state: 'error', result: { text: 'no', isError: true } }) }))
  expect(failed).toContain('Couldn’t start a thread')
  expect(failed).toContain('>Dates<')
  // Its own, not another's: a thread that goes without the tools (Ego) still shows them.
  expect(toolRow(registry, 'thread_read', { machine: 'local', thread: { ...thread, without: ['thread-tools'] } }).verbs?.[0]).toBe('Read')
})

it('claims thread: links in a thread, and opens one there, or beside it', async () => {
  expect(linkHandler(registry, 'thread:42', 'link', {})).toBeUndefined()
  expect(linkHandler(registry, 'thread:42', 'code', where)).toBeUndefined()
  const handler = linkHandler(registry, 'thread:42', 'link', where)!
  const dispatch = vi.spyOn(registry.router, 'dispatch').mockResolvedValue(undefined as never)
  await handler.open('thread:42', { ...where, beside: false, kind: 'link' })
  expect(dispatch).toHaveBeenLastCalledWith('thread.select', { machine: 'local', thread: '42' }, expect.objectContaining({ source: 'thread link' }))
  await handler.open('thread:42', { ...where, beside: true, kind: 'link' })
  expect(dispatch).toHaveBeenLastCalledWith('pane.open', { id: '1', kind: 'thread', params: { thread: '42' } }, expect.objectContaining({ machine: 'local' }))
  // Itself, beside itself, is just shown.
  await handler.open('thread:1', { ...where, beside: true, kind: 'link' })
  expect(dispatch).toHaveBeenLastCalledWith('thread.select', { machine: 'local', thread: '1' }, expect.anything())
})
