// A profile's UI is let go of only when the profile can't run (gone, broken, no longer allowed), not on errors that
// pass: the machine away, busy with another profile's run, a token not taken yet, an older daemon.
import { beforeEach, expect, it, vi } from 'vitest'
import { RpcError } from '@superego/protocol'
import type { SuperegoBridge } from '../src/shared.ts'
import { ensureProfileUi } from '../src/renderer/profile-ui.ts'

let answer: () => unknown
beforeEach(() => {
  const bridge: Partial<SuperegoBridge> = {
    async call(_machine, method) {
      if (method !== 'profile.ui') throw new Error(`unexpected ${method}`)
      return answer()
    },
  }
  ;(globalThis as { window?: unknown }).window = { superego: bridge }
})

let n = 0
const profile = () => ({ scope: 'user' as const, name: 'p', dir: `/profiles/p${++n}` })

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
