import { expect, it } from 'vitest'
import { statusLabel } from '../src/index.ts'

it('names a status in words, with what it waits on or its recap', () => {
  expect(statusLabel({ state: 'idle' })).toBe('Idle')
  expect(statusLabel({ state: 'working' })).toBe('Working')
  expect(statusLabel({ state: 'done', msg: 'Fixed the test' })).toBe('Finished: Fixed the test')
  expect(statusLabel({ state: 'error', msg: 'Out of credits' })).toBe('Failed: Out of credits')
  expect(statusLabel({ state: 'blocked', kind: 'question', msg: 'Which branch?' })).toBe('Needs you: a question')
  expect(statusLabel({ state: 'blocked' })).toBe('Needs you')
  expect(statusLabel({ state: 'blocked', kind: 'auth' })).toBe('Waiting for sign-in')
})
