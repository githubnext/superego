import { expect, it } from 'vitest'
import { offeredSkills, promptsOf, requestOf, SKILLS_BUDGET, SKILLS_MAX, suggestionsOf, SYSTEM, transcriptOf } from '../src/suggest.ts'

it('reads the conversation as who said what, without tool calls, from the end', () => {
  expect(transcriptOf([
    { role: 'user', content: 'Fix the dates' },
    { role: 'assistant', content: [{ type: 'toolCall' }, { type: 'text', text: 'Fixed.' }] },
    { role: 'toolResult', content: 'ok' },
  ])).toBe('User: Fix the dates\n\nAgent: Fixed.')
  expect(transcriptOf([{ role: 'user', content: 'x'.repeat(50) }], 10)).toBe(`…${'x'.repeat(10)}`)
})

it('takes the last JSON array of strings in a reply, short and distinct', () => {
  expect(promptsOf('```json\n["Run the tests", "Commit this"]\n```')).toEqual(['Run the tests', 'Commit this'])
  expect(promptsOf('["a"] then [not json] and ["b", "b", 3, " c ", "d"]')).toEqual(['b', 'c', 'd'])
  expect(promptsOf(`["${'x'.repeat(121)}"]`)).toEqual([])
  expect(promptsOf('Nothing to suggest.')).toEqual([])
})

const skill = (name: string, description: string, manual?: boolean) => ({ name, description, ...(manual ? { manual } : {}) })

it('tells the model the skills in a line each, their first sentence, leaving out those only asked for by name', () => {
  const offered = offeredSkills([
    skill('commit', 'Write git commit messages.  Use when asked to commit.'),
    skill('secret', 'Only by name.', true),
    skill('wordy', `Does ${'many things '.repeat(20)}all at once.`),
  ], '')
  expect(offered.map(({ line }) => line)).toEqual(['commit: Write git commit messages.', expect.stringMatching(/^wordy: Does many things .{40,}…$/)])
  expect(offered[1]!.line.length).toBeLessThan(100)
  const { systemPrompt, prompt } = requestOf('User: hi', offered)
  expect(prompt).toBe('User: hi')
  expect(systemPrompt.startsWith(SYSTEM)).toBe(true)
  expect(systemPrompt).toContain('\ncommit: Write git commit messages.\nwordy: Does')
  expect(systemPrompt).not.toContain('secret')
  // No skills, no word of them.
  expect(requestOf('User: hi', [])).toEqual({ systemPrompt: SYSTEM, prompt: 'User: hi' })
})

it('keeps the skills within their budget, those the conversation brings up first', () => {
  const many = Array.from({ length: 80 }, (_, i) => skill(`skill-${String(i).padStart(2, '0')}`, `Handles chore number ${i} of a long list of chores nobody asked about.`))
  const pr = skill('pr', 'Create and push pull requests.')
  const offered = offeredSkills([...many, pr], 'User: open a pull request for this\n\nAgent: Committed.')
  expect(offered.length).toBeLessThanOrEqual(SKILLS_MAX)
  expect(offered.reduce((sum, { line }) => sum + line.length + 1, 0)).toBeLessThanOrEqual(SKILLS_BUDGET)
  expect(offered[0]!.skill).toBe(pr)
  // Named in the conversation counts most.
  expect(offeredSkills([...many, pr], 'Agent: Done. Want $skill-77 next?')[0]!.skill.name).toBe('skill-77')
})

it('keeps one suggestion that runs a skill it was told of, as $name, and drops any naming another', () => {
  const skills = [skill('commit', 'Write  commit\nmessages.'), skill('pr', 'Pull requests.')]
  expect(suggestionsOf('["/commit", "$pr draft for the date fix", "Run the tests"]', skills)).toEqual([
    { text: '$commit', skill: { name: 'commit', description: 'Write commit messages.' } },
    { text: 'Run the tests' },
  ])
  expect(suggestionsOf('["$made-up do it", "/skill:pr draft.", "$commit."]', skills)).toEqual([
    { text: '$pr draft.', skill: { name: 'pr', description: 'Pull requests.' } },
  ])
  expect(suggestionsOf('["/tmp is full", "a", "b", "c", "d"]', [])).toEqual([{ text: 'a' }, { text: 'b' }, { text: 'c' }])
})
