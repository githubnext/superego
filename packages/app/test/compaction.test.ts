// @vitest-environment happy-dom
// A new context in the transcript: a compaction's summary and a reset's handoff are user messages to the model, but
// nobody sent them; each shows as a folded row, not as your message, and doesn't start a turn.
import { createElement as h } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import type { EntryRecord } from '@earendil-works/pi-durable'
import { defineApp, MESSAGE_ENTRY, type ThreadInfo } from '@superego/protocol'
import { createRegistry, RegistryProvider } from '../src/renderer/registry.tsx'
import { registerToolRows } from '../src/renderer/tool-rows.tsx'
import { compactionSummary, Transcript } from '../src/renderer/transcript.tsx'

const app = defineApp({ name: 'test', id: 'compactiontest' })
const machine = { id: 'local', label: 'This Mac', state: 'connected' } as never
const thread = { id: '1', title: '', status: { state: 'done' } } as unknown as ThreadInfo

const SUMMARY = '## Goal\nShip the fix.\n\n## Constraints & Preferences\n- (none)'
const WRAPPED = `The conversation history before this point was compacted into the following summary:\n\n<summary>\n${SUMMARY}\n</summary>`

let id = 0
const entry = (kind: string, model?: unknown[], data?: unknown) => ({ id: ++id, kind, ...(model ? { model } : {}), ...(data ? { data } : {}) }) as unknown as EntryRecord
const user = (text: string, timestamp = 0) => entry(MESSAGE_ENTRY, [{ role: 'user', content: [{ type: 'text', text }], timestamp }])
const compaction = (text = WRAPPED) => entry('pi.compaction', [{ role: 'user', content: [{ type: 'text', text }], timestamp: 0 }], { reason: 'threshold' })
const calls = (callId: string) => entry('pi.assistant', [{ role: 'assistant', content: [{ type: 'toolCall', id: callId, name: 'bash', arguments: { command: 'ls' } }] }])
const answer = (text: string) => entry('pi.assistant', [{ role: 'assistant', content: [{ type: 'text', text }] }])

const draw = (entries: EntryRecord[], working = false) => {
  const live = working ? { run: {} } as never : undefined
  const shown = working ? { ...thread, status: { state: 'working' } } as ThreadInfo : thread
  const html = renderToStaticMarkup(h(RegistryProvider, { registry: createRegistry(app, [], registerToolRows), children: h(Transcript, { machine, thread: shown, view: { entries } as never, live }) }))
  return new DOMParser().parseFromString(html, 'text/html').body
}

it("takes a compaction's summary out of its wrapper, and leaves one without it as it is", () => {
  expect(compactionSummary(WRAPPED)).toBe(SUMMARY)
  expect(compactionSummary(`<summary>${SUMMARY}</summary>`)).toBe(SUMMARY)
  expect(compactionSummary(SUMMARY)).toBe(SUMMARY)
})

it('shows a compaction as a folded row that opens to its summary, and your message as yours', () => {
  const body = draw([user('fix it'), compaction()])
  expect(body.querySelectorAll('.msg--user')).toHaveLength(1)
  expect(body.querySelector('.msg--user')!.textContent).toBe('fix it')
  const row = body.querySelector('details.step--context')!
  expect(row.hasAttribute('open')).toBe(false)
  expect(row.querySelector('summary')!.textContent).toBe('Compacted conversation')
  const summary = row.querySelector('.step__context')!
  expect([...summary.querySelectorAll('h2')].map((e) => e.textContent)).toEqual(['Goal', 'Constraints & Preferences'])
  expect(summary.textContent).not.toMatch(/<\/?summary>|compacted into the following/)
})

it("shows a reset's handoff folded, and one without it as a row alone", () => {
  const body = draw([entry('pi.reset', [{ role: 'user', content: 'Carry on with the **fix**.', timestamp: 0 }]), entry('pi.reset')])
  expect(body.querySelector('.msg--user')).toBeNull()
  const [handoff, plain] = [...body.querySelectorAll('.steps')]
  expect(handoff!.querySelector('summary')!.textContent).toBe('Conversation reset')
  expect(handoff!.querySelector('.step__context strong')!.textContent).toBe('fix')
  expect(plain!.querySelector('details')).toBeNull()
  expect(plain!.textContent).toBe('Conversation reset')
})

it("doesn't end a turn at a compaction in the middle of it", () => {
  const body = draw([user('fix it'), calls('a'), compaction(), calls('b'), answer('Done.')])
  const ends = body.querySelectorAll('.turn-end')
  expect(ends).toHaveLength(1)
  expect(ends[0]!.textContent).toContain('2 steps')
  // A compaction after a turn comes after its end line.
  const after = draw([user('fix it'), calls('a'), answer('Done.'), compaction(), user('more')])
  const order = [...after.querySelectorAll('.turn-end, .step--context, .msg--user')].map((e) => e.matches('.turn-end') ? 'end' : e.matches('.step--context') ? 'compaction' : 'you')
  expect(order).toEqual(['you', 'end', 'compaction', 'you'])
})

it("times a turn going on from your message, not a compaction in it", () => {
  const body = draw([user('fix it', Date.now() - 90_000), calls('a'), compaction()], true)
  expect(body.querySelector('.transcript__working')!.textContent).toMatch(/1m 3\ds/)
})
