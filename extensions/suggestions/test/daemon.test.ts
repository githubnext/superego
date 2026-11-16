// suggestions against a real daemon (the echo model): what the user might send next, asked of the thread's model once it
// answers, and taken away as the thread moves on.
import { expect, it } from 'vitest'
import { testDaemon } from '@superego/sdk/testing'
import suggestions from '../src/daemon.ts'
import { NEXT, type Suggested } from '../src/shared.ts'

it('asks the thread\'s model for next prompts once it answers, and drops them when the thread moves on', async () => {
  // The echo model answers with the last user message: the agent echoes the prompt, and the side call echoes the
  // transcript, whose last JSON array is the suggestions.
  const daemon = await testDaemon({ extensions: [suggestions], model: 'echo' })
  const thread = await daemon.thread()
  const next = await daemon.watch<Suggested | null>(NEXT, { scope: thread.id })
  await daemon.send(thread.id, '["Run the tests", "Commit this"]')
  expect((await next.until((value) => value !== null, 'the suggestions'))!.prompts).toEqual(['Run the tests', 'Commit this'])

  // Its next message takes them away; this answer suggests nothing (its last array is empty), so none come back.
  await daemon.send(thread.id, '[]')
  expect(next.value).toBeNull()
  await daemon.close()
})
