import { expect, it } from 'vitest'
import { ago } from '../src/ago.ts'

it('says how long ago briefly', () => {
  const now = Date.parse('2026-11-04T12:00:00Z')
  expect(ago(now - 20_000, now)).toBe('now')
  expect(ago(now - 5 * 60_000, now)).toBe('5m')
  expect(ago(now - 3 * 3_600_000, now)).toBe('3h')
  expect(ago(Number.NaN, now)).toBe('')
})
