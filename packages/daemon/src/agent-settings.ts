// Everything about which model the agents use and how mu is signed in to its providers, as settings: the Model and
// Providers sections, the credential store, and sign-in flows. Nothing else in the daemon knows about auth.
import { randomUUID } from 'node:crypto'
import { readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AuthPrompt as PiAuthPrompt, Credential, CredentialStore, ModelThinkingLevel } from '@earendil-works/pi-ai'
import { fauxAssistantMessage, fauxProvider, type FauxResponseStep } from '@earendil-works/pi-ai'
import { createModels, getSupportedThinkingLevels, clampThinkingLevel, type Models, type Provider } from '@earendil-works/pi-ai/models'
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic'
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai'
import type { ModelRef } from '@earendil-works/pi-durable'
import { RpcError, type AuthEvent, type AuthPrompt, type ProviderAuthInfo, type SettingOption } from '@mu/protocol'
import type { SettingsRegistry } from '@mu/settings'
import { replayProvider, withRecording } from './replay.ts'

/** The model each provider starts on when it is the first one signed in. */
const PREFERRED: Record<string, string> = { anthropic: 'claude-opus-5-5', openai: 'gpt-6.1-sol' }
/** Providers whose OAuth sign-in mu offers (as tremolo does); the rest use API keys or the environment. */
const OAUTH = new Set(['openai'])
/** Providers with a fast mode: OpenAI's priority service tier. */
const FAST = new Set(['openai'])

export const KEYS = { model: 'agent.model', thinking: 'agent.thinking', fast: 'agent.fast' } as const

/** Credentials in a JSON file only the user can read, shaped like pi's `auth.json`. */
class FileCredentialStore implements CredentialStore {
  readonly path: string
  #queue: Promise<unknown> = Promise.resolve()
  constructor(path: string) { this.path = path }
  read(providerId: string) { return this.#serial(async () => (await this.#load())[providerId]) }
  list() { return this.#serial(async () => Object.entries(await this.#load()).map(([providerId, c]) => ({ providerId, type: c.type }))) }
  modify(providerId: string, fn: (current: Credential | undefined) => Promise<Credential | undefined>) {
    return this.#serial(async () => {
      const all = await this.#load()
      const next = await fn(all[providerId])
      if (!next) return all[providerId]
      all[providerId] = next
      await this.#save(all)
      return next
    })
  }
  delete(providerId: string) {
    return this.#serial(async () => {
      const all = await this.#load()
      delete all[providerId]
      await this.#save(all)
    })
  }
  #serial<T>(task: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(task)
    this.#queue = run.catch(() => {})
    return run
  }
  async #load(): Promise<Record<string, Credential>> {
    try { return JSON.parse(await readFile(this.path, 'utf8')) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
      throw error
    }
  }
  async #save(all: Record<string, Credential>) {
    const temp = `${this.path}.${process.pid}.tmp`
    await writeFile(temp, JSON.stringify(all, null, 2), { mode: 0o600 })
    await rename(temp, this.path)
  }
}

/** `provider`, asking every request for OpenAI's priority tier while `fast()` says so. */
function withServiceTier<T extends Provider>(provider: T, fast: () => boolean): T {
  type Options = { onPayload?: (payload: unknown, model: never) => unknown } | undefined
  const apply = (options: Options): Options => !fast() ? options : {
    ...options,
    async onPayload(payload: unknown, model: never) {
      const body = (await options?.onPayload?.(payload, model)) ?? payload
      return { ...(body as object), service_tier: 'priority' }
    },
  }
  return new Proxy(provider, {
    get(target, key, receiver) {
      if (key === 'stream' || key === 'streamSimple') {
        return (model: never, context: never, options?: Options) => (target[key] as Function).call(target, model, context, apply(options))
      }
      return Reflect.get(target, key, receiver)
    },
  })
}

/** A scripted model that echoes the last user message: tests and demos, with `MU_MODEL=faux`. */
function echoProvider() {
  const faux = fauxProvider()
  const echo: FauxResponseStep = (context) => {
    faux.appendResponses([echo])
    const last = [...context.messages].reverse().find((message) => message.role === 'user')
    const text = typeof last?.content === 'string' ? last.content : last?.content.map((part) => part.type === 'text' ? part.text : '').join('') ?? ''
    return fauxAssistantMessage(`echo: ${text}`)
  }
  faux.setResponses([echo])
  return faux
}

type Flow = { abort: AbortController; prompts: Map<string, { resolve(value: string): void; reject(error: Error): void }> }

export type AgentSettings = {
  models: Models
  /** What a session runs with now; `model` is absent when no provider is signed in. */
  resolve(): { model?: ModelRef; thinkingLevel?: ModelThinkingLevel }
  login(provider: string, type: 'api_key' | 'oauth', key: string | undefined, emit: (event: AuthEvent) => void): string
  respond(flow: string, prompt: string, value: string): void
  cancel(flow: string): void
  logout(provider: string): Promise<void>
  close(): void
}

export async function createAgentSettings(settings: SettingsRegistry, dataDir: string): Promise<AgentSettings> {
  const credentials = new FileCredentialStore(join(dataDir, 'auth.json'))
  const models = createModels({ credentials })
  // MU_RECORD keeps every answer for replaying later; see replay.ts.
  const record = process.env.MU_RECORD
  const recorded = <T extends Provider>(provider: T) => record ? withRecording(provider, record) : provider
  models.setProvider(recorded(anthropicProvider()))
  models.setProvider(recorded(withServiceTier(openaiProvider(), () => settings.get<boolean>(KEYS.fast) && FAST.has(chosen()?.provider ?? ''))))
  const env = process.env.MU_MODEL
  if (env === 'faux') models.setProvider(recorded(echoProvider().provider))
  if (env?.startsWith('replay:')) models.setProvider(replayProvider(env.slice('replay:'.length)).provider)

  /** Which providers can be used, refreshed after every sign-in and sign-out; option lists are built from it. */
  let authed = new Map<string, Awaited<ReturnType<Models['checkAuth']>>>()
  let stored = new Set<string>()
  async function refreshAuth() {
    const next = new Map<string, Awaited<ReturnType<Models['checkAuth']>>>()
    for (const provider of models.getProviders()) next.set(provider.id, await models.checkAuth(provider.id).catch(() => undefined))
    authed = next
    stored = new Set((await credentials.list()).map((c) => c.providerId))
    settings.invalidate()
  }

  const parse = (value: string | null | undefined): ModelRef | undefined => {
    if (!value) return undefined
    const slash = value.indexOf('/')
    return slash < 0 ? undefined : { provider: value.slice(0, slash), modelId: value.slice(slash + 1) }
  }
  /** The chosen model; with none chosen, `MU_MODEL`, else the preferred model of the first provider signed in. */
  function chosen(): ModelRef | undefined {
    const builtIn = env === 'faux' ? `faux/${models.getModels('faux')[0]?.id}` : env?.startsWith('replay:') ? 'replay/replay' : env
    const explicit = parse(settings.get<string | null>(KEYS.model)) ?? parse(builtIn)
    if (explicit) return explicit
    for (const provider of models.getProviders()) {
      if (!authed.get(provider.id)) continue
      const model = models.getModel(provider.id, PREFERRED[provider.id] ?? '') ?? models.getModels(provider.id)[0]
      if (model) return { provider: provider.id, modelId: model.id }
    }
    return undefined
  }
  const chosenModel = () => { const ref = chosen(); return ref && models.getModel(ref.provider, ref.modelId) }
  const levels = () => { const model = chosenModel(); return model?.reasoning ? getSupportedThinkingLevels(model) : [] }

  settings.register({
    id: 'model', title: 'Model', order: 10,
    description: 'What new turns in every session on this machine run with.',
    settings: [
      {
        key: KEYS.model, title: 'Model', default: null,
        type: () => {
          const options: SettingOption[] = []
          for (const provider of models.getProviders()) {
            if (!authed.get(provider.id)) continue
            for (const model of models.getModels(provider.id)) options.push({ value: `${provider.id}/${model.id}`, label: model.name, group: provider.name })
          }
          // A choice whose provider was signed out stays visible, so the setting never shows something else.
          const current = settings.get<string | null>(KEYS.model)
          if (current && !options.some((o) => o.value === current)) options.unshift({ value: current, label: `${current} (not signed in)` })
          const auto = chosen()
          return { type: 'choice', options, nullable: true, nullLabel: auto ? `Automatic (${auto.modelId})` : 'Automatic (sign in to a provider)' }
        },
      },
      {
        key: KEYS.thinking, title: 'Thinking', default: null,
        description: 'How much the model reasons before answering, where it supports a choice.',
        type: () => ({ type: 'choice', nullable: true, nullLabel: 'Model default', options: levels().map((level) => ({ value: level, label: level })) }),
        hidden: () => levels().length === 0,
      },
      {
        key: KEYS.fast, title: 'Fast mode', default: false,
        description: "OpenAI's priority processing: faster replies at a higher price.",
        type: { type: 'boolean' },
        hidden: () => !FAST.has(chosen()?.provider ?? ''),
      },
    ],
  })

  settings.register({
    id: 'providers', title: 'Providers', order: 20, ui: 'providers',
    description: `Credentials are stored on this machine in ${join(dataDir, 'auth.json')}.`,
    settings: [],
    data: () => models.getProviders().filter((p) => p.id !== 'faux' && p.id !== 'replay').map((provider): ProviderAuthInfo => {
      const auth = authed.get(provider.id)
      return {
        id: provider.id, name: provider.name, stored: stored.has(provider.id),
        apiKey: Boolean(provider.auth.apiKey?.login ?? provider.auth.apiKey),
        ...(provider.auth.oauth && OAUTH.has(provider.id) ? { oauth: provider.auth.oauth.loginLabel ?? 'Sign in' } : {}),
        ...(auth ? { auth: { type: auth.type, ...(auth.source ? { source: auth.source } : {}) } } : {}),
        models: models.getModels(provider.id).length,
      }
    }),
  })

  await refreshAuth()

  const flows = new Map<string, Flow>()
  // Some sign-ins identify the installation; it is created once per machine and kept next to the credentials.
  const deviceIdPath = join(dataDir, 'device-id')
  let deviceId = (await readFile(deviceIdPath, 'utf8').catch(() => '')).trim()
  const getDeviceId = () => {
    if (!deviceId) {
      deviceId = randomUUID()
      void writeFile(deviceIdPath, deviceId, { mode: 0o600 })
    }
    return deviceId
  }

  return {
    models,
    resolve() {
      const ref = chosen()
      const model = chosenModel()
      const level = settings.get<ModelThinkingLevel | null>(KEYS.thinking)
      return {
        ...(ref ? { model: ref } : {}),
        ...(model && level && model.reasoning ? { thinkingLevel: clampThinkingLevel(model, level) } : {}),
      }
    },
    login(provider, type, key, emit) {
      if (!models.getProviders().some((p) => p.id === provider)) throw new RpcError('unknown_provider', `No provider ${provider}`)
      if (type === 'oauth' && !OAUTH.has(provider)) throw new RpcError('unsupported', `Sign-in is not offered for ${provider}; use an API key`)
      const id = randomUUID()
      const flow: Flow = { abort: new AbortController(), prompts: new Map() }
      flows.set(id, flow)
      const prompt = (prompt: PiAuthPrompt) => {
        if (key !== undefined && type === 'api_key' && prompt.type === 'secret') return Promise.resolve(key)
        return new Promise<string>((resolve, reject) => {
          const promptId = randomUUID()
          const { signal, ...rest } = prompt
          flow.prompts.set(promptId, { resolve, reject })
          const close = () => {
            if (!flow.prompts.delete(promptId)) return
            reject(new Error('Prompt closed'))
            emit({ type: 'prompt_closed', id: promptId })
          }
          signal?.addEventListener('abort', close, { once: true })
          flow.abort.signal.addEventListener('abort', close, { once: true })
          emit({ type: 'prompt', id: promptId, prompt: rest as AuthPrompt })
        })
      }
      models.login(provider, type, {
        signal: flow.abort.signal,
        prompt,
        notify: (event) => emit(event.type === 'device_code' ? { type: 'device_code', userCode: event.userCode, verificationUri: event.verificationUri } : event as AuthEvent),
      }, { agentName: 'mu', getDeviceId }).then(async () => {
        await refreshAuth()
        emit({ type: 'done' })
      }, (error: unknown) => {
        emit({ type: 'failed', message: flow.abort.signal.aborted ? 'Cancelled' : error instanceof Error ? error.message : String(error) })
      }).finally(() => flows.delete(id))
      return id
    },
    respond(flow, prompt, value) {
      const pending = flows.get(flow)?.prompts.get(prompt)
      if (!pending) throw new RpcError('not_found', 'That sign-in step is no longer waiting')
      flows.get(flow)!.prompts.delete(prompt)
      pending.resolve(value)
    },
    cancel(flow) {
      flows.get(flow)?.abort.abort()
    },
    async logout(provider) {
      await models.logout(provider)
      await refreshAuth()
    },
    close() {
      for (const flow of flows.values()) flow.abort.abort()
    },
  }
}
