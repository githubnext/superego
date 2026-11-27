import { expect, it, vi } from 'vitest'
import type { EntryRecord } from '@earendil-works/pi-durable'
import { lastRun, recapOf } from '../src/recap.ts'

let id = 0
const entry = (...model: object[]) => ({ id: ++id, conversationId: 1, kind: 'pi.message', model }) as unknown as EntryRecord
const user = (text: string) => entry({ role: 'user', content: text })
const call = (callId: string, name: string, args: object) => entry({ role: 'assistant', content: [{ type: 'toolCall', id: callId, name, arguments: args }] })
const result = (callId: string, isError = false) => entry({ role: 'toolResult', toolCallId: callId, toolName: 'x', content: [], isError })
const said = (text: string) => entry({ role: 'assistant', content: [{ type: 'text', text }] })

it("is the last run: its calls in order, whether they failed, and its answer; nothing from the run before", () => {
  const transcript = [
    user('first'), call('a', 'task_finish', { outcome: 'Old' }), result('a'), said('Earlier.'),
    user('second'), call('b', 'read', { path: 'x' }), result('b'), call('c', 'task_finish', { outcome: 'Too long' }), result('c', true),
    call('d', 'task_finish', { outcome: 'Fixed it' }), result('d'), said('All good.'),
  ]
  expect(lastRun([...transcript].reverse())).toEqual({
    answer: 'All good.',
    calls: [
      { name: 'read', arguments: { path: 'x' }, failed: false },
      { name: 'task_finish', arguments: { outcome: 'Too long' }, failed: true },
      { name: 'task_finish', arguments: { outcome: 'Fixed it' }, failed: false },
    ],
  })
  expect(lastRun([user('hi')])).toEqual({ calls: [] })
})

it("is an extension's recap, as plain text, shortened; else the answer's first sentence; else nothing", () => {
  const run = { thread: '1', answer: 'Merged to **main**. Then more.', calls: [] }
  expect(recapOf(run, [{ owner: 'x', recap: () => '**Shipped** the [fix](thread:2)' }])).toBe('Shipped the fix')
  expect(recapOf(run, [{ owner: 'x', recap: () => 'a '.repeat(80) }])).toMatch(/…$/)
  expect(recapOf(run, [{ owner: 'x', recap: () => undefined }, { owner: 'y', recap: () => '  ' }])).toBe('Merged to main.')
  const error = vi.spyOn(console, 'error').mockImplementation(() => {})
  expect(recapOf(run, [{ owner: 'x', recap: () => { throw new Error('no') } }])).toBe('Merged to main.')
  expect(error).toHaveBeenCalledOnce()
  error.mockRestore()
  expect(recapOf({ thread: '1', calls: [] }, [])).toBeUndefined()
})

it("passes over a notice the agent was told mid-run, and says a note that's newest", async () => {
  const { NOTE_ENTRY } = await import('@superego/protocol')
  const { noteRecap } = await import('../src/recap.ts')
  const notice = { id: ++id, conversationId: 1, kind: NOTE_ENTRY, data: { text: 'Checks **failed**.', by: 'checks' }, model: [{ role: 'user', content: '<notice>' }] } as unknown as EntryRecord
  const transcript = [user('fix it'), call('a', 'read', { path: 'x' }), notice, result('a'), said('Fixed.')]
  expect(lastRun([...transcript].reverse())).toEqual({ answer: 'Fixed.', calls: [{ name: 'read', arguments: { path: 'x' }, failed: false }] })
  expect(noteRecap(notice)).toBe('Checks failed.')
  expect(noteRecap(said('Fixed.'))).toBeUndefined()
})
