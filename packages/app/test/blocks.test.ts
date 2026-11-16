// @vitest-environment happy-dom
// The window's blocks: drawn for an agent (pressing answers it) or for an extension (pressing runs its own action, with
// the inputs' values in the params), refused whole where they aren't what their host may draw, and keeping what the
// user typed when new blocks come.
import { act, createElement as h } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import type { Block, Json, Reply } from '@superego/protocol'
import type { MachineEntry } from '../src/shared/bridge.ts'
import { Blocks, type BlocksHost } from '../src/renderer/blocks/blocks.tsx'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const machine: MachineEntry = { id: 'm', label: 'm', state: 'connected', features: [], extensions: [] }
let root: Root | undefined
let container: HTMLElement
afterEach(async () => { await act(async () => root?.unmount()); root = undefined; container?.remove() })

async function draw(blocks: Block[], host: BlocksHost) {
  if (!root) {
    container = document.body.appendChild(document.createElement('div'))
    root = createRoot(container)
  }
  await act(async () => root!.render(h(Blocks, { machine, blocks, host })))
}

const button = (label: string, n = 0) => [...container.querySelectorAll('button')].filter((b) => b.textContent === label)[n]!
const press = (label: string, n = 0) => act(async () => { button(label, n).click() })
async function type(input: HTMLInputElement, text: string) {
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  await act(async () => { set.call(input, text); input.dispatchEvent(new Event('input', { bubbles: true })) })
}

const builds = (run: (action: string, params: Json) => Promise<unknown>): BlocksHost => ({ by: 'extension', extension: 'builds', run })
const queue = (titles: string[]): Block[] => [
  { type: 'text', id: 'reason', label: 'Why' },
  { type: 'list', items: titles.map((title, i) => ({ title, buttons: [{ id: `cancel-${i}`, label: 'Cancel', action: 'builds.cancel', params: { id: String(i) } }] })) },
]

it("runs an extension's own action from a row, with the inputs' values in its params, and no submit button", async () => {
  const run = vi.fn(async () => null)
  await draw(queue(['npm test', 'npm run build']), builds(run))
  expect(container.textContent).toContain('npm run build')
  expect(button('Submit')).toBeUndefined()
  await type(container.querySelector('input')!, 'flaky')
  await press('Cancel', 1)
  expect(run).toHaveBeenCalledWith('builds.cancel', { id: '1', reason: 'flaky' })
})

it("keeps what the user typed when the view's blocks change, by input id", async () => {
  const run = vi.fn(async () => null)
  await draw(queue(['npm test']), builds(run))
  await type(container.querySelector('input')!, 'flaky')
  await draw(queue(['npm test', 'npm run lint']), builds(run))
  expect(container.querySelector('input')!.value).toBe('flaky')
  await press('Cancel', 1)
  expect(run).toHaveBeenCalledWith('builds.cancel', { id: '1', reason: 'flaky' })
})

it('says why an action failed, in place', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  await draw(queue(['npm test']), builds(async () => { throw new Error('No such build') }))
  await press('Cancel')
  expect(container.querySelector('.blocks-error')?.textContent).toBe('No such build')
})

it("refuses blocks whole that aren't what their host may draw, saying why", async () => {
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
  // Another's action, from an extension's view.
  await draw([{ type: 'markdown', text: 'Queue' }, { type: 'buttons', buttons: [{ id: 'rm', label: 'Remove', action: 'machine.remove' }] }], builds(async () => null))
  expect(container.textContent).toBe('This UI can’t be drawn: blocks[1].buttons[0].action: "machine.remove" isn\'t one of builds\'s actions')
  // An action at all, from an agent's.
  await draw([{ type: 'buttons', buttons: [{ id: 'rm', label: 'Remove', action: 'builds.cancel' }] }], { by: 'agent', reply: async () => null })
  expect(container.textContent).toMatch(/^This UI can’t be drawn: .*an agent's buttons answer/)
  expect(errors).toHaveBeenCalled()
})

it("answers an agent with a row's button", async () => {
  const replies: Reply[] = []
  const agent: BlocksHost = { by: 'agent', reply: async (r) => { replies.push(r) } }
  await draw([{ type: 'list', items: [{ title: 'a', status: 'working', buttons: [{ id: 'stop-a', label: 'Stop' }] }] }], agent)
  expect(container.querySelector('.superego-status--working')).not.toBeNull()
  await press('Stop')
  expect(replies).toEqual([{ button: 'stop-a', values: {} }])
})
