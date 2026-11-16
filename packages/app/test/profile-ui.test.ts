// A profile's UI is let go of only when the profile can't run (gone, broken, no longer allowed), not on errors that
// pass: the machine away, busy with another profile's run, a token not taken yet. Another machine's
// runs only once this computer allowed exactly the sources the window received.
import { beforeEach, expect, it, vi } from 'vitest'
import { RpcError } from '@superego/protocol'
import { collectProfileUi, hashProfileUi, type AllowedUi } from '@superego/client/profile-ui'
import type { SuperegoBridge, SuperegoEvent } from '../src/shared/bridge.ts'
import { declineUi, dismissRevokedUi, ensureProfileUi, loadListedProfileUis, pendingUi, reopenUi, resetProfileUi, revokedUi, setLoader } from '../src/renderer/profile-ui.ts'

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
  for (const kind of ['busy', 'unauthorized', 'disconnected', 'restarting', 'internal', 'timeout']) {
    answer = () => { throw new RpcError(kind, kind) }
    await expect(ensureProfileUi(registry, 'm', p)).rejects.toThrow(kind)
  }
  expect(registry.installProfile).toHaveBeenCalledTimes(1)
  for (const kind of ['not_found', 'invalid', 'profile_not_allowed']) {
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
  expect(revokedUi()).toEqual([])

  // Allowed again, then revoked: what it registered is taken out at once, and, as its code ran here, a reload offered.
  const again = await hashOf(['./ui/a.ts'])
  await allowList([{ machine: 'remote', profile: p, hash: again, files: [], at: 0 }])
  expect(registry.installProfile).toHaveBeenLastCalledWith('remote', p, [expect.anything()])
  await allowList([])
  expect(registry.installProfile).toHaveBeenLastCalledWith('remote', p, [])
  expect(revokedUi()).toEqual([{ machine: 'remote', profile: p }])
  // Later: no longer offered.
  dismissRevokedUi(revokedUi())
  expect(revokedUi()).toEqual([])
  // Allowed again: running, so nothing to reload for; revoked again, offered again.
  await allowList([{ machine: 'remote', profile: p, hash: again, files: [], at: 0 }])
  await allowList([])
  expect(revokedUi()).toHaveLength(1)
  await allowList([{ machine: 'remote', profile: p, hash: again, files: [], at: 0 }])
  expect(revokedUi()).toEqual([])
})

it('offers no reload for UI revoked before it ever ran', async () => {
  const registry = { installProfile: vi.fn() }
  const p = profile()
  files = { 'a.ts': 'code' }
  answer = () => ({ hash: 'v1', entries: ['./a.ts'] })
  await ensureProfileUi(registry, 'remote', p)
  await allowList([])
  expect(registry.installProfile).not.toHaveBeenCalled()
  expect(revokedUi()).toEqual([])
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

it("loads listed threads' profile UIs once per profile; another machine's only if allowed there before", async () => {
  const registry = { installProfile: vi.fn() }
  let asked = 0
  files = { 'ui/a.ts': 'listed code' }
  answer = () => { asked++; return { hash: 'v1', entries: ['./ui/a.ts'] } }
  const [p, q] = [profile(), profile()]
  // Two asking at once for one profile: fetched once.
  await Promise.all([loadListedProfileUis(registry, 'local', [p, q]), loadListedProfileUis(registry, 'local', [p])])
  expect(asked).toBe(2)
  expect(registry.installProfile.mock.calls.map(([m, ref]) => [m, ref.dir]).sort()).toEqual([['local', p.dir], ['local', q.dir]].sort())

  // Another machine's, never allowed here: not even fetched (a thread of it shown asks).
  registry.installProfile.mockClear(); asked = 0
  const r = profile()
  await loadListedProfileUis(registry, 'remote', [r])
  expect(asked).toBe(0)
  expect(pendingUi('remote', r.dir)).toBeUndefined()
  // Allowed before, for these sources: runs at once. For other sources: fetched, and waits to be allowed again.
  const s = profile()
  const hash = await hashOf(['./ui/a.ts'])
  await allowList([{ machine: 'remote', profile: r, hash, files: [], at: 1 }, { machine: 'remote', profile: s, hash: 'old', files: [], at: 1 }])
  await loadListedProfileUis(registry, 'remote', [r, s])
  expect(registry.installProfile).toHaveBeenCalledTimes(1)
  expect(registry.installProfile.mock.calls[0]![1]).toBe(r)
  expect(pendingUi('remote', s.dir)?.hash).toBe(hash)

  // A profile gone from under a listed thread: let be, without a word.
  const error = vi.spyOn(console, 'error').mockImplementation(() => {})
  answer = () => { throw new RpcError('not_found', 'gone') }
  await loadListedProfileUis(registry, 'local', [profile()])
  expect(error).not.toHaveBeenCalled()
  error.mockRestore()
})
