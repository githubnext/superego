// Everything about which model the agents use and how Superego is signed in to its providers, as settings: the Model and
// Providers sections, the credential store, and signing in to providers (as flows of auth-flows.ts). Nothing else in the
// daemon knows about providers' auth.
import { createHash, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Api, AuthPrompt as PiAuthPrompt, Model, Credential, CredentialStore, ModelThinkingLevel } from '@earendil-works/pi-ai'
import { createAssistantMessageEventStream, defaultProviderAuthContext, fauxAssistantMessage, fauxProvider, type AuthContext, type FauxResponseStep } from '@earendil-works/pi-ai'
import { createModels, getSupportedThinkingLevels, clampThinkingLevel, type Models, type Provider } from '@earendil-works/pi-ai/models'
import { registerBunOAuthFlows } from '@earendil-works/pi-ai/bun-oauth'
import type { ModelRef } from '@earendil-works/pi-durable'
import { createNodePhotonImages } from '@earendil-works/pi-durable/images/node'
import { RpcError, type AgentKindMenu, type AppConfig, type AuthEvent, type CustomProviderInput, type ModelCatalog, type ModelTest, type AuthPrompt, type ProviderAuthInfo, type SettingOption, type SetupProbe } from '@superego/protocol'
import type { SettingsRegistry } from '@superego/settings'
import { appEnv } from './paths.ts'
import { sniff } from './image-kind.ts'
import { createModelImages, type ModelImages } from './model-images.ts'
import { replayProvider, withRecording } from './replay.ts'
import { authFailure, providerWords, Rejections, rejectionSummary, WAITING } from './provider-auth.ts'
import { watchFiles } from './watch-files.ts'
import { wrapStreams } from './provider-streams.ts'
import { withoutSubscriptionAuth, withoutSubscriptionEnv } from './claude-subscription.ts'
import { writeAtomic } from './write-atomic.ts'
import type { AuthFlowEvent, AuthFlows } from './auth-flows.ts'
import { FIRST, RECOMMENDED, recommendedOf } from './recommended.ts'
import { builtins, checkBaseUrl, customProvider, fetchModelIds, idFor, keyOf, keyShape, modelsFile, OAUTH, type CustomProviderConfig } from './providers.ts'

/** A local model server, as setup looks for one: at its usual address, unless told otherwise (tests). */
export type LocalServer = { id: string; name: string; baseUrl: string }
/** Ollama and LM Studio, where they listen by default. */
export const LOCAL_SERVERS: LocalServer[] = [
  { id: 'ollama', name: 'Ollama', baseUrl: 'http://127.0.0.1:11434/v1' },
  { id: 'lmstudio', name: 'LM Studio', baseUrl: 'http://127.0.0.1:1234/v1' },
]
/** How long a local server may take to list its models before setup takes it as not there. */
const LOCAL_TIMEOUT = 1500
/** What a model is asked to prove it works (`model.test`), and how long it may take. */
const SAY_HI = 'Say hi in a few words.'
const TEST_TIMEOUT = 60_000

export type AgentSettingsOptions = {
  /**
   * The user's login shell's environment (login-env.ts), read once: keys the daemon's own environment lacks are taken
   * from it. Unset, only the daemon's own.
   */
  loginEnv?: () => Promise<Record<string, string>>
  /** The local model servers setup looks for (`LOCAL_SERVERS` unset). */
  localServers?: LocalServer[]
}

// pi loads a provider's OAuth flow (to sign in, and to renew a sign-in) with an import() of a path worked out as it runs,
// beside its own file, which a bundle can't follow: the built app has no such file. These are its flows imported
// statically, for it to use instead (pi's hook for bundles; "Bun" only by name). app/test/oauth.sh checks the build.
registerBunOAuthFlows()

/** Providers with a fast mode: OpenAI's priority service tier. */
const FAST = new Set(['openai'])

export const KEYS = { model: 'agent.model', thinking: 'agent.thinking', fast: 'agent.fast', favourites: 'agent.favourites' } as const

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
  /** Resolves once what's queued now has run: the saves going landed. */
  settled() { return this.#serial(async () => {}).catch(() => {}) }
  /** Every credential as stored; none when there's no file. */
  all() { return this.#serial(() => this.#load()) }
  async #load(): Promise<Record<string, Credential>> {
    try { return JSON.parse(await readFile(this.path, 'utf8')) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
      throw error
    }
  }
  #save(all: Record<string, Credential>) { return writeAtomic(this.path, JSON.stringify(all, null, 2)) }
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
  return wrapStreams(provider, (call, model, context, options) => call(model, context, !fast() ? options : {
    ...options,
    async onPayload(payload, model) {
      const body = (await options?.onPayload?.(payload, model)) ?? payload
      return { ...(body as object), service_tier: 'priority' }
    },
  }))
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
  return wrapStreams(provider, (call, model, ...rest) => blocks() !== undefined ? refuse(model) : call(model, ...rest))
}

/** What the scripted model answers to a stored key that starts with "reject": Anthropic's, for a key it doesn't know. */
const REJECTED = '401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}'

/** Tests: the scripted model's rejections of a key starting "reject-held", each held back until it's called. */
export const heldRejections: (() => void)[] = []
/** Tests: each change to auth.json the daemon heard (the providers it changed for), once it has acted on it. */
export const heardCredentials: string[][] = []

/** What the scripted model answers to an image Anthropic would refuse: over 8000 px a side, or a PNG cut short. */
function refusedImage(messages: readonly { content?: unknown }[]) {
  for (const [m, message] of messages.entries()) {
    if (!Array.isArray(message.content)) continue
    for (const [b, block] of (message.content as { type: string; data?: string }[]).entries()) {
      if (block.type !== 'image' || block.data === undefined) continue
      const bytes = Buffer.from(block.data, 'base64')
      const kind = sniff(bytes)
      const problem = kind?.width && kind.height && Math.max(kind.width, kind.height) > 8000 ? 'At least one of the image dimensions exceed max allowed size: 8000 pixels'
        : kind?.mimeType === 'image/png' && bytes.lastIndexOf('IEND') < 0 ? 'Could not process image' : undefined
      if (problem) return `400 {"type":"error","error":{"type":"invalid_request_error","message":"messages.${m}.content.${b}.image.source.base64.data: ${problem}"}}`
    }
  }
  return undefined
}

/**
 * A scripted model that echoes the last user message: tests and demos, with `<ID>_MODEL=faux`. A key stored for it
 * (`faux` in auth.json) that starts with "reject" makes it answer as a provider rejecting the key; an image Anthropic
 * would refuse, it refuses as Anthropic does.
 */
function echoProvider() {
  const faux = fauxProvider()
  const echo: FauxResponseStep = async (context, options) => {
    faux.appendResponses([echo])
    if (options?.apiKey?.startsWith('reject-held')) await new Promise<void>((resolve) => heldRejections.push(resolve))
    if (options?.apiKey?.startsWith('reject')) return fauxAssistantMessage('', { stopReason: 'error', errorMessage: REJECTED })
    const refused = refusedImage(context.messages)
    if (refused) return fauxAssistantMessage('', { stopReason: 'error', errorMessage: refused })
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

/** Other kinds of agent's models, as the model menus last listed them, and whether a model is one (`<kind>/<model>`). */
export type KindModels = { menus(): readonly AgentKindMenu[]; known(model: string): boolean }

export type AgentSettings = {
  models: Models
  /** How images are fitted to the model: every request's (see model-images.ts), and those `read` gives it. */
  images: ModelImages
  /** What a thread runs with now; `model` is absent when no provider is signed in. */
  /**
   * What a turn runs with: the thread's own choices (`override`) where it made them, else this machine's settings.
   * `thinking: 'off'` turns thinking off; a level the model lacks is moved to the nearest it has.
   */
  resolve(override?: { model?: string; thinking?: string }): { model?: ModelRef; thinkingLevel?: ModelThinkingLevel }
  /** The models a thread can choose from here, with their thinking levels, and what a thread gets by default. */
  catalog(): ModelCatalog
  /**
   * Where the other kinds of agent's models are (an extension's: Claude Agent's), which the default may be too: given
   * once the extensions are there (extension-host.ts).
   */
  useKinds(kinds: KindModels): void
  /** The default model when it's another kind of agent's (`<kind>/<model>`): new threads given none start on it. */
  kindDefault(): string | undefined
  /**
   * Sign in to a provider, as a flow of `flows` (auth-flows.ts): its id. `key`: the key a key's sign-in asks for.
   * `check`: a key is tried on one of its models before the flow is done, and the credentials it had before are put
   * back if the provider refuses it. `domain`: GitHub Copilot's GitHub Enterprise domain (`''`: github.com), not asked.
   */
  login(provider: string, type: 'api_key' | 'oauth', emit: (event: AuthEvent) => void, options?: { key?: string; check?: boolean; domain?: string }): string
  /** Ask a model (`provider/model`; the default unset) to say hi, once. */
  test(model?: string): Promise<ModelTest>
  /** What this machine has for running models (`setup.probe`). */
  probe(): Promise<SetupProbe>
  logout(provider: string): Promise<void>
  /**
   * Add an OpenAI-compatible provider, or change one added before (`id`): kept in models.json, its key (when given;
   * `null` takes it away) in auth.json. Without models, those its endpoint lists. Its id.
   */
  saveProvider(input: CustomProviderInput): Promise<string>
  /** Take away a provider added with `saveProvider`, and its key. */
  removeProvider(id: string): Promise<void>
  /** The models an OpenAI-compatible endpoint lists, to add it with (the stored key of `provider`, without `key`). */
  endpointModels(baseUrl: string, key?: string, provider?: string): Promise<string[]>
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
  /** Stop watching auth.json; resolves once the credentials and device id being saved are. */
  close(): Promise<void>
}

export async function createAgentSettings(settings: SettingsRegistry, dataDir: string, app: AppConfig, flows: AuthFlows, options: AgentSettingsOptions = {}): Promise<AgentSettings> {
  const env = appEnv(app)
  const credentials = new FileCredentialStore(join(dataDir, 'auth.json'))
  // The login shell's environment, once read: what a provider looks for that the daemon's own environment hasn't.
  let shellEnv: Record<string, string> = {}
  const base = defaultProviderAuthContext()
  const withLoginEnv: AuthContext = {
    env: async (name) => (await base.env(name)) || shellEnv[name] || undefined,
    fileExists: (path) => base.fileExists(path),
  }
  // No Claude subscription token reaches pi-ai, from the environment or stored (claude-subscription.ts).
  const models = createModels({ credentials, authContext: withoutSubscriptionEnv(withLoginEnv) })
  const credentialListeners = new Set<(provider: string) => void>()
  const rejections = new Rejections(join(dataDir, 'auth-rejected.json'))
  const images = createModelImages(dataDir, await createNodePhotonImages())
  // <ID>_RECORD keeps every answer for replaying later; see replay.ts. Every provider is refused while rejected, and is
  // sent only images its model takes (model-images.ts).
  const record = env('RECORD')
  // The providers being tried (`test`): asked even while rejected, as the trying is what tells.
  const trying = new Map<string, number>()
  const recorded = <T extends Provider>(provider: T) => {
    const blocks = () => !trying.get(provider.id) && rejections.blocks(provider.id) ? rejections.get(provider.id)!.summary : undefined
    return images.wrap(gated(record ? withRecording(provider, record) : provider, blocks))
  }
  /** How each provider takes a key (providers.ts), as worked out when it was set. */
  const shapes = new Map<string, Awaited<ReturnType<typeof keyShape>>>()
  const register = async (provider: Provider) => {
    shapes.set(provider.id, await keyShape(provider.auth.apiKey))
    models.setProvider(recorded(provider))
  }
  for (const provider of builtins()) {
    if (provider.id === 'anthropic') await register(withoutSubscriptionAuth(provider))
    else if (provider.id === 'openai') await register(withServiceTier(provider, () => settings.get<boolean>(KEYS.fast) && FAST.has(chosen()?.provider ?? '')))
    else await register(provider)
  }
  const model = env('MODEL')
  if (model === 'faux') models.setProvider(recorded(echoProvider().provider))
  // A recording to replay: as the default model (<ID>_MODEL=replay:<file>), or offered beside it (<ID>_REPLAY=<file>).
  const replay = model?.startsWith('replay:') ? model.slice('replay:'.length) : env('REPLAY')
  if (replay) models.setProvider(replayProvider(replay, Number(env('REPLAY_SPEED') ?? 120)).provider)

  // The providers the user added (models.json), registered beside the built-in ones; read again when it changes.
  const file = modelsFile(dataDir)
  let custom: Record<string, CustomProviderConfig> = {}
  async function loadCustom() {
    let next: Record<string, CustomProviderConfig>
    try { next = (await file.read()).providers ?? {} } catch (error) {
      // Kept as they were: a file half-edited by hand doesn't take them all away.
      console.error((error as Error).message)
      return
    }
    for (const id of Object.keys(custom)) if (!next[id]) { models.deleteProvider(id); shapes.delete(id) }
    for (const [id, config] of Object.entries(next)) {
      if (shapes.has(id) && !custom[id]) { console.error(`${file.path}: ${id} is a built-in provider's id; left out`); continue }
      try { await register(customProvider(id, config)) } catch (error) { console.error(`${file.path}: ${id}: ${(error as Error).message}`) }
    }
    custom = Object.fromEntries(Object.entries(next).filter(([id]) => models.getProvider(id)))
  }
  await loadCustom()

  /** The providers in the order a default is picked from: the preferred ones first, then the rest by name. */
  const ordered = () => {
    const rank = (id: string) => { const at = FIRST.indexOf(id); return at < 0 ? Infinity : at }
    return [...models.getProviders()].sort((a, b) => rank(a.id) - rank(b.id) || a.name.localeCompare(b.name))
  }
  /** Which providers can be used, refreshed after every sign-in and sign-out; option lists are built from it. */
  let authed = new Map<string, Awaited<ReturnType<Models['checkAuth']>>>()
  /** The models each signed-in provider offers with its sign-in (GitHub Copilot's, say, are the plan's). */
  let available = new Map<string, readonly Model<Api>[]>()
  let stored = new Set<string>()
  async function refreshAuth() {
    const next = new Map<string, Awaited<ReturnType<Models['checkAuth']>>>()
    const offered = new Map<string, readonly Model<Api>[]>()
    await Promise.all(models.getProviders().map(async (provider) => {
      const auth = await models.checkAuth(provider.id).catch((error: Error) => { console.error(`Checking ${provider.name}'s sign-in: ${error.message}`); return undefined })
      next.set(provider.id, auth)
      if (auth) offered.set(provider.id, await models.getAvailable(provider.id).catch(() => models.getModels(provider.id)))
    }))
    authed = next
    available = offered
    stored = new Set((await credentials.list()).map((c) => c.providerId))
    settings.invalidate()
  }
  const usable = (provider: string) => authed.get(provider) ? available.get(provider) ?? [] : []

  const parse = (value: string | null | undefined): ModelRef | undefined => {
    if (!value) return undefined
    const slash = value.indexOf('/')
    return slash < 0 ? undefined : { provider: value.slice(0, slash), modelId: value.slice(slash + 1) }
  }
  /** The sign-in going on for each provider, by its flow's id. */
  const signingIn = new Map<string, string>()
  let kinds: KindModels = { menus: () => [], known: () => false }
  /** The default model set, when it's another kind of agent's. */
  function kindDefault() {
    const set = settings.get<string | null>(KEYS.model)
    return set && kinds.known(set) ? set : undefined
  }
  /** The chosen model; with none chosen, `<ID>_MODEL`, else the preferred model of the first provider signed in. */
  function chosen(): ModelRef | undefined {
    const builtIn = model === 'faux' ? `faux/${models.getModels('faux')[0]?.id}` : model?.startsWith('replay:') ? 'replay/replay' : model
    // Another kind's model is that kind's threads' default: Superego's own threads pick theirs as if none were set.
    const explicit = (kindDefault() ? undefined : parse(settings.get<string | null>(KEYS.model))) ?? parse(builtIn)
    if (explicit) return explicit
    for (const provider of ordered()) {
      const [model] = recommendedOf(provider.id, usable(provider.id))
      if (model) return { provider: provider.id, modelId: model.id }
    }
    return undefined
  }
  const chosenModel = () => { const ref = chosen(); return ref && models.getModel(ref.provider, ref.modelId) }
  const levels = () => { const model = chosenModel(); return model?.reasoning ? getSupportedThinkingLevels(model) : [] }

  /**
   * The favourites as set; until they are, what's in use: the default model, and each signed-in provider's preferred
   * one. Each with its name and provider's, and why it can't be used, if it can't.
   */
  function favourites(): NonNullable<ModelCatalog['favourites']> {
    const ref = chosen()
    const seeded = [...new Set([
      ...(ref ? [`${ref.provider}/${ref.modelId}`] : []),
      ...ordered().filter((provider) => RECOMMENDED[provider.id]).flatMap((provider) => recommendedOf(provider.id, usable(provider.id)).slice(0, 1).map((m) => `${provider.id}/${m.id}`)),
    ])]
    const set = settings.get<string[] | null>(KEYS.favourites)
    return (set ?? seeded).flatMap((value) => {
      const at = parse(value)
      if (!at) return []
      const provider = models.getProvider(at.provider)
      const known = models.getModel(at.provider, at.modelId)
      const label = known?.name ?? at.modelId, group = provider?.name ?? at.provider
      const unavailable = !provider ? `No provider ${at.provider} on this machine`
        : !authed.get(at.provider) ? `${provider.name} isn't signed in`
        : !known ? `${provider.name} has no model ${at.modelId}`
        : !usable(at.provider).some((m) => m.id === at.modelId) ? `Not offered with this ${provider.name} sign-in`
        : undefined
      return [{ value, label, group, ...(unavailable ? { unavailable } : {}) }]
    })
  }

  settings.register({
    id: 'model', title: 'Model', order: 10,
    description: 'What new turns in every thread on this machine run with.',
    settings: [
      {
        key: KEYS.model, title: 'Model', default: null,
        type: () => {
          // The favourites first, then the rest by provider.
          const options: SettingOption[] = []
          const starred = new Set<string>()
          for (const favourite of favourites()) {
            if (favourite.unavailable) continue
            starred.add(favourite.value)
            options.push({ value: favourite.value, label: favourite.label, group: 'Favourites' })
          }
          for (const provider of [...models.getProviders()].sort((a, b) => a.name.localeCompare(b.name))) {
            for (const model of usable(provider.id)) {
              const value = `${provider.id}/${model.id}`
              if (!starred.has(value)) options.push({ value, label: model.name, group: provider.name })
            }
          }
          // Other kinds of agent's (Claude Agent's), a group each: new threads given none start on that kind.
          for (const menu of kinds.menus()) for (const model of menu.models) options.push({ value: model.value, label: model.label, group: menu.title })
          // A choice whose provider was signed out stays visible, so the setting never shows something else.
          const current = settings.get<string | null>(KEYS.model)
          if (current && !options.some((o) => o.value === current)) options.unshift({ value: current, label: `${current} (not signed in)` })
          const auto = chosen()
          return { type: 'choice', options, nullable: true, nullLabel: auto ? `Automatic (${auto.modelId})` : 'Automatic (sign in to a provider)' }
        },
      },
      {
        key: KEYS.thinking, title: 'Thinking', default: 'medium',
        description: 'How much the model reasons before answering. A level the model lacks moves to the nearest it has.',
        type: () => {
          const options: SettingOption[] = levels().map((level) => ({ value: level, label: level }))
          // A level this model lacks still shows, as what it runs with here.
          const current = settings.get<string>(KEYS.thinking), model = chosenModel()
          if (model && options.length && !options.some((o) => o.value === current)) {
            options.unshift({ value: current, label: `${current} (${clampThinkingLevel(model, current as ModelThinkingLevel)} on this model)` })
          }
          return { type: 'choice', options }
        },
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

  // Its own section, drawn by its own component, so the Model section's settings still merge across machines.
  settings.register({
    id: 'model.favourites', title: 'Favourite models', order: 11, ui: 'models',
    description: 'The model menus list these first.',
    data: () => ({ favourites: favourites() }),
    settings: [
      // Starred in the model menus, ordered here (null: not set yet, so seeded; see favourites()).
      { key: KEYS.favourites, title: 'Favourites', default: null, type: { type: 'models' }, hidden: () => true },
    ],
  })

  settings.register({
    id: 'providers', title: 'Providers', order: 20, ui: 'providers',
    description: `Credentials are stored on this machine in ${join(dataDir, 'auth.json')}; providers you add, in ${file.path}.`,
    settings: [],
    data: () => models.getProviders().filter((p) => p.id !== 'faux' && p.id !== 'replay').map((provider): ProviderAuthInfo => {
      const auth = authed.get(provider.id)
      const shape = shapes.get(provider.id)
      const config = custom[provider.id]
      return {
        id: provider.id, name: provider.name, stored: stored.has(provider.id),
        apiKey: Boolean(provider.auth.apiKey?.login),
        ...(provider.auth.apiKey?.login && !shape?.keyOnly ? { keyFlow: true as const } : {}),
        ...(shape?.env.length ? { env: shape.env } : {}),
        ...(provider.auth.oauth && OAUTH.has(provider.id) ? { oauth: provider.auth.oauth.loginLabel ?? 'Sign in' } : {}),
        ...(auth ? { auth: { type: auth.type, ...(auth.source ? { source: auth.source } : {}) } } : {}),
        models: auth ? usable(provider.id).length : models.getModels(provider.id).length,
        ...(config ? { custom: { baseUrl: config.baseUrl, models: config.models.map((m) => m.id) } } : {}),
      }
    }),
  })

  await refreshAuth()
  // Read once, after the daemon is up: a slow shell doesn't hold it back. Signed in from it once it's read.
  const loginEnvRead = options.loginEnv?.().then((read) => { shellEnv = read; return refreshAuth() })
    .catch((error: Error) => console.error(`Reading the login shell's environment: ${error.message}`)) ?? Promise.resolve()

  /** Ask a model to say hi: what it said and how long it took, else what its provider said, as an RpcError. */
  async function tryModel(ref: ModelRef): Promise<ModelTest> {
    const model = models.getModel(ref.provider, ref.modelId)
    const provider = models.getProvider(ref.provider)
    if (!model || !provider) throw new RpcError('invalid', `No model ${ref.provider}/${ref.modelId} here`)
    const started = Date.now()
    trying.set(ref.provider, (trying.get(ref.provider) ?? 0) + 1)
    let answer: Awaited<ReturnType<Models['completeSimple']>>
    try {
      answer = await models.completeSimple(model, { messages: [{ role: 'user', content: SAY_HI, timestamp: started }] }, { maxTokens: 256, signal: AbortSignal.timeout(TEST_TIMEOUT) })
    } catch (error) {
      answer = { ...fauxAssistantMessage('', { stopReason: 'error', errorMessage: (error as Error).message }) } as typeof answer
    } finally {
      trying.set(ref.provider, trying.get(ref.provider)! - 1)
    }
    if (answer.stopReason === 'error' || answer.stopReason === 'aborted') {
      const said = answer.errorMessage ?? (answer.stopReason === 'aborted' ? `No answer in ${TEST_TIMEOUT / 1000}s` : 'It failed without saying why')
      if (authFailure(said)) throw new RpcError('rejected', `${rejectionSummary(provider.name, authed.get(provider.id)?.type, said)}: ${providerWords(said)}`)
      throw new RpcError('model_failed', `${provider.name}: ${providerWords(said)}`)
    }
    const text = answer.content.flatMap((part) => part.type === 'text' ? [part.text] : []).join('').trim()
    return { model: `${ref.provider}/${ref.modelId}`, label: model.name, text, ms: Date.now() - started }
  }
  /** The model a provider is tried on: the default when it's this provider's, else what it'd start on. */
  const testModelOf = (provider: string): ModelRef | undefined => {
    const ref = chosen()
    if (ref?.provider === provider && usable(provider).some((m) => m.id === ref.modelId)) return ref
    const [model] = recommendedOf(provider, usable(provider))
    return model && { provider, modelId: model.id }
  }
  /** Whether the default model can be used now: its provider signed in, and offering it. */
  const works = () => { const ref = chosen(); return Boolean(ref && usable(ref.provider).some((m) => m.id === ref.modelId)) }

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
    heardCredentials.push(changed)
  }
  /** A provider's credentials as stored now (a hash), read at once: what a turn rejected just now ran with. */
  const storedNow = (provider: string) => {
    try { return hashOf((JSON.parse(readFileSync(credentials.path, 'utf8')) as Record<string, Credential>)[provider]) } catch { return '' }
  }
  // auth.json and models.json, whoever writes them: a sign-in here, the CLI, an editor. Their folder, as they're
  // replaced, not written in place.
  let reread: ReturnType<typeof setTimeout> | undefined
  let rereadModels: ReturnType<typeof setTimeout> | undefined
  const watcher = (() => {
    try {
      return watchFiles(dataDir, ['auth.json', 'models.json'], (name) => {
        if (name === 'models.json') {
          clearTimeout(rereadModels)
          rereadModels = setTimeout(() => void loadCustom().then(refreshAuth), 100)
          return
        }
        clearTimeout(reread)
        reread = setTimeout(() => void rereadCredentials(), 100)
      })
    } catch { return undefined }
  })()

  // Some sign-ins identify the installation; it is created once per machine and kept next to the credentials.
  const deviceIdPath = join(dataDir, 'device-id')
  let deviceId = (await readFile(deviceIdPath, 'utf8').catch(() => '')).trim()
  let keepingDeviceId: Promise<void> = Promise.resolve()
  const getDeviceId = () => {
    if (!deviceId) {
      deviceId = randomUUID()
      keepingDeviceId = writeAtomic(deviceIdPath, deviceId).catch((error: Error) => console.error(`Keeping the device id: ${error.message}`))
    }
    return deviceId
  }

  return {
    models, images,
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
      for (const provider of [...models.getProviders()].sort((a, b) => a.name.localeCompare(b.name))) {
        const offered = usable(provider.id)
        const best = new Set(recommendedOf(provider.id, offered).map((m) => m.id))
        for (const model of offered) {
          list.push({
            value: `${provider.id}/${model.id}`, label: model.name, group: provider.name, thinking: model.reasoning ? getSupportedThinkingLevels(model) : [],
            ...(best.has(model.id) ? { recommended: true } : {}),
          })
        }
      }
      const ref = chosen()
      const own = kindDefault() ?? (ref ? `${ref.provider}/${ref.modelId}` : undefined)
      return {
        models: list, favourites: favourites(),
        default: { ...(own ? { model: own } : {}), thinking: settings.get<string | null>(KEYS.thinking) },
      }
    },
    useKinds(given) { kinds = given; settings.invalidate() },
    kindDefault,
    login(provider, type, emit, { key, check, domain } = {}) {
      if (!models.getProviders().some((p) => p.id === provider)) throw new RpcError('unknown_provider', `No provider ${provider}`)
      if (type === 'oauth' && !OAUTH.has(provider)) throw new RpcError('unsupported', `Sign-in is not offered for ${provider}; use an API key`)
      // One sign-in to a provider at a time: an earlier one not finished (its window closed, say) is cancelled, and
      // this one starts once it has let go of what it held (ChatGPT's listens on a fixed port).
      const earlier = signingIn.get(provider)
      if (earlier) flows.cancel(earlier)
      const id = flows.start(emit, async (flow) => {
        if (earlier) await flows.ended(earlier)
        const prompt = ({ signal, ...prompt }: PiAuthPrompt) => {
          if (key !== undefined && type === 'api_key' && prompt.type === 'secret') return Promise.resolve(key)
          // Copilot's one question before its code: which GitHub, when the caller said.
          if (domain !== undefined && provider === 'github-copilot' && prompt.type === 'text') return Promise.resolve(domain)
          return flow.prompt(prompt as AuthPrompt, signal ? { signal } : {})
        }
        const before = check && type === 'api_key' ? await credentials.read(provider) : undefined
        await models.login(provider, type, {
          signal: flow.signal,
          prompt,
          notify: (event) => flow.emit(event.type === 'device_code' ? { type: 'device_code', userCode: event.userCode, verificationUri: event.verificationUri } : event as AuthFlowEvent),
        }, { agentName: app.id, getDeviceId })
        await refreshAuth()
        const trial = check && type === 'api_key' ? testModelOf(provider) : undefined
        if (trial) {
          flow.emit({ type: 'progress', message: `Trying it on ${models.getModel(trial.provider, trial.modelId)?.name ?? trial.modelId}…` })
          try {
            await tryModel(trial)
          } catch (error) {
            // Refused: what was there before is put back. Anything else (the network, a model it can't have) isn't the key's fault.
            if ((error as RpcError).kind !== 'rejected') {
              flow.emit({ type: 'info', message: `Signed in, but the test request failed: ${(error as Error).message}` })
            } else {
              if (before) await credentials.modify(provider, async () => before)
              else await credentials.delete(provider)
              await refreshAuth()
              throw error
            }
          }
        }
        // Signed in again, even with the same key (fixed at the provider, say): what waited on it goes on.
        seen.set(provider, hashOf(await credentials.read(provider).catch(() => undefined)))
        credentialsChanged(provider)
      })
      signingIn.set(provider, id)
      void flows.ended(id).then(() => { if (signingIn.get(provider) === id) signingIn.delete(provider) })
      return id
    },
    test(value) {
      const ref = value ? parse(value) : chosen()
      if (!ref) throw new RpcError('no_model', 'No model is available', { hint: 'Sign in to a provider in Settings.' })
      return tryModel(ref)
    },
    async probe() {
      await loginEnvRead
      const fromEnv: SetupProbe['fromEnv'] = []
      for (const provider of models.getProviders()) {
        const source = authed.get(provider.id)?.source
        if (authed.get(provider.id)?.type !== 'api_key' || !source || !shapes.get(provider.id)?.env.includes(source)) continue
        fromEnv.push({ provider: provider.id, name: provider.name, variable: source, shell: !process.env[source] })
      }
      const same = (a: string, b: string) => a.replace('//localhost:', '//127.0.0.1:').replace(/\/$/, '') === b.replace('//localhost:', '//127.0.0.1:').replace(/\/$/, '')
      const local = (await Promise.all((options.localServers ?? LOCAL_SERVERS).map(async (server) => {
        try {
          const listed = await fetchModelIds(server.baseUrl, undefined, AbortSignal.timeout(LOCAL_TIMEOUT))
          const added = Object.entries(custom).find(([, config]) => same(config.baseUrl, server.baseUrl))?.[0]
          return [{ ...server, models: listed, ...(added ? { provider: added } : {}) }]
        } catch {
          // Nothing listening there, or not answering as OpenAI's API does: not found, which is what setup says.
          return []
        }
      }))).flat()
      return { usable: works() || Boolean(kindDefault()), fromEnv, local }
    },
    async logout(provider) {
      await models.logout(provider)
      await refreshAuth()
    },
    async saveProvider({ id: given, name, baseUrl, key, models: ids }) {
      const id = given ?? idFor(name)
      if (!name.trim()) throw new RpcError('invalid', 'A provider needs a name')
      if (!id) throw new RpcError('invalid', `${name} has no letters or digits to make an id of`)
      if (given ? !custom[given] : models.getProvider(id)) {
        throw new RpcError('invalid', given ? `${given} isn't a provider you added` : `There's a provider ${id} already: give this one another name`)
      }
      const url = checkBaseUrl(baseUrl)
      const typed = [...new Set((ids ?? []).map((m) => m.trim()).filter(Boolean))]
      const listed = typed.length ? typed : await fetchModelIds(url, key ?? keyOf(await credentials.read(id)))
      if (!listed.length) throw new RpcError('invalid', `${url}/models lists no models: type their ids`)
      const before = custom[id]?.models ?? []
      const config: CustomProviderConfig = {
        name: name.trim(), baseUrl: url, api: 'openai-completions',
        // What it said of a model before (by hand, in the file) stays.
        models: listed.map((m) => before.find((b) => b.id === m) ?? { id: m }),
      }
      const all = await file.read()
      await file.write({ ...all, providers: { ...all.providers, [id]: { ...all.providers?.[id], ...config } } })
      if (key) await credentials.modify(id, async () => ({ type: 'api_key', key }))
      else if (key === null) await credentials.delete(id)
      await loadCustom()
      await refreshAuth()
      if (key !== undefined) credentialsChanged(id)
      return id
    },
    async removeProvider(id) {
      if (!custom[id]) throw new RpcError('invalid', `${id} isn't a provider you added`)
      const all = await file.read()
      const { [id]: _gone, ...rest } = all.providers ?? {}
      await file.write({ ...all, providers: rest })
      await credentials.delete(id)
      await loadCustom()
      await refreshAuth()
    },
    async endpointModels(baseUrl, key, provider) {
      return fetchModelIds(baseUrl, key ?? (provider ? keyOf(await credentials.read(provider)) : undefined))
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
    async close() {
      clearTimeout(reread)
      clearTimeout(rereadModels)
      watcher?.close()
      await Promise.all([credentials.settled(), keepingDeviceId, images.settled(), loginEnvRead])
    },
  }
}
