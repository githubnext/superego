import { expect, it } from 'vitest'
import { promptsOf, transcriptOf } from '../src/suggest.ts'

it('reads the conversation as who said what, without tool calls, from the end', () => {
  expect(transcriptOf([
    { role: 'user', content: 'Fix the dates' },
    { role: 'assistant', content: [{ type: 'toolCall' }, { type: 'text', text: 'Fixed.' }] },
    { role: 'toolResult', content: 'ok' },
  ])).toBe('User: Fix the dates\n\nAgent: Fixed.')
  expect(transcriptOf([{ role: 'user', content: 'x'.repeat(50) }], 10)).toBe(`…${'x'.repeat(10)}`)
})

it('takes the last JSON array of strings in a reply, at most three, short and distinct', () => {
  expect(promptsOf('```json\n["Run the tests", "Commit this"]\n```')).toEqual(['Run the tests', 'Commit this'])
  expect(promptsOf('["a"] then [not json] and ["b", "b", 3, " c ", "d", "e"]')).toEqual(['b', 'c', 'd'])
  expect(promptsOf(`["${'x'.repeat(121)}"]`)).toEqual([])
  expect(promptsOf('Nothing to suggest.')).toEqual([])
})
