import { expect, it } from 'vitest'
import { statusLabel, statusShape, statusWord } from '../src/index.ts'

it('names what a status wants in a word: Question, Permission, Sign in, Failed, Done', () => {
  expect(statusWord({ state: 'idle' })).toBe('')
  expect(statusWord({ state: 'working' })).toBe('Working')
  expect(statusWord({ state: 'done', msg: 'Fixed the test' })).toBe('Done')
  expect(statusWord({ state: 'blocked', kind: 'question' })).toBe('Question')
  expect(statusWord({ state: 'blocked', kind: 'permission' })).toBe('Permission')
  expect(statusWord({ state: 'blocked', kind: 'auth' })).toBe('Sign in')
  expect(statusWord({ state: 'blocked' })).toBe('Question')
  expect(statusWord({ state: 'error' })).toBe('Failed')
})

it("doesn't call a quiet thread's finished run unread: its parent hears", () => {
  expect(statusShape({ state: 'done' }, true)).toBe('idle')
  expect(statusWord({ state: 'done' }, true)).toBe('')
  expect(statusShape({ state: 'working' }, true)).toBe('working')
  expect(statusShape({ state: 'blocked', kind: 'permission' }, true)).toBe('permission')
  expect(statusShape({ state: 'error' }, true)).toBe('error')
})

it('labels a status with its word and what it did, or why it failed or waits', () => {
  expect(statusLabel({ state: 'idle' })).toBe('Idle')
  expect(statusLabel({ state: 'done', msg: 'Fixed the test' })).toBe('Done: Fixed the test')
  expect(statusLabel({ state: 'error', msg: 'Out of credits' })).toBe('Failed: Out of credits')
  expect(statusLabel({ state: 'blocked', kind: 'question', msg: 'Which branch?' })).toBe('Question')
  expect(statusLabel({ state: 'blocked', kind: 'auth', msg: 'OpenAI rejected the sign-in' })).toBe('Sign in: OpenAI rejected the sign-in')
})
