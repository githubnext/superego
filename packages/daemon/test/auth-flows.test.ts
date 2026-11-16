// Sign-in flows: one left waiting is given up on after its timeout, its prompts put away; one that ends in time isn't.
// Time is the test's own (fake timers): a flow's timeout passes as the test says.
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AuthEvent } from '@superego/protocol'
import { createAuthFlows } from '../src/auth-flows.ts'

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

it('gives up on a flow left waiting, closing its prompt and aborting its signal', async () => {
  const flows = createAuthFlows({ timeout: 100 })
  const events: AuthEvent[] = []
  let aborted = false
  flows.start((event) => events.push(event), async (flow) => {
    flow.signal.addEventListener('abort', () => { aborted = true })
    await flow.prompt({ type: 'manual_code', message: 'Paste the address' })
  })
  await vi.advanceTimersByTimeAsync(99)
  expect(events.map((e) => e.type)).toEqual(['prompt'])
  await vi.advanceTimersByTimeAsync(1)
  expect(aborted).toBe(true)
  expect(events.map((e) => e.type)).toEqual(['prompt', 'prompt_closed', 'failed'])
  expect(events.at(-1)).toEqual({ type: 'failed', message: expect.stringMatching(/^Timed out/) })
})

it("doesn't time out a flow that ends in time, nor call a cancel a time-out", async () => {
  const flows = createAuthFlows({ timeout: 100 })
  const events: AuthEvent[] = []
  flows.start((event) => events.push(event), async () => {})
  const cancelled: AuthEvent[] = []
  const id = flows.start((event) => cancelled.push(event), (flow) => new Promise((_, reject) => {
    flow.signal.addEventListener('abort', () => reject(new Error('stopped')))
  }))
  await vi.advanceTimersByTimeAsync(0)
  flows.cancel(id)
  // Past both flows' timeouts: neither says more.
  await vi.advanceTimersByTimeAsync(150)
  expect(events).toEqual([{ type: 'done' }])
  expect(cancelled).toEqual([{ type: 'failed', message: 'Cancelled' }])
})
