import { expect, it } from 'vitest'
import { waitUntil } from '../src/main/wait.ts'

it('answers what the check finds, once it finds something', async () => {
  let tries = 0
  expect(await waitUntil(() => ++tries === 3 ? 'found' : undefined, 1000, 'never', 1)).toBe('found')
  expect(tries).toBe(3)
})

it('fails with the error given once the time is up', async () => {
  await expect(waitUntil(() => undefined, 5, 'Gone quiet', 1)).rejects.toThrow('Gone quiet')
  const failure = Object.assign(new Error('Did not answer'), { kind: 'update_failed' })
  await expect(waitUntil(() => undefined, 5, failure, 1)).rejects.toBe(failure)
})
