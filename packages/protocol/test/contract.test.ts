// The extension contract: versions and ranges, what an extension's declaration says the host must be, and how a client
// asks a machine about an extension.
import { describe, expect, it } from 'vitest'
import { compareVersion, contractProblem, EXTENSION_API, extensionVersion, offers, parseVersion, satisfies, validRange } from '../src/index.ts'

describe('versions and ranges', () => {
  it('reads major.minor.patch and nothing looser', () => {
    expect(parseVersion('1.2.3')).toEqual([1, 2, 3])
    for (const bad of ['1.2', 'v1.2.3', '1.2.3-beta', '01.2.3', '']) expect(parseVersion(bad), bad).toBeUndefined()
    expect(compareVersion('1.10.0', '1.9.9')).toBeGreaterThan(0)
    expect(compareVersion('not', '0.0.0')).toBe(0)
  })

  it('takes the ranges package managers do', () => {
    const cases: [string, string, boolean][] = [
      ['1.0.0', '^1', true], ['1.9.0', '^1', true], ['2.0.0', '^1', false], ['0.9.0', '^1', false],
      ['1.2.0', '^1.2', true], ['1.1.9', '^1.2', false], ['1.9.0', '^1.2', true],
      ['0.2.5', '^0.2', true], ['0.3.0', '^0.2', false], ['0.0.3', '^0.0.3', true], ['0.0.4', '^0.0.3', false],
      ['1.2.9', '~1.2', true], ['1.3.0', '~1.2', false], ['1.2.3', '~1.2.3', true], ['1.9.0', '~1', true],
      ['1.2.0', '>=1.2', true], ['1.1.0', '>=1.2', false], ['1.9.9', '<2', true], ['2.0.0', '<2', false],
      ['0.0.0', '<2', true], ['1.3.0', '>1.2', true], ['1.2.5', '>1.2', false], ['1.2.5', '<=1.2', true],
      ['1.2.7', '1.2', true], ['1.3.0', '1.2', false], ['1.2.3', '1.2.3', true], ['1.2.3', '=1.2.4', false],
      ['5.0.0', '*', true], ['1.5.0', '>=1 <3', true], ['3.0.0', '>=1 <3', false], ['2.1.0', '^1 || ^2', true],
    ]
    for (const [version, range, expected] of cases) expect(satisfies(version, range), `${version} in ${range}`).toBe(expected)
    for (const bad of ['', '^', 'one', '^1.x', '>=1 ||', '1.2.3.4']) expect(validRange(bad), bad).toBe(false)
  })
})

describe("an extension's declaration", () => {
  it('needs a host in its api range, and says which side to update', () => {
    expect(EXTENSION_API).toBe('1.5.0')
    expect(contractProblem({ name: 'x', version: '1.0.0', api: '^1' })).toBeUndefined()
    expect(contractProblem({ name: 'x' })).toBeUndefined()
    expect(contractProblem({ name: 'x', api: '^2' })).toBe('Extension x needs extension API ^2, and this Superego has 1.5.0: update Superego')
    expect(contractProblem({ name: 'x', api: '^1.5' })).toMatch(/update Superego$/)
    expect(contractProblem({ name: 'x', api: '^1' }, '2.0.0')).toBe('Extension x needs extension API ^1, and this Superego has 2.0.0: update the extension')
    expect(contractProblem({ name: 'x', version: '1.0' })).toMatch(/version "1.0" isn't major.minor.patch/)
    expect(contractProblem({ name: 'x', api: 'latest' })).toMatch(/isn't a version range/)
  })
})

describe('asking a machine about an extension', () => {
  const now = { features: ['threads', 'ext:git', 'ext:mine'], extensions: [{ name: 'git', version: '1.3.0', capabilities: ['stat'] }, { name: 'mine' }] }
  it('by presence, as before', () => {
    expect(offers(now, 'threads')).toBe(true)
    expect(offers(now, 'ext:git')).toBe(true)
    expect(offers(now, 'ext:files')).toBe(false)
    expect(offers(undefined, 'ext:git')).toBe(false)
  })
  it('by version and capability', () => {
    expect(offers(now, 'ext:git@^1.2')).toBe(true)
    expect(offers(now, 'ext:git@^1.4')).toBe(false)
    expect(offers(now, 'ext:git@^2')).toBe(false)
    expect(offers(now, 'ext:git#stat')).toBe(true)
    expect(offers(now, 'ext:git#blame')).toBe(false)
    expect(offers(now, 'ext:git@^1#stat')).toBe(true)
    expect(extensionVersion(now, 'git')).toBe('1.3.0')
    // One that says no version counts as 0.0.0.
    expect(extensionVersion(now, 'mine')).toBe('0.0.0')
    expect(offers(now, 'ext:mine@^1')).toBe(false)
    expect(offers(now, 'ext:mine@<2')).toBe(true)
  })
  it("by what's on, not what it once declared: one switched off isn't there at any version", () => {
    const off = { features: ['threads'], extensions: [{ name: 'git', version: '1.3.0' }] }
    expect(offers(off, 'ext:git@^1')).toBe(false)
    expect(extensionVersion(off, 'git')).toBeUndefined()
  })
  it('from a daemon before versions: present, at 0.0.0', () => {
    const old = { features: ['threads', 'ext:git'] }
    expect(offers(old, 'ext:git')).toBe(true)
    expect(offers(old, 'ext:git@^1')).toBe(false)
    expect(offers(old, 'ext:git@<2')).toBe(true)
  })
})
