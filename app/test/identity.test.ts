import { describe, expect, it } from 'vitest'
import type { Hello } from '@mu/protocol'
import { checkIdentity } from '../src/main/identity.ts'

const hello = (id: string): Hello => ({ version: 2, features: [], methods: [], machine: { id, hostname: `host-${id}`, platform: 'linux', pid: 1, dataDir: '/' } })

describe('checkIdentity', () => {
  it('accepts the first machine at a route, and the same one later', () => {
    expect(() => checkIdentity(hello('a'), { target: 'box' }, [])).not.toThrow()
    expect(() => checkIdentity(hello('a'), { target: 'box', expected: 'a' }, [])).not.toThrow()
  })

  it('refuses a different machine answering at a known route', () => {
    expect(() => checkIdentity(hello('b'), { target: 'box', expected: 'a' }, [])).toThrow(expect.objectContaining({ kind: 'wrong_machine', message: expect.stringContaining('host-b') }))
  })

  it('refuses a machine that is already connected another way', () => {
    expect(() => checkIdentity(hello('a'), { target: 'localhost' }, [{ label: 'This computer', id: 'a' }]))
      .toThrow(expect.objectContaining({ kind: 'duplicate_machine', message: expect.stringContaining('This computer') }))
  })
})
