// Sign-in flows: one left waiting is given up on after its timeout, its prompts put away; one that ends in time isn't.
import { expect, it } from 'vitest'
import type { AuthEvent } from '@superego/protocol'
import { createAuthFlows } from '../src/auth-flows.ts'

const until = async (check: () => boolean) => {
  for (let i = 0; i < 200; i++) { if (check()) return; await new Promise((r) => setTimeout(r, 10)) }
  throw new Error('timed out waiting')
}

it('gives up on a flow left waiting, closing its prompt and aborting its signal', async () => {
  const flows = createAuthFlows({ timeout: 100 })
  const events: AuthEvent[] = []
  let aborted = false
  flows.start((event) => events.push(event), async (flow) => {
    flow.signal.addEventListener('abort', () => { aborted = true })
    await flow.prompt({ type: 'manual_code', message: 'Paste the address' })
  })
  await until(() => events.some((e) => e.type === 'failed'))
  expect(aborted).toBe(true)
  expect(events.map((e) => e.type)).toEqual(['prompt', 'prompt_closed', 'failed'])
  expect(events.at(-1)).toEqual({ type: 'failed', message: expect.stringMatching(/^Timed out/) })
})

it("doesn't time out a flow that ends in time, nor call a cancel a time-out", async () => {
  const flows = createAuthFlows({ timeout: 100 })
  const events: AuthEvent[] = []
  flows.start((event) => events.push(event), async () => {})
  await until(() => events.length > 0)
  const cancelled: AuthEvent[] = []
  let started = false
  const id = flows.start((event) => cancelled.push(event), (flow) => new Promise((_, reject) => {
    started = true
    flow.signal.addEventListener('abort', () => reject(new Error('stopped')))
  }))
  await until(() => started)
  flows.cancel(id)
  await until(() => cancelled.length > 0)
  await new Promise((r) => setTimeout(r, 150))
  expect(events).toEqual([{ type: 'done' }])
  expect(cancelled).toEqual([{ type: 'failed', message: 'Cancelled' }])
})
