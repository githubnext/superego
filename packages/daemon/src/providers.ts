// Which of pi-ai's providers Superego offers, how each signs in, and the providers the user adds (OpenAI-compatible
// endpoints, kept in <dataDir>/models.json as pi keeps its own). agent-settings.ts registers them; nothing else here
// knows about them.
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ApiKeyAuth, AuthContext, Credential, Model } from '@earendil-works/pi-ai'
import { createProvider, type Provider } from '@earendil-works/pi-ai/models'
import { builtinProviders } from '@earendil-works/pi-ai/providers/all'
import { lazyApi } from '@earendil-works/pi-ai/api/lazy'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import { RpcError } from '@superego/protocol'
import { writeAtomic } from './write-atomic.ts'

/**
 * pi-ai's providers Superego leaves out: OpenAI Codex (legacy) is a second ChatGPT sign-in, through the Codex CLI's
 * client, beside OpenAI's own "Sign in with ChatGPT"; TypeSafe has no chat models.
 */
const LEFT_OUT = new Set(['openai-codex', 'typesafe'])

/**
 * Providers whose OAuth sign-in Superego offers: those meant for apps like it. OpenAI's ChatGPT sign-in registers its
 * own client for agents; OpenRouter's is its sign-in for third-party apps, which mints a key the user controls;
 * GitHub Copilot's device flow, which GitHub's terms leave open to other clients. The rest sign in as another
 * company's own CLI (xAI's Grok CLI, Meta's Muse Code, Kimi's CLI, pi's Radius gateway), so they take API keys only;
 * Anthropic never (claude-subscription.ts).
 */
export const OAUTH = new Set(['openai', 'github-copilot', 'openrouter'])

/** Every built-in provider Superego offers, freshly made, with what each needs to work in the built app. */
export function builtins(): Provider[] {
  return builtinProviders().filter((provider) => !LEFT_OUT.has(provider.id)).map((provider) => {
    if (provider.id === 'amazon-bedrock') return bedrock(provider)
    if (provider.id === 'azure') return azure(provider)
    return provider
  })
}

/**
 * Bedrock, its AWS SDK loaded the first time it's asked something. pi loads it by a path it works out as it runs,
 * which a bundle can't follow (the built app has no such file): here by one it can, as a chunk of its own. Signed in
 * from the environment, it also counts the AWS SDK's own default: a profile in ~/.aws, which pi doesn't look for.
 */
function bedrock(provider: Provider): Provider {
  const streams = lazyApi(() => import('@earendil-works/pi-ai/api/bedrock-converse-stream') as never)
  const apiKey = provider.auth.apiKey!
  return {
    ...provider,
    stream: (model, context, options) => streams.stream(model, context, options),
    streamSimple: (model, context, options) => streams.streamSimple(model, context, options),
    auth: {
      ...provider.auth,
      apiKey: {
        ...apiKey,
        async resolve(input) {
          const found = await apiKey.resolve(input)
          if (found) return found
          for (const file of ['~/.aws/credentials', '~/.aws/config']) {
            if (await input.ctx.fileExists(file)) return { auth: {}, ...(input.credential?.env ? { env: input.credential.env } : {}), source: file }
          }
          return undefined
        },
      },
    },
  }
}

/** Azure, asking for the resource its key is for as it's signed in to: pi reads it only from the environment. */
function azure(provider: Provider): Provider {
  const apiKey = provider.auth.apiKey!
  return {
    ...provider,
    auth: {
      ...provider.auth,
      apiKey: {
        ...apiKey,
        async login(interaction) {
          const key = await interaction.prompt({ type: 'secret', message: 'Enter Azure OpenAI API key' })
          const where = (await interaction.prompt({ type: 'text', message: 'Azure OpenAI resource name, or its base URL', placeholder: 'my-resource' })).trim()
          const env: Record<string, string> = /^https?:\/\//.test(where) ? { AZURE_OPENAI_BASE_URL: where } : { AZURE_OPENAI_RESOURCE_NAME: where }
          return { type: 'api_key', key, env }
        },
      },
    },
  }
}

/**
 * How a provider takes an API key: the environment variables it reads it from (as it asks for them, with nothing
 * set), and whether signing in is just the key, or asks for more (a region, an account, a way to sign in).
 */
export async function keyShape(auth: ApiKeyAuth | undefined): Promise<{ env: string[]; keyOnly: boolean }> {
  if (!auth) return { env: [], keyOnly: false }
  const env: string[] = []
  const ctx: AuthContext = { env: async (name) => { env.push(name); return undefined }, fileExists: async () => false }
  const signal = new AbortController().signal
  // Only asked, never answered: a provider that resolves anyway (a keyless local endpoint) says nothing of its env.
  await auth.resolve({ ctx, signal }).catch(() => undefined)
  let keyOnly = false
  if (auth.login) {
    const asked: string[] = []
    let ended = false
    await auth.login({ signal, notify: () => {}, prompt: async (prompt) => { asked.push(prompt.type); return '' } })
      .then(() => { ended = true }, () => { ended = true })
    keyOnly = ended && asked.length === 1 && asked[0] === 'secret'
  }
  return { env: [...new Set(env)], keyOnly }
}

// --- Providers the user adds -------------------------------------------------------------------------------------

/** A provider the user added, as models.json has it (pi's format: `providers.<id>`). Its key is in auth.json. */
export type CustomProviderConfig = {
  name?: string
  baseUrl: string
  api?: 'openai-completions'
  /** pi's: the key itself, or the environment variable holding it. Superego keeps keys in auth.json instead. */
  apiKey?: string
  models: { id: string; name?: string; reasoning?: boolean; input?: ('text' | 'image')[]; contextWindow?: number; maxTokens?: number }[]
}
export type ModelsFile = { providers?: Record<string, CustomProviderConfig> }

/** A custom provider's id, from its name: lowercase words joined by dashes. */
export const idFor = (name: string) => name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

/** The models.json in `dataDir`: read, and written back whole. */
export function modelsFile(dataDir: string) {
  const path = join(dataDir, 'models.json')
  return {
    path,
    async read(): Promise<ModelsFile> {
      try { return JSON.parse(await readFile(path, 'utf8')) as ModelsFile } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
        throw new Error(`Reading ${path}: ${(error as Error).message}`)
      }
    },
    write: (file: ModelsFile) => writeAtomic(path, `${JSON.stringify(file, null, 2)}\n`),
  }
}

const trimSlash = (url: string) => url.replace(/\/+$/, '')

/** Checks a base URL as the user typed it: an http(s) address. */
export function checkBaseUrl(baseUrl: string): string {
  const url = trimSlash(baseUrl.trim())
  let parsed: URL
  try { parsed = new URL(url) } catch { throw new RpcError('invalid', `${baseUrl} is not a URL`) }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new RpcError('invalid', `${baseUrl} is not an http(s) URL`)
  return url
}

/** The models an OpenAI-compatible endpoint lists at `<baseUrl>/models`, by id. */
export async function fetchModelIds(baseUrl: string, key: string | undefined, signal?: AbortSignal): Promise<string[]> {
  const url = `${checkBaseUrl(baseUrl)}/models`
  let response: Response
  try {
    response = await fetch(url, { headers: key ? { authorization: `Bearer ${key}` } : {}, signal: signal ?? AbortSignal.timeout(10_000) })
  } catch (error) {
    throw new RpcError('unreachable', `Couldn't reach ${url}: ${(error as Error).cause instanceof Error ? ((error as Error).cause as Error).message : (error as Error).message}`)
  }
  if (!response.ok) throw new RpcError('unreachable', `${url} answered ${response.status} ${response.statusText}`.trim())
  const body = await response.json().catch(() => undefined) as { data?: { id?: unknown }[] } | undefined
  if (!Array.isArray(body?.data)) throw new RpcError('unreachable', `${url} didn't list models as OpenAI's API does ({ data: [{ id }] })`)
  return body.data.map((m) => m.id).filter((id): id is string => typeof id === 'string').sort()
}

/** The pi provider for one the user added: OpenAI's chat completions API at its base URL. */
export function customProvider(id: string, config: CustomProviderConfig): Provider {
  const baseUrl = trimSlash(config.baseUrl)
  const models: Model<'openai-completions'>[] = config.models.map((m) => ({
    id: m.id, name: m.name ?? m.id, api: 'openai-completions', provider: id, baseUrl,
    reasoning: m.reasoning ?? false, input: m.input ?? ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: m.contextWindow ?? 128_000, maxTokens: m.maxTokens ?? 16_384,
  }))
  const apiKey: ApiKeyAuth = {
    name: `${config.name ?? id} API key`,
    login: async (interaction) => ({ type: 'api_key', key: await interaction.prompt({ type: 'secret', message: `Enter ${config.name ?? id} API key` }) }),
    async resolve({ ctx, credential }) {
      if (credential?.key) return { auth: { apiKey: credential.key }, source: 'stored credential' }
      if (config.apiKey) {
        const fromEnv = await ctx.env(config.apiKey)
        return { auth: { apiKey: fromEnv ?? config.apiKey }, source: fromEnv ? config.apiKey : 'models.json' }
      }
      // A local server (Ollama, LM Studio) takes no key; OpenAI's client still sends one.
      return { auth: { apiKey: 'none' }, source: 'no key' }
    },
  }
  return createProvider({ id, name: config.name ?? id, baseUrl, auth: { apiKey }, models, api: openAICompletionsApi() })
}

/** A credential's key, if it has one. */
export const keyOf = (credential: Credential | undefined) => credential?.type === 'api_key' ? credential.key : undefined
