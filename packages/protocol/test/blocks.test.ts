import { expect, it } from 'vitest'
import { BLOCK_LIMITS, BLOCK_TYPES, BLOCKS_GUIDE, blockErrors, checkBlocks, describeReply, initialValues, keptValues, needsSubmit, picksAnswer, type Block, type BlocksUse } from '../src/index.ts'

const agent: BlocksUse = { by: 'agent' }
const builds = (thread: boolean): BlocksUse => ({ by: 'extension', extension: 'builds', thread })

it('takes every kind of block, nested', () => {
  const blocks: Block[] = [
    { type: 'markdown', text: '**Hi**' },
    { type: 'callout', tone: 'warn', text: 'Careful' },
    { type: 'card', title: 'Plan', blocks: [
      { type: 'row', blocks: [{ type: 'kv', items: [{ label: 'Files', value: 3 }] }, { type: 'code', code: 'x', language: 'ts' }] },
      { type: 'table', columns: ['a', 'b'], rows: [[1, null], ['x', true]] },
    ] },
    { type: 'list', items: [
      { title: 'Lint', status: 'working', detail: '5m', thread: '12', buttons: [{ id: 'stop-lint', label: 'Stop' }] },
      { title: 'Build', subtitle: 'npm run build' },
    ] },
    { type: 'choice', id: 'size', options: [{ label: 'Small', preview: { type: 'markdown', text: 'tiny' } }, { label: 'Large', value: 'l' }] },
    { type: 'slider', id: 'n', min: 0, max: 10 },
    { type: 'open', label: 'See it', kind: 'editor', params: { path: 'a.md', line: 3 } },
    { type: 'open', label: 'The changes', kind: 'diff' },
    { type: 'html', html: '<b>hi</b>', id: 'chart' },
    { type: 'buttons', buttons: [{ id: 'go', label: 'Go', style: 'primary' }] },
  ]
  expect(blockErrors(blocks, agent)).toEqual([])
  expect(checkBlocks(blocks, agent)).toBe(blocks)
})

it('says where blocks are wrong, in words a model can act on', () => {
  expect(blockErrors([], agent)).toEqual(['blocks: expected at least 1 items'])
  expect(blockErrors([{ type: 'markdown', txt: 'x' }], agent)).toEqual(['blocks[0].text: missing', 'blocks[0].txt: unknown field'])
  expect(blockErrors([{ type: 'card', blocks: [{ type: 'nope' }] }], agent)[0]).toMatch(/^blocks\[0\]\.blocks\[0\]\.type: expected one of/)
  expect(blockErrors([{ type: 'choice', id: 'a', options: [{ label: 'x' }] }, { type: 'text', id: 'a' }], agent)).toEqual(['blocks[1].id: "a" is used twice; ids must be unique'])
  expect(blockErrors([{ type: 'open', label: 'x', kind: 'editor', path: 'a.md' }], agent)).toEqual(['blocks[0].path: unknown field'])
  expect(blockErrors([{ type: 'list', items: [{ title: 'a', buttons: [{ id: 'x', label: 'X' }] }, { title: 'b', buttons: [{ id: 'x', label: 'X' }] }] }], agent))
    .toEqual(['blocks[0].items[1].buttons[0].id: "x" is used twice; ids must be unique'])
  expect(blockErrors([{ type: 'list', items: [{ title: 'a', status: 'sleeping' }] }], agent)[0]).toMatch(/^blocks\[0\]\.items\[0\]\.status: expected one of/)
  expect(() => checkBlocks([{ type: 'divider', x: 1 }], agent)).toThrow(/blocks\[0\]\.x: unknown field[\s\S]*call again/)
})

it('holds blocks to their limits, whoever drew them', () => {
  const long = 'x'.repeat(BLOCK_LIMITS.text + 1)
  expect(blockErrors([{ type: 'kv', items: [{ label: long, value: 1 }] }], agent)).toEqual([`blocks[0].items[0].label: expected at most ${BLOCK_LIMITS.text} characters`])
  expect(blockErrors([{ type: 'markdown', text: 'x'.repeat(BLOCK_LIMITS.markdown) }], agent)).toEqual([])
  const rows = Array.from({ length: BLOCK_LIMITS.items + 1 }, (_, i) => ({ title: `${i}` }))
  expect(blockErrors([{ type: 'list', items: rows }], builds(true))).toEqual([`blocks[0].items: expected at most ${BLOCK_LIMITS.items} items`])
  const buttons = Array.from({ length: BLOCK_LIMITS.buttons + 1 }, (_, i) => ({ id: `b${i}`, label: 'B' }))
  expect(blockErrors([{ type: 'buttons', buttons }], agent)).toEqual([`blocks[0].buttons: expected at most ${BLOCK_LIMITS.buttons} items`])
  // Nesting: eight deep is fine, nine isn't, previews included.
  const nest = (depth: number): Block => depth === 1 ? { type: 'divider' } : { type: 'stack', blocks: [nest(depth - 1)] }
  expect(blockErrors([nest(8)], agent)).toEqual([])
  expect(blockErrors([nest(9)], agent)).toEqual([`blocks[0]${'.blocks[0]'.repeat(8)}: blocks nest more than 8 deep`])
  expect(blockErrors([{ type: 'stack', blocks: [{ type: 'choice', id: 'c', options: [{ label: 'a', preview: nest(7) }] }] }], agent)[0]).toMatch(/options\[0\]\.preview.*nest more than 8 deep/)
  // Params: small, shallow JSON.
  const deep = Array.from({ length: 20 }).reduce<object>((v) => ({ v }), {})
  expect(blockErrors([{ type: 'open', label: 'x', kind: 'editor', params: deep as never }], agent)).toEqual(['blocks[0].params: must be JSON no more than 16 deep'])
  const big = { text: 'x'.repeat(BLOCK_LIMITS.params) }
  expect(blockErrors([{ type: 'buttons', buttons: [{ id: 'a', label: 'A', action: 'builds.run', params: big }] }], builds(false)))
    .toEqual([`blocks[0].buttons[0].params: more than ${BLOCK_LIMITS.params} characters of JSON`])
})

it("refuses an agent's buttons that would run an action", () => {
  expect(blockErrors([{ type: 'buttons', buttons: [{ id: 'go', label: 'Go', action: 'machine.remove' }] }], agent))
    .toEqual(["blocks[0].buttons[0]: an agent's buttons answer; they can't run actions (no action or params)"])
  expect(blockErrors([{ type: 'list', items: [{ title: 'a', buttons: [{ id: 'go', label: 'Go', params: { x: 1 } }] }] }], agent))
    .toEqual(["blocks[0].items[0].buttons[0]: an agent's buttons answer; they can't run actions (no action or params)"])
  expect(blockErrors([{ type: 'choice', id: 'c', options: [{ label: 'a', preview: { type: 'buttons', buttons: [{ id: 'go', label: 'Go', action: 'x.y' }] } }] }], agent))
    .toEqual(["blocks[0].options[0].preview[0].buttons[0]: an agent's buttons answer; they can't run actions (no action or params)"])
})

it("lets an extension's buttons run only its own actions, with params that don't clash with its inputs", () => {
  const cancel = (action: string | undefined, params?: Record<string, string>): Block[] => [
    { type: 'text', id: 'reason' },
    { type: 'list', items: [{ title: 'npm run build', buttons: [{ id: 'cancel-1', label: 'Cancel', ...(action ? { action } : {}), ...(params ? { params } : {}) }] }] },
  ]
  expect(blockErrors(cancel('builds.cancel', { id: '1' }), builds(true))).toEqual([])
  expect(blockErrors(cancel(undefined), builds(true))).toEqual(['blocks[1].items[0].buttons[0].action: an extension\'s buttons run one of its actions, "builds.<name>"'])
  expect(blockErrors(cancel('machine.remove'), builds(true))).toEqual(['blocks[1].items[0].buttons[0].action: "machine.remove" isn\'t one of builds\'s actions'])
  expect(blockErrors(cancel('builds.'), builds(true))).toHaveLength(1)
  expect(blockErrors(cancel('builds.cancel', { reason: 'x' }), builds(true)))
    .toEqual(['blocks[1].items[0].buttons[0].params.reason: "reason" is an input\'s id too; inputs go into the params by id'])
})

it('keeps a window view to what has no thread: no pane links, images only by address', () => {
  const blocks: Block[] = [{ type: 'open', label: 'Log', kind: 'editor', params: { path: 'log' } }, { type: 'image', src: 'chart.png' }, { type: 'image', src: 'https://x.test/a.png' }]
  expect(blockErrors(blocks, builds(true))).toEqual([])
  expect(blockErrors(blocks, builds(false))).toEqual([
    'blocks[0]: a window view has no thread to open a pane beside',
    "blocks[1].src: a window view's image must be an https: or data: address",
  ])
})

it('describes every block in its guide', () => {
  for (const type of BLOCK_TYPES) expect(BLOCKS_GUIDE).toMatch(new RegExp(`(^|[\\s|-])${type} \\{`))
  // What only an extension may use stays out of what every agent reads.
  expect(BLOCKS_GUIDE).not.toMatch(/\baction\b/)
})

it('answers at once from a lone choice, and otherwise needs submitting', () => {
  const lone: Block[] = [{ type: 'markdown', text: 'Pick' }, { type: 'choice', id: 'c', options: [{ label: 'A' }, { label: 'B' }] }]
  expect(picksAnswer(lone)).toBe(true)
  expect(needsSubmit(lone)).toBe(false)
  const form: Block[] = [...lone, { type: 'switch', id: 's', label: 'Force' }]
  expect(picksAnswer(form)).toBe(false)
  expect(needsSubmit(form)).toBe(true)
  expect(needsSubmit([...form, { type: 'buttons', buttons: [{ id: 'ok', label: 'OK' }] }])).toBe(false)
  expect(needsSubmit([...form, { type: 'list', items: [{ title: 'a', buttons: [{ id: 'ok', label: 'OK' }] }] }])).toBe(false)
  expect(initialValues(form)).toEqual({ c: null, s: false })
})

it('keeps what the user typed across new blocks, by input id', () => {
  const next: Block[] = [{ type: 'text', id: 'name', default: 'x' }, { type: 'switch', id: 'force', label: 'Force' }]
  expect(keptValues(next, { name: 'typed', gone: 'y' })).toEqual({ name: 'typed', force: false })
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
  // A row's button says its row: rows repeat the same buttons.
  const rows: Block[] = [{ type: 'list', items: [
    { title: 'npm test', buttons: [{ id: 'cancel-1', label: 'Cancel' }] },
    { title: 'npm run build', buttons: [{ id: 'cancel-2', label: 'Cancel' }] },
  ] }]
  expect(describeReply(rows, { values: {}, button: 'cancel-2' })).toBe('→ Cancel: npm run build')
})
