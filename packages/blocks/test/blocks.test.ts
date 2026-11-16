import { expect, it } from 'vitest'
import { blockErrors, checkBlocks, describeReply, initialValues, needsSubmit, picksAnswer, type Block } from '../src/blocks.ts'

it('takes every kind of block, nested', () => {
  const blocks: Block[] = [
    { type: 'markdown', text: '**Hi**' },
    { type: 'callout', tone: 'warn', text: 'Careful' },
    { type: 'card', title: 'Plan', blocks: [
      { type: 'row', blocks: [{ type: 'kv', items: [{ label: 'Files', value: 3 }] }, { type: 'code', code: 'x', language: 'ts' }] },
      { type: 'table', columns: ['a', 'b'], rows: [[1, null], ['x', true]] },
    ] },
    { type: 'choice', id: 'size', options: [{ label: 'Small', preview: { type: 'markdown', text: 'tiny' } }, { label: 'Large', value: 'l' }] },
    { type: 'slider', id: 'n', min: 0, max: 10 },
    { type: 'open', label: 'See it', kind: 'editor', path: 'a.md', line: 3 },
    { type: 'html', html: '<b>hi</b>', id: 'chart' },
    { type: 'buttons', buttons: [{ id: 'go', label: 'Go', style: 'primary' }] },
  ]
  expect(blockErrors(blocks)).toEqual([])
  expect(checkBlocks(blocks)).toBe(blocks)
})

it('says where blocks are wrong, in words a model can act on', () => {
  expect(blockErrors([])).toEqual(['blocks: expected at least 1 items'])
  expect(blockErrors([{ type: 'markdown', txt: 'x' }])).toEqual(['blocks[0].text: missing', 'blocks[0].txt: unknown field'])
  expect(blockErrors([{ type: 'card', blocks: [{ type: 'nope' }] }])[0]).toMatch(/^blocks\[0\]\.blocks\[0\]\.type: expected one of/)
  expect(blockErrors([{ type: 'choice', id: 'a', options: [{ label: 'x' }] }, { type: 'text', id: 'a' }])).toEqual(['blocks[1].id: "a" is used twice; ids must be unique'])
  expect(blockErrors([{ type: 'open', label: 'x', kind: 'preview' }])).toEqual(['blocks[0].url: missing (a preview pane opens a web page)'])
  expect(() => checkBlocks([{ type: 'divider', x: 1 }])).toThrow(/blocks\[0\]\.x: unknown field[\s\S]*call again/)
})

it('answers at once from a lone choice, and otherwise needs submitting', () => {
  const lone: Block[] = [{ type: 'markdown', text: 'Pick' }, { type: 'choice', id: 'c', options: [{ label: 'A' }, { label: 'B' }] }]
  expect(picksAnswer(lone)).toBe(true)
  expect(needsSubmit(lone)).toBe(false)
  const form: Block[] = [...lone, { type: 'switch', id: 's', label: 'Force' }]
  expect(picksAnswer(form)).toBe(false)
  expect(needsSubmit(form)).toBe(true)
  expect(needsSubmit([...form, { type: 'buttons', buttons: [{ id: 'ok', label: 'OK' }] }])).toBe(false)
  expect(initialValues(form)).toEqual({ c: null, s: false })
})

it('words a reply as the message it sends', () => {
  const choice: Block[] = [{ type: 'choice', id: 'c', options: [{ label: 'Option A', value: 'a' }, { label: 'Option B', value: 'b' }] }]
  expect(describeReply(choice, { values: { c: 'b' }, button: 'submit' })).toBe('→ Option B')
  const form: Block[] = [
    { type: 'select', id: 'env', label: 'Environment', options: [{ label: 'Staging' }, { label: 'Production' }] },
    { type: 'switch', id: 'force', label: 'Force' },
    { type: 'buttons', buttons: [{ id: 'deploy', label: 'Deploy' }] },
  ]
  expect(describeReply(form, { values: { env: 'Staging', force: true }, button: 'deploy' })).toBe('→ Deploy\nEnvironment: Staging\nForce: yes')
  expect(describeReply([{ type: 'html', html: 'x' }], { values: { html: { x: 1 } }, button: 'html' })).toBe('→ {"x":1}')
  expect(describeReply(form, { values: {}, text: 'never mind' })).toBe('never mind')
})
