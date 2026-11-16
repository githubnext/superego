import { describe, expect, it } from 'vitest'
import { compareVersions, describeDrift, roughly, versionOf, type Hello } from '../src/index.ts'

const DAY = 86_400_000
const here = { build: 'b2', protocol: 2, commit: '6d7de5904f9b0000', committedAt: 10 * DAY }

describe('machine versions', () => {
  it('reads what hello says, and no commit outside git', () => {
    const machine = { id: 'm', hostname: 'mbp', platform: 'darwin', pid: 1, dataDir: '/d', build: 'b1', keepsRunning: { service: null, afterLogout: null } }
    const hello = { version: 2, features: [], methods: [], extensions: [], api: '2.1.0', client: 'c1', machine } satisfies Hello
    expect(versionOf(hello)).toEqual({ build: 'b1', protocol: 2 })
    expect(versionOf({ ...hello, machine: { ...machine, commit: 'abc', committedAt: 5 } })).toMatchObject({ commit: 'abc', committedAt: 5 })
  })

  const at = (commit: string, committedAt: number) => ({ build: 'b', protocol: 2, commit, committedAt })
  it('tells a machine behind this computer, ahead of it, or on the same commit', () => {
    expect(compareVersions(here, { ...here, build: 'other' })).toEqual({ state: 'current' })
    expect(compareVersions(here, at('5e9684c00', 8 * DAY))).toEqual({ state: 'behind', commit: '5e9684c00', by: 2 * DAY })
    expect(compareVersions(here, at('aaaa', 10 * DAY + 3_600_000))).toEqual({ state: 'ahead', commit: 'aaaa', by: 3_600_000 })
    expect(compareVersions(here, at('bbbb', 10 * DAY))).toEqual({ state: 'differs', commit: 'bbbb' })
  })

  it('counts a machine that knows no commit as unknown, and compares nothing when this computer knows none', () => {
    expect(compareVersions(here, { build: 'outside-git', protocol: 2 })).toEqual({ state: 'unknown' })
    expect(compareVersions(here, undefined)).toEqual({ state: 'unknown' })
    expect(compareVersions({ build: 'b', protocol: 2 }, here)).toBeUndefined()
  })

  it('says it quietly, in one line', () => {
    expect(describeDrift('mbp', compareVersions(here, at('5e9684c00', 8 * DAY)))).toBe('mbp runs an older Superego (5e9684c, 2 days behind)')
    expect(describeDrift('mbp', compareVersions(here, at('abcdef12', 10 * DAY + 3_600_000)))).toBe('mbp runs a newer Superego (abcdef1, 1 hour ahead)')
    expect(describeDrift('mbp', { state: 'unknown' })).toBe("mbp runs a Superego that doesn't know its commit")
    expect(describeDrift('mbp', { state: 'current' })).toBeUndefined()
    expect(describeDrift('mbp', undefined)).toBeUndefined()
    expect([roughly(1000), roughly(5 * 60_000), roughly(30 * 3_600_000), roughly(3 * DAY)]).toEqual(['1 minute', '5 minutes', '30 hours', '3 days'])
  })
})
