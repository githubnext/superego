// Everything about which model the agents use and how Superego is signed in to its providers, as settings: the Model and
// Providers sections, the credential store, and sign-in flows. Nothing else in the daemon knows about auth.
import { createHash, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AuthPrompt as PiAuthPrompt, Credential, CredentialStore, ModelThinkingLevel } from '@earendil-works/pi-ai'
import { createAssistantMessageEventStream, fauxAssistantMessage, fauxProvider, type FauxResponseStep } from '@earendil-works/pi-ai'
import { createModels, getSupportedThinkingLevels, clampThinkingLevel, type Models, type Provider } from '@earendil-works/pi-ai/models'
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic'
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai'
import type { ModelRef } from '@earendil-works/pi-durable'
import { RpcError, type AppConfig, type AuthEvent, type ModelCatalog, type AuthPrompt, type ProviderAuthInfo, type SettingOption } from '@superego/protocol'
import type { SettingsRegistry } from '@superego/settings'
import { appEnv } from './paths.ts'
import { replayProvider, withRecording } from './replay.ts'
import { authFailure, Rejections, rejectionSummary, WAITING } from './provider-auth.ts'
import { watchFiles } from './watch-files.ts'

/** The model each provider starts on when it is the first one signed in. */
const PREFERRED: Record<string, string> = { anthropic: 'claude-opus-5-5', openai: 'gpt-6.1-sol' }
/** Providers whose OAuth sign-in Superego offers (as tremolo does); the rest use API keys or the environment. */
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
      const next = await fn(all[providerId]).catch((error: unknown) => { throw withCause(error) })
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
  /** Every credential as stored; none when there's no file. */
  all() { return this.#serial(() => this.#load()) }
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

/**
 * A failed refresh (run under the store's lock) says only "OAuth refresh failed for <provider>": with the token
 * endpoint's own answer added, a run that fails on it says whether the token was refused or the network failed.
 */
function withCause(error: unknown) {
  if (error instanceof Error && error.cause instanceof Error && /^OAuth refresh failed\b/.test(error.message) && !error.message.includes(': ')) {
    error.message = `${error.message}: ${error.cause.message}`
  }
  return error
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

/**
 * `provider`, answering at once without asking it while `blocks` says its credentials were rejected: the turn fails as
 * an auth failure, so it waits for sign-in like the one that was rejected.
 */
function gated<T extends Provider>(provider: T, blocks: () => string | undefined): T {
  const refuse = (model: { id: string; api: string }) => {
    const stream = createAssistantMessageEventStream()
    const message = { ...fauxAssistantMessage('', { stopReason: 'error', errorMessage: `${WAITING} ${blocks()}` }), api: model.api, provider: provider.id, model: model.id }
    queueMicrotask(() => { stream.push({ type: 'error', reason: 'error', error: message }); stream.end(message) })
    return stream
  }
  return new Proxy(provider, {
    get(target, key, receiver) {
      if (key === 'stream' || key === 'streamSimple') {
        return (model: { id: string; api: string }, ...rest: unknown[]) => blocks() !== undefined ? refuse(model) : (target[key] as Function).call(target, model, ...rest)
      }
      return Reflect.get(target, key, receiver)
    },
  })
}

/** What the scripted model answers to a stored key that starts with "reject": Anthropic's, for a key it doesn't know. */
const REJECTED = '401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}'

/**
 * A scripted model that echoes the last user message: tests and demos, with `<ID>_MODEL=faux`. A key stored for it
 * (`faux` in auth.json) that starts with "reject" makes it answer as a provider rejecting the key.
 */
function echoProvider() {
  const faux = fauxProvider()
  const echo: FauxResponseStep = (context, options) => {
    faux.appendResponses([echo])
    if (options?.apiKey?.startsWith('reject')) return fauxAssistantMessage('', { stopReason: 'error', errorMessage: REJECTED })
    const last = [...context.messages].reverse().find((message) => message.role === 'user')
    const text = typeof last?.content === 'string' ? last.content : last?.content.map((part) => part.type === 'text' ? part.text : '').join('') ?? ''
    return fauxAssistantMessage(`echo: ${text}`)
  }
  faux.setResponses([echo])
  const provider: Provider = {
    ...faux.provider,
    auth: { apiKey: { name: 'Faux', resolve: async ({ credential }) => ({ auth: credential?.key ? { apiKey: credential.key } : {} }) } },
  }
  return { ...faux, provider }
}

type Flow = { abort: AbortController; prompts: Map<string, { resolve(value: string): void; reject(error: Error): void }> }

export type AgentSettings = {
  models: Models
  /** What a thread runs with now; `model` is absent when no provider is signed in. */
  /**
   * What a turn runs with: the thread's own choices (`override`) where it made them, else this machine's settings.
   * `thinking: 'off'` turns thinking off; a level the model lacks is moved to the nearest it has.
   */
  resolve(override?: { model?: string; thinking?: string }): { model?: ModelRef; thinkingLevel?: ModelThinkingLevel }
  /** The models a thread can choose from here, with their thinking levels, and what a thread gets by default. */
  catalog(): ModelCatalog
  login(provider: string, type: 'api_key' | 'oauth', key: string | undefined, emit: (event: AuthEvent) => void): string
  respond(flow: string, prompt: string, value: string): void
  cancel(flow: string): void
  logout(provider: string): Promise<void>
  /** The providers that rejected this machine's credentials, and the threads waiting on them. */
  rejections: Rejections
  /**
   * A run failed: when for its credentials, its thread waits on its provider (`task`, the task it failed in), and it
   * is true. Turns for that provider then fail at once, without asking it, until its credentials change or it's retried.
   * `ranWith` is the credentials the run started with (credentialOf): changed since, it's retried with the new ones.
   */
  rejected(provider: string, thread: string, task: number, error: string | undefined, ranWith?: string): boolean
  /** A provider's credentials as stored now, as a hash: what a run starting now runs with. */
  credentialOf(provider: string): string
  /** Hear a provider's credentials change: stored or removed here, or auth.json edited by hand. */
  onCredentials(listener: (provider: string) => void): () => void
  /** The rejected providers whose credentials changed since (while the daemon was down, say): to retry. */
  changedSinceRejected(): string[]
  close(): void
}

export async function createAgentSettings(settings: SettingsRegistry, dataDir: string, app: AppConfig): Promise<AgentSettings> {
  const env = appEnv(app)
  const credentials = new FileCredentialStore(join(dataDir, 'auth.json'))
  const models = createModels({ credentials })
  const credentialListeners = new Set<(provider: string) => void>()
  const rejections = new Rejections(join(dataDir, 'auth-rejected.json'))
  // <ID>_RECORD keeps every answer for replaying later; see replay.ts. Every provider is refused while rejected.
  const record = env('RECORD')
  const recorded = <T extends Provider>(provider: T) => {
    const blocks = () => rejections.blocks(provider.id) ? rejections.get(provider.id)!.summary : undefined
    return gated(record ? withRecording(provider, record) : provider, blocks)
  }
  models.setProvider(recorded(anthropicProvider()))
  models.setProvider(recorded(withServiceTier(openaiProvider(), () => settings.get<boolean>(KEYS.fast) && FAST.has(chosen()?.provider ?? ''))))
  const model = env('MODEL')
  if (model === 'faux') models.setProvider(recorded(echoProvider().provider))
  // A recording to replay: as the default model (<ID>_MODEL=replay:<file>), or offered beside it (<ID>_REPLAY=<file>).
  const replay = model?.startsWith('replay:') ? model.slice('replay:'.length) : env('REPLAY')
  if (replay) models.setProvider(replayProvider(replay, Number(env('REPLAY_SPEED') ?? 120)).provider)

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
  /** The chosen model; with none chosen, `<ID>_MODEL`, else the preferred model of the first provider signed in. */
  function chosen(): ModelRef | undefined {
    const builtIn = model === 'faux' ? `faux/${models.getModels('faux')[0]?.id}` : model?.startsWith('replay:') ? 'replay/replay' : model
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
    description: 'What new turns in every thread on this machine run with.',
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

  // Each provider's credentials as last seen (a hash), to tell which ones a change to auth.json changed.
  const hashOf = (credential: Credential | undefined) => credential ? createHash('sha256').update(JSON.stringify(credential)).digest('hex').slice(0, 16) : ''
  let seen = new Map(Object.entries(await credentials.all().catch(() => ({}))).map(([id, c]) => [id, hashOf(c)]))
  const credentialsChanged = (provider: string) => { for (const listener of credentialListeners) listener(provider) }
  async function rereadCredentials() {
    const now = new Map(Object.entries(await credentials.all().catch(() => ({}))).map(([id, c]) => [id, hashOf(c)]))
    const changed = [...new Set([...seen.keys(), ...now.keys()])].filter((id) => seen.get(id) !== now.get(id))
    seen = now
    if (!changed.length) return
    await refreshAuth()
    // Not one rejected since the change: the turn that was rejected ran with what's there now (written just before it,
    // and heard of after), so retrying it would only be rejected again, and start another rejection.
    for (const provider of changed) if (rejections.get(provider)?.credential !== (now.get(provider) ?? '')) credentialsChanged(provider)
  }
  /** A provider's credentials as stored now (a hash), read at once: what a turn rejected just now ran with. */
  const storedNow = (provider: string) => {
    try { return hashOf((JSON.parse(readFileSync(credentials.path, 'utf8')) as Record<string, Credential>)[provider]) } catch { return '' }
  }
  // auth.json, whoever writes it: a sign-in here, the CLI, an editor. Its folder, as it's replaced, not written in place.
  let reread: ReturnType<typeof setTimeout> | undefined
  const watcher = (() => {
    try {
      return watchFiles(dataDir, ['auth.json'], () => {
        clearTimeout(reread)
        reread = setTimeout(() => void rereadCredentials(), 100)
      })
    } catch { return undefined }
  })()

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
    resolve(override) {
      const own = parse(override?.model)
      const ownModel = own && models.getModel(own.provider, own.modelId)
      const ref = ownModel ? own : chosen()
      const model = ownModel ?? chosenModel()
      const level = (override?.thinking ?? settings.get<ModelThinkingLevel | null>(KEYS.thinking)) as ModelThinkingLevel | null
      return {
        ...(ref ? { model: ref } : {}),
        ...(model && level && model.reasoning ? { thinkingLevel: clampThinkingLevel(model, level) } : {}),
      }
    },
    catalog() {
      const list: ModelCatalog['models'] = []
      for (const provider of models.getProviders()) {
        if (!authed.get(provider.id)) continue
        for (const model of models.getModels(provider.id)) {
          list.push({ value: `${provider.id}/${model.id}`, label: model.name, group: provider.name, thinking: model.reasoning ? getSupportedThinkingLevels(model) : [] })
        }
      }
      const ref = chosen()
      return { models: list, default: { ...(ref ? { model: `${ref.provider}/${ref.modelId}` } : {}), thinking: settings.get<string | null>(KEYS.thinking) } }
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
      }, { agentName: app.id, getDeviceId }).then(async () => {
        await refreshAuth()
        emit({ type: 'done' })
        // Signed in again, even with the same key (fixed at the provider, say): what waited on it goes on.
        seen.set(provider, hashOf(await credentials.read(provider).catch(() => undefined)))
        credentialsChanged(provider)
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
    rejections,
    rejected(provider, thread, task, error, ranWith) {
      if (!authFailure(error)) return false
      const name = models.getProviders().find((p) => p.id === provider)?.name ?? provider
      // A turn refused here keeps the rejection it was refused for; only the provider's own word starts one.
      const known = rejections.get(provider)
      const detail = error!.startsWith(WAITING) && known ? known.detail : error!
      const now = storedNow(provider)
      rejections.fail(provider, thread, task, { name, summary: rejectionSummary(name, authed.get(provider)?.type, detail), detail, credential: ranWith ?? now })
      // Changed while it ran (and maybe heard of before this): rejected for the ones it had, so it's tried with these.
      if (ranWith !== undefined && ranWith !== now) queueMicrotask(() => credentialsChanged(provider))
      return true
    },
    credentialOf: storedNow,
    changedSinceRejected: () => rejections.all().filter((r) => r.credential !== (seen.get(r.provider) ?? '')).map((r) => r.provider),
    onCredentials(listener) {
      credentialListeners.add(listener)
      return () => { credentialListeners.delete(listener) }
    },
    close() {
      for (const flow of flows.values()) flow.abort.abort()
      clearTimeout(reread)
      watcher?.close()
    },
  }
}
