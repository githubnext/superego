// What a turn gives Claude Code: the run's inputs, after the notices extensions gave the thread since its last answer.
import { expect, it } from 'vitest'
import type { EntryId } from '@earendil-works/pi-durable'
import { NOTE_ENTRY } from '@superego/protocol'
import { inputsOf } from '../src/turn.ts'

const entry = (id: number, role: string, text: string, kind = 'pi.message') => ({ id: id as EntryId, kind, model: [{ role, content: text }] })

it('gives the run its inputs, with the notices since the last answer before them', () => {
  const entries = [
    entry(1, 'user', 'first'),
    entry(2, 'user', '<notice>old</notice>', NOTE_ENTRY),
    entry(3, 'assistant', 'done'),
    entry(4, 'user', '<notice>checks failed</notice>', NOTE_ENTRY),
    { id: 5 as EntryId, kind: NOTE_ENTRY },
    entry(6, 'user', 'fix it'),
  ]
  expect(inputsOf(entries, 6 as EntryId)).toEqual([{ type: 'text', text: '<notice>checks failed</notice>' }, { type: 'text', text: 'fix it' }])
  // Continued without an input of its own: everything since the last answer.
  expect(inputsOf(entries, undefined)).toEqual([{ type: 'text', text: '<notice>checks failed</notice>' }, { type: 'text', text: 'fix it' }])
  expect(inputsOf(entries.slice(0, 3), 1 as EntryId)).toEqual([{ type: 'text', text: 'first' }, { type: 'text', text: '<notice>old</notice>' }])
})
