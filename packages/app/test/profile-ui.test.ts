// A profile's UI is let go of only when the profile can't run (gone, broken, no longer allowed), not on errors that
// pass: the machine away, busy with another profile's run, a token not taken yet, an older daemon. Another machine's
// runs only once this computer allowed exactly the sources the window received.
import { beforeEach, expect, it, vi } from 'vitest'
import { RpcError } from '@superego/protocol'
import { collectProfileUi, hashProfileUi, type AllowedUi } from '@superego/client/profile-ui'
import type { SuperegoBridge, SuperegoEvent } from '../src/shared.ts'
import { declineUi, ensureProfileUi, pendingUi, reopenUi, resetProfileUi, setLoader } from '../src/renderer/profile-ui.ts'

let answer: () => unknown
let files: Record<string, string>
let allowed: AllowedUi[]
let declined: AllowedUi[]
let listeners: ((event: SuperegoEvent) => void)[]
beforeEach(() => {
  resetProfileUi()
  files = {}
  allowed = []
  declined = []
  listeners = []
  const bridge: Partial<SuperegoBridge> = {
    async call(machine, method, params) {
      if (machine === 'app' && method === 'profileUi.allowed') return allowed
      if (machine === 'app' && method === 'profileUi.declined') return declined
      if (method === 'profile.ui') return answer()
      if (method === 'profile.module') {
        const path = (params as { path: string }).path.replace(/^\.\//, '')
        if (!(path in files)) throw new RpcError('not_found', path)
        return { path, code: files[path] }
      }
      throw new Error(`unexpected ${method}`)
    },
    onEvent(listener) { listeners.push(listener); return () => {} },
  }
  ;(globalThis as { window?: unknown }).window = { superego: bridge }
  // No DOM to load modules from blob URLs: an extension per entry, named for the code it would run.
  setLoader(async (_profile, sources) => sources.entries.map((entry) => ({ name: sources.modules.get(entry)!.code, setup() {} })))
})

let n = 0
const profile = () => ({ scope: 'user' as const, name: 'p', dir: `/profiles/p${++n}` })
/** The app's allowed list changing, as it tells every window; and the window settling to it. */
const allowList = async (list: AllowedUi[]) => {
  allowed = list
  for (const listener of listeners) listener({ machine: 'app', method: 'profileUi.allowed', params: list })
  await new Promise((resolve) => setTimeout(resolve, 10))
}
const hashOf = async (entries: string[]) => hashProfileUi(await collectProfileUi(entries, async (path) => ({ path: path.replace(/^\.\//, ''), code: files[path.replace(/^\.\//, '')]! })))

it('keeps the UI through errors that pass, and lets go of it once the profile is gone', async () => {
  const registry = { installProfile: vi.fn() }
  const p = profile()
  answer = () => ({ hash: 'h1', entries: [] })
  await ensureProfileUi(registry, 'm', p)
  expect(registry.installProfile).toHaveBeenCalledTimes(1)
  // The same version again installs nothing.
  await ensureProfileUi(registry, 'm', p)
  expect(registry.installProfile).toHaveBeenCalledTimes(1)
  for (const kind of ['busy', 'unauthorized', 'disconnected', 'restarting', 'unknown_method', 'internal', 'timeout']) {
    answer = () => { throw new RpcError(kind, kind) }
    await expect(ensureProfileUi(registry, 'm', p)).rejects.toThrow(kind)
  }
  expect(registry.installProfile).toHaveBeenCalledTimes(1)
  for (const kind of ['not_found', 'invalid', 'untrusted_profile']) {
    const q = profile()
    answer = () => ({ hash: 'h1', entries: [] })
    await ensureProfileUi(registry, 'm', q)
    registry.installProfile.mockClear()
    answer = () => { throw new RpcError(kind, kind) }
    await expect(ensureProfileUi(registry, 'm', q)).rejects.toThrow(kind)
    expect(registry.installProfile).toHaveBeenCalledWith('m', q, [])
  }
})

it("runs this computer's profile UI on its daemon's say", async () => {
  const registry = { installProfile: vi.fn() }
  const p = profile()
  files = { 'ui/a.ts': 'local code' }
  answer = () => ({ hash: 'v1', entries: ['./ui/a.ts'] })
  await ensureProfileUi(registry, 'local', p)
  expect(registry.installProfile).toHaveBeenCalledWith('local', p, [expect.objectContaining({ name: 'local code' })])
  expect(pendingUi('local', p.dir)).toBeUndefined()
})

it("runs another machine's profile UI only once allowed here, for exactly those sources", async () => {
  const registry = { installProfile: vi.fn() }
  const p = profile()
  files = { 'ui/a.ts': `import { b } from '../b.ts'`, 'b.ts': 'export const b = 1' }
  answer = () => ({ hash: 'v1', entries: ['./ui/a.ts'] })
  // Not allowed: nothing runs, and it waits for a say, with what it is.
  await ensureProfileUi(registry, 'remote', p)
  expect(registry.installProfile).not.toHaveBeenCalled()
  const pending = pendingUi('remote', p.dir)!
  expect(pending.files.map((f) => f.path)).toEqual(['b.ts', 'ui/a.ts'])
  expect(pending.code('b.ts')).toBe('export const b = 1')
  const hash = await hashOf(['./ui/a.ts'])
  expect(pending.hash).toBe(hash)

  // A hash the machine reports means nothing: allowing another hash runs nothing.
  await allowList([{ machine: 'remote', profile: p, hash: 'v1', files: [], at: 0 }])
  expect(registry.installProfile).not.toHaveBeenCalled()
  // Allowed for what the window received (on another machine's say, too: no).
  await allowList([{ machine: 'other', profile: p, hash, files: [], at: 0 }])
  expect(registry.installProfile).not.toHaveBeenCalled()
  await allowList([{ machine: 'remote', profile: p, hash, files: [], at: 0 }])
  expect(registry.installProfile).toHaveBeenLastCalledWith('remote', p, [expect.objectContaining({ name: files['ui/a.ts'] })])
  expect(pendingUi('remote', p.dir)).toBeUndefined()

  // A source changes there: it stops running, and waits for a say again.
  registry.installProfile.mockClear()
  files['b.ts'] = 'export const b = 2'
  answer = () => ({ hash: 'v2', entries: ['./ui/a.ts'] })
  await ensureProfileUi(registry, 'remote', p)
  expect(registry.installProfile).toHaveBeenCalledWith('remote', p, [])
  expect(pendingUi('remote', p.dir)?.hash).not.toBe(hash)

  // Allowed again, then revoked: it stops at once.
  await allowList([{ machine: 'remote', profile: p, hash: await hashOf(['./ui/a.ts']), files: [], at: 0 }])
  expect(registry.installProfile).toHaveBeenLastCalledWith('remote', p, [expect.anything()])
  await allowList([])
  expect(registry.installProfile).toHaveBeenLastCalledWith('remote', p, [])
})

it('allowed already: runs at once, without asking', async () => {
  const registry = { installProfile: vi.fn() }
  const p = profile()
  files = { 'a.ts': 'code' }
  allowed = [{ machine: 'remote', profile: p, hash: await hashOf(['./a.ts']), files: [], at: 0 }]
  answer = () => ({ hash: 'v1', entries: ['./a.ts'] })
  await ensureProfileUi(registry, 'remote', p)
  expect(registry.installProfile).toHaveBeenCalledWith('remote', p, [expect.objectContaining({ name: 'code' })])
})

it('remembers "Not now" for those sources: asks again when they change, when revoked, or from the header', async () => {
  const registry = { installProfile: vi.fn() }
  const p = profile()
  files = { 'a.ts': 'code' }
  const hash = await hashOf(['./a.ts'])
  // Put off on this computer before (in another window, or before a restart): not asked again.
  declined = [{ machine: 'remote', profile: p, hash, files: [], at: 0 }]
  answer = () => ({ hash: 'v1', entries: ['./a.ts'] })
  await ensureProfileUi(registry, 'remote', p)
  expect(registry.installProfile).not.toHaveBeenCalled()
  expect(pendingUi('remote', p.dir)).toMatchObject({ hash, declined: true })
  // The header's marker asks again, in this window; Not now puts it off again.
  reopenUi(pendingUi('remote', p.dir)!, true)
  expect(pendingUi('remote', p.dir)?.declined).toBe(false)
  declineUi(pendingUi('remote', p.dir)!)
  expect(pendingUi('remote', p.dir)?.declined).toBe(true)

  // Revoked (the app clears it): asked again.
  for (const listener of listeners) listener({ machine: 'app', method: 'profileUi.declined', params: [] })
  expect(pendingUi('remote', p.dir)?.declined).toBe(false)

  // Put off again, then the sources change there: asked about the new ones.
  declineUi(pendingUi('remote', p.dir)!)
  files['a.ts'] = 'changed'
  answer = () => ({ hash: 'v2', entries: ['./a.ts'] })
  await ensureProfileUi(registry, 'remote', p)
  expect(pendingUi('remote', p.dir)).toMatchObject({ hash: await hashOf(['./a.ts']), declined: false })
})
