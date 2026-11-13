import { describe, expect, it } from 'vitest'
import { compareVersions, describeDrift, roughly, versionOf, type Hello } from '../src/index.ts'

const DAY = 86_400_000
const here = { build: 'b2', protocol: 1, commit: '6d7de5904f9b0000', committedAt: 10 * DAY }

describe('machine versions', () => {
  it('reads what hello says, and nothing an old daemon leaves out', () => {
    const machine = { id: 'm', hostname: 'mbp', platform: 'darwin', pid: 1, dataDir: '/d', build: 'b1' }
    expect(versionOf({ version: 1, features: [], methods: [], machine } satisfies Hello)).toEqual({ build: 'b1', protocol: 1 })
    expect(versionOf({ version: 1, features: [], methods: [], machine: { ...machine, commit: 'abc', committedAt: 5 } })).toMatchObject({ commit: 'abc', committedAt: 5 })
  })

  it('tells a machine behind this computer, ahead of it, or on the same commit', () => {
    expect(compareVersions(here, { ...here, build: 'other' })).toEqual({ state: 'current' })
    expect(compareVersions(here, { commit: '5e9684c00', committedAt: 8 * DAY })).toEqual({ state: 'behind', commit: '5e9684c00', by: 2 * DAY })
    expect(compareVersions(here, { commit: 'aaaa', committedAt: 10 * DAY + 3_600_000 })).toEqual({ state: 'ahead', commit: 'aaaa', by: 3_600_000 })
    expect(compareVersions(here, { commit: 'bbbb', committedAt: 10 * DAY })).toEqual({ state: 'differs', commit: 'bbbb' })
  })

  it('counts an old daemon that says no commit as unknown, and compares nothing when this computer has none', () => {
    expect(compareVersions(here, { build: 'old', protocol: 1 })).toEqual({ state: 'unknown' })
    expect(compareVersions(here, undefined)).toEqual({ state: 'unknown' })
    expect(compareVersions({ build: 'b', protocol: 1 }, here)).toBeUndefined()
  })

  it('says it quietly, in one line', () => {
    expect(describeDrift('mbp', compareVersions(here, { commit: '5e9684c00', committedAt: 8 * DAY }))).toBe('mbp runs an older Superego (5e9684c, 2 days behind)')
    expect(describeDrift('mbp', compareVersions(here, { commit: 'abcdef12', committedAt: 10 * DAY + 3_600_000 }))).toBe('mbp runs a newer Superego (abcdef1, 1 hour ahead)')
    expect(describeDrift('mbp', { state: 'unknown' })).toBe("mbp runs an older Superego that doesn't say which")
    expect(describeDrift('mbp', { state: 'current' })).toBeUndefined()
    expect(describeDrift('mbp', undefined)).toBeUndefined()
    expect([roughly(1000), roughly(5 * 60_000), roughly(30 * 3_600_000), roughly(3 * DAY)]).toEqual(['1 minute', '5 minutes', '30 hours', '3 days'])
  })
})
