// The models setup starts each provider on, picked by hand: each one in pi's catalogue, so a list can't go stale
// unnoticed (a renamed model would quietly start the provider on its first one by name instead).
import { expect, it } from 'vitest'
import { builtins } from '../src/providers.ts'
import { FIRST, RECOMMENDED } from '../src/recommended.ts'

it("lists only providers and models pi's catalogue has", () => {
  const providers = builtins()
  const missing = Object.entries(RECOMMENDED).flatMap(([id, models]) => {
    const provider = providers.find((p) => p.id === id)
    if (!provider) return [`${id} (no such provider)`]
    const known = new Set(provider.getModels().map((m) => m.id))
    return models.filter((model) => !known.has(model)).map((model) => `${id}/${model}`)
  })
  expect(missing).toEqual([])
  for (const id of FIRST) expect(providers.some((p) => p.id === id)).toBe(true)
})
