import { expect, it } from 'vitest'
import type { ThreadInfo } from '@superego/protocol'
import { readsOf } from '../src/reads.ts'

const child = { id: 'c', parent: 'p', activeAt: 5, status: { state: 'done' } } as ThreadInfo

it('shares one log per data folder while either holds it, and forgets it once neither does', () => {
  const tools = new AbortController()
  const reports = new AbortController()
  readsOf('/data', tools.signal).note('p', child)
  expect(readsOf('/data', reports.signal).read(child)).toBe(true)
  expect(readsOf('/other', new AbortController().signal).read(child)).toBe(false)
  tools.abort()
  expect(readsOf('/data', new AbortController().signal).read(child)).toBe(true)
  reports.abort()
})

it('starts a daemon opened again on the folder with nothing read', () => {
  const first = new AbortController()
  readsOf('/again', first.signal).note('p', child)
  first.abort()
  expect(readsOf('/again', new AbortController().signal).read(child)).toBe(false)
})
