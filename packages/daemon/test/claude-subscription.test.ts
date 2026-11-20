// Superego never uses a Claude subscription token (sk-ant-oat…), by any route pi-ai would take one: the environment, a
// key entered in Settings or the CLI, a key or OAuth sign-in stored in auth.json.
import { afterEach, expect, it, vi } from 'vitest'
import type { AuthContext, Credential, CredentialStore } from '@earendil-works/pi-ai'
import { createModels } from '@earendil-works/pi-ai/models'
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic'
import { SUBSCRIPTION_REFUSED, withoutSubscriptionAuth, withoutSubscriptionEnv } from '../src/claude-subscription.ts'

const TOKEN = 'sk-ant-oat01-not-a-real-token'
const KEY = 'sk-ant-api03-not-a-real-key'

afterEach(() => { vi.restoreAllMocks() })

/** A credential store holding `stored`, in memory. */
function store(stored: Record<string, Credential> = {}): CredentialStore {
  return {
    read: async (id) => stored[id],
    list: async () => Object.entries(stored).map(([providerId, c]) => ({ providerId, type: c.type })),
    modify: async (id, fn) => { const next = await fn(stored[id]); if (next) stored[id] = next; return stored[id] },
    delete: async (id) => { delete stored[id] },
  }
}

/** Anthropic as the daemon sets it up, with `env` as the process's environment. */
function anthropic(stored: Record<string, Credential> = {}, env: Record<string, string> = {}) {
  const ambient: AuthContext = { env: async (name) => env[name], fileExists: async () => false }
  const models = createModels({ credentials: store(stored), authContext: withoutSubscriptionEnv(ambient) })
  models.setProvider(withoutSubscriptionAuth(anthropicProvider()))
  return models
}

const quiet = () => { vi.spyOn(console, 'warn').mockImplementation(() => {}); vi.spyOn(console, 'error').mockImplementation(() => {}) }

it('ignores ANTHROPIC_OAUTH_TOKEN, and a subscription token in any other variable', async () => {
  quiet()
  expect(await anthropic({}, { ANTHROPIC_OAUTH_TOKEN: TOKEN }).checkAuth('anthropic')).toBeUndefined()
  expect(await anthropic({}, { ANTHROPIC_API_KEY: TOKEN }).checkAuth('anthropic')).toBeUndefined()
  expect(await anthropic({}, { ANTHROPIC_AUTH_TOKEN: TOKEN }).checkAuth('anthropic')).toBeUndefined()
  // Hidden even when it isn't one: Superego doesn't read that variable at all.
  expect(await anthropic({}, { ANTHROPIC_OAUTH_TOKEN: KEY }).checkAuth('anthropic')).toBeUndefined()
  expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('Ignoring ANTHROPIC_OAUTH_TOKEN'))
})

it('still takes an API key from the environment', async () => {
  const models = anthropic({}, { ANTHROPIC_OAUTH_TOKEN: TOKEN, ANTHROPIC_API_KEY: KEY })
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  expect(await models.checkAuth('anthropic')).toEqual({ type: 'api_key', source: 'ANTHROPIC_API_KEY' })
  expect((await models.getAuth('anthropic'))?.auth.apiKey).toBe(KEY)
})

it('refuses a subscription token entered as an API key, storing nothing', async () => {
  const stored: Record<string, Credential> = {}
  const models = anthropic(stored)
  const interaction = { signal: new AbortController().signal, prompt: async () => TOKEN, notify: () => {} }
  await expect(models.login('anthropic', 'api_key', interaction)).rejects.toThrow(SUBSCRIPTION_REFUSED)
  expect(stored).toEqual({})
  // A real key goes through.
  await models.login('anthropic', 'api_key', { ...interaction, prompt: async () => KEY })
  expect(stored.anthropic).toEqual({ type: 'api_key', key: KEY })
})

it('offers no Claude sign-in', async () => {
  const models = anthropic()
  const interaction = { signal: new AbortController().signal, prompt: async () => '', notify: () => {} }
  await expect(models.login('anthropic', 'oauth', interaction)).rejects.toThrow(/does not support oauth login/)
})

it('never sends a subscription token stored in auth.json, as a key or a sign-in', async () => {
  quiet()
  const asKey = anthropic({ anthropic: { type: 'api_key', key: TOKEN } })
  await expect(asKey.getAuth('anthropic')).rejects.toThrow(/API key auth failed/)
  expect(console.error).toHaveBeenCalledWith(expect.stringContaining(SUBSCRIPTION_REFUSED))
  // A turn fails before any request is made.
  const model = asKey.getModels('anthropic')[0]!
  const fetch = vi.fn()
  const result = await asKey.stream(model, { messages: [{ role: 'user', content: 'hi', timestamp: 0 }] }, { fetch } as never).result()
  expect(result.stopReason).toBe('error')
  expect(fetch).not.toHaveBeenCalled()

  // A Claude sign-in (pi's own auth.json shape) is not used, or renewed.
  const signIn = anthropic({ anthropic: { type: 'oauth', access: TOKEN, refresh: 'r', expires: 0 } })
  expect(await signIn.checkAuth('anthropic')).toBeUndefined()
  expect(await signIn.getAuth('anthropic')).toBeUndefined()
})
