import { mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { hashModules, uiDecision, type UiGrant } from '../src/ui-trust.ts'
import { UiTrust } from '../src/main/ui-trust.ts'

const grant: UiGrant = { machine: 'm1', dir: '/p/obsidian', hash: 'abc' }

it('hashes modules the same in any order, and differently when a path or code changes', async () => {
  const a = { path: 'a.tsx', code: 'export default 1' }
  const b = { path: 'b.tsx', code: 'export default 2' }
  const hash = await hashModules([a, b])
  expect(hash).toMatch(/^[0-9a-f]{64}$/)
  expect(await hashModules([b, a])).toBe(hash)
  expect(await hashModules([a, { ...b, code: 'export default 3' }])).not.toBe(hash)
  expect(await hashModules([a, { ...b, path: 'c.tsx' }])).not.toBe(hash)
  // Moving text across the path/code boundary is a different set.
  expect(await hashModules([{ path: 'ab', code: 'c' }])).not.toBe(await hashModules([{ path: 'a', code: 'bc' }]))
})

it("loads this computer's profile UI always, and a remote one only for the exact machine, profile and hash", () => {
  expect(uiDecision('local', grant, [])).toBe('load')
  expect(uiDecision('m1', grant, [])).toBe('ask')
  expect(uiDecision('m1', grant, [grant])).toBe('load')
  expect(uiDecision('m1', { ...grant, hash: 'changed' }, [grant])).toBe('ask')
  expect(uiDecision('m2', { ...grant, machine: 'm2' }, [grant])).toBe('ask')
  expect(uiDecision('m1', { ...grant, dir: '/p/other' }, [grant])).toBe('ask')
})

it('keeps allowed profile UIs in a private file, one version per machine and profile', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'superego-ui-trust-'))
  const store = new UiTrust(dir)
  await store.allow(grant)
  await store.allow({ ...grant, hash: 'next' })
  await store.allow({ ...grant, machine: 'm2' })
  expect(store.list()).toEqual([{ ...grant, hash: 'next' }, { ...grant, machine: 'm2' }])
  expect(statSync(join(dir, 'ui-trust.json')).mode & 0o777).toBe(0o600)
  expect(new UiTrust(dir).list()).toEqual(store.list())
  await store.forget({ ...grant, hash: 'next' })
  expect(new UiTrust(dir).list()).toEqual([{ ...grant, machine: 'm2' }])
  expect(JSON.parse(readFileSync(join(dir, 'ui-trust.json'), 'utf8'))).toHaveLength(1)
})
