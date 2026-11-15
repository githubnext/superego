// The runtime: which servers there are (the machine's, from mcp-servers.json, and profiles' as their threads come), each
// one's tools as an agent part (installed from the cache when the extension sets up, before interrupted runs resume, and
// replaced as its tools change), and its sessions: one shared, or one per thread (`lifetime: 'thread'`). A session starts
// lazily (a thread's turn starting, a call, a check), stops after 10 idle minutes, is restarted when its config changes
// (once its calls finish), and a server that crashes three times within a minute is `failed` until Restart.
import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { defineExtension, defineTool, type Extension, type ToolExecutionApi, type ToolExecutionResult } from '@earendil-works/pi-durable'
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js'
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js'
import type { DaemonApi, AgentPart } from '@superego/daemon'
import type { ProfileRef } from '@superego/daemon/sdk'
import { RpcError } from '@superego/protocol'
import { configProblem, profileConfig, runKey, runsOf, secretNames } from './config.ts'
import { Connection, ServerLog, sessionGone, type Exit, type Listing } from './connections.ts'
import { contentOf } from './results.ts'
import { DEFAULTS, type CallDetails, type ServerConfig, type ServerInfo, type ServerSource, type ServerState } from './shared.ts'
import { serverKey, type SecretStore, type ServerSecrets } from './store.ts'
import { offerTools, type OfferedTool } from './tools.ts'

type Context = Parameters<ToolExecutionApi['details']>[1]

/** A server's last listing, kept in `<dataDir>/mcp/cache/<file>.json`, so its tools are offered before it runs. */
type Cache = Listing & {
  id: string
  name: string
  listedAt: number
  /** A profile's server: where it's from, and its config as the profile last said it (it was allowed then). */
  from?: Extract<ServerSource, { type: 'profile' }>
  config?: ServerConfig
}

/** Where a session with a server lives, running or starting: the shared one (key ''), or a thread's (its id). */
type Slot = {
  key: string
  thread?: string
  connection?: Connection
  starting?: Promise<Connection>
  lastUsed: number
}

export type Server = {
  id: string
  name: string
  from: ServerSource
  config: ServerConfig
  /** Where a command runs, unless it's a thread's own (then the thread's folder). */
  cwd: string
  /** Its file name under mcp/cache and logs/mcp. */
  file: string
  part: AgentPart
  partName: string
  listing?: Listing & { listedAt: number }
  /** Listed by this daemon: a cached listing is checked again on the first start. */
  listedNow: boolean
  offered: OfferedTool[]
  skipped: { tool: string; why: string }[]
  deferred: boolean
  slots: Map<string, Slot>
  log: ServerLog
  /** Secrets its auth needs that aren't set. */
  missing: string[]
  /** Why its config won't do (a hand-edited file, a profile's server), if it won't. */
  invalid?: string
  /** Refused by the server (401): needs sign-in again, with why. */
  refused?: string
  /** Crashed three times within a minute, or what failed to start: until Restart or a config change. */
  failed?: string
  error?: string
  crashes: number[]
  relisting?: ReturnType<typeof setTimeout>
  /** A listing its `list_changed` asked for, until it's done: a call that saw the change waits for it. */
  listed?: Promise<void>
  /** Settles `listed`, until its listing starts. */
  settleListed?: () => void
}

export type RuntimeOptions = {
  /** How long a session may sit unused before it's stopped, in ms: 10 minutes unless given. */
  idle?: number
  /** How long `agentParts` waits for a server it has never listed, in ms: 4s (the core gives it 5). */
  firstListing?: number
}

const CRASHES = 3
const CRASH_WINDOW = 60_000
const hash = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 8)
const text = (value: string) => [{ type: 'text' as const, text: value }]
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error)
/** The folder that holds a profile's `.superego` (or, for the user's, the data folder): its servers run there. */
export const projectOf = (ref: ProfileRef) => dirname(dirname(dirname(ref.dir)))

export class Runtime {
  readonly servers = new Map<string, Server>()
  /** The servers each thread's last turn had, by thread. */
  readonly selected = new Map<string, string[]>()
  /** Threads with a run going. */
  readonly working = new Set<string>()
  #api: DaemonApi
  #store: SecretStore
  #idle: number
  #firstListing: number
  #changed: () => void
  #cacheDir: string
  #logDir: string

  constructor(api: DaemonApi, store: SecretStore, changed: () => void, options: RuntimeOptions = {}) {
    this.#api = api
    this.#store = store
    this.#changed = changed
    this.#idle = options.idle ?? 10 * 60_000
    this.#firstListing = options.firstListing ?? 4_000
    this.#cacheDir = join(api.dataDir, 'mcp', 'cache')
    this.#logDir = join(api.dataDir, 'logs', 'mcp')
    const sweep = setInterval(() => this.sweep(), Math.min(60_000, Math.max(250, this.#idle / 4)))
    sweep.unref?.()
    api.signal.addEventListener('abort', () => {
      clearInterval(sweep)
      for (const server of this.servers.values()) {
        clearTimeout(server.relisting)
        for (const slot of server.slots.values()) void slot.connection?.close()
      }
    }, { once: true })
  }

  // ── Servers ───────────────────────────────────────────────────────────────────────────────────────────────────────

  /** Profiles' servers seen before, from the cache: their parts installed, so a run that resumes finds its tools. */
  async loadCached() {
    const files = await readdir(this.#cacheDir).catch(() => [] as string[])
    for (const file of files.filter((f) => f.endsWith('.json'))) {
      const cache = await readFile(join(this.#cacheDir, file), 'utf8').then((t) => JSON.parse(t) as Cache, () => undefined)
      if (!cache?.from || !cache.config || this.servers.has(cache.id)) continue
      const ref: ProfileRef = { scope: cache.from.scope, name: cache.from.profile, dir: cache.from.dir }
      await this.profileServer(ref, cache.name, cache.config, cache)
    }
  }

  /** The machine's servers as the file says now: new ones added, changed ones updated, gone ones removed. */
  async syncMachine(servers: Record<string, ServerConfig>) {
    for (const [name, config] of Object.entries(servers)) {
      const existing = this.servers.get(name)
      if (existing) await this.update(existing, config)
      else await this.add(name, { type: 'machine' }, config, config.cwd ? resolve(homedir(), config.cwd) : homedir(), name)
    }
    for (const server of [...this.servers.values()]) {
      if (server.from.type === 'machine' && !(server.name in servers)) await this.remove(server)
    }
  }

  /** A profile's server, as its spec says now: made the first time, updated after. */
  async profileServer(ref: ProfileRef, name: string, given: ServerConfig, cache?: Cache): Promise<Server> {
    const id = `${ref.dir}#${name}`
    const config = profileConfig(given)
    const existing = this.servers.get(id)
    if (existing) { await this.update(existing, config); return existing }
    const project = projectOf(ref)
    const from = { type: 'profile' as const, profile: ref.name, scope: ref.scope, dir: ref.dir, project }
    return this.add(name, from, config, config.cwd ? resolve(project, config.cwd) : project, `${name}@${hash(id)}`, cache)
  }

  async #readCache(file: string): Promise<Cache | undefined> {
    return readFile(join(this.#cacheDir, `${file}.json`), 'utf8').then((t) => JSON.parse(t) as Cache, () => undefined)
  }

  async add(name: string, from: ServerSource, config: ServerConfig, cwd: string, file: string, cached?: Cache): Promise<Server> {
    const id = from.type === 'machine' ? name : `${from.dir}#${name}`
    const cache = cached ?? await this.#readCache(file)
    const partName = from.type === 'machine' ? `mcp:${name}` : `mcp:${file}`
    const server: Server = {
      id, name, from, config, cwd, file, partName,
      part: undefined as unknown as AgentPart,
      ...(cache ? { listing: { tools: cache.tools, ...(cache.instructions ? { instructions: cache.instructions } : {}), ...(cache.server ? { server: cache.server } : {}), listedAt: cache.listedAt } } : {}),
      listedNow: false, offered: [], skipped: [], deferred: false, slots: new Map(), missing: [], crashes: [],
      log: new ServerLog(join(this.#logDir, `${file}.log`), () => this.#store.secrets()),
    }
    const invalid = configProblem(name, config)
    if (invalid) server.invalid = invalid
    this.#offer(server)
    server.part = this.#api.agent(this.#partOf(server), { always: false })
    this.servers.set(id, server)
    server.missing = await this.#missing(server)
    this.#changed()
    return server
  }

  /** A server's config changed: what it runs restarts once its calls finish, and a failure is forgotten. */
  async update(server: Server, config: ServerConfig) {
    const before = runKey(server.config)
    const offered = JSON.stringify([server.config.tools, server.config.title])
    server.config = config
    const invalid = configProblem(server.name, config)
    if (invalid) server.invalid = invalid
    else delete server.invalid
    if (server.from.type === 'machine') server.cwd = config.cwd ? resolve(homedir(), config.cwd) : homedir()
    else server.cwd = config.cwd ? resolve(server.from.project, config.cwd) : server.from.project
    if (runKey(config) !== before) {
      this.#forget(server)
      for (const slot of [...server.slots.values()]) this.#retire(server, slot)
      server.listedNow = false
    }
    if (JSON.stringify([config.tools, config.title]) !== offered) this.#reoffer(server)
    server.missing = await this.#missing(server)
    if (this.#gate(server)) this.stopAll(server)
    this.#changed()
  }

  async remove(server: Server) {
    this.servers.delete(server.id)
    server.part.remove()
    this.stopAll(server)
    clearTimeout(server.relisting)
    await rm(join(this.#cacheDir, `${server.file}.json`), { force: true })
    this.#changed()
  }

  /** The machine's server of that name (a profile's `mcp` names those). */
  machine(name: string) { const server = this.servers.get(name); return server?.from.type === 'machine' ? server : undefined }

  /** Its secrets changed (set, or forgotten). */
  async secretsChanged(server: Server) {
    server.missing = await this.#missing(server)
    delete server.refused
    this.#forget(server)
    for (const slot of [...server.slots.values()]) this.#retire(server, slot)
    this.#changed()
  }

  async #missing(server: Server) {
    const stored = await this.#store.read<ServerSecrets>(serverKey(server.id)) ?? {}
    return secretNames(server.config).filter((name) => !stored[name])
  }

  async secretsOf(server: Server): Promise<ServerSecrets> { return await this.#store.read<ServerSecrets>(serverKey(server.id)) ?? {} }

  // ── State ─────────────────────────────────────────────────────────────────────────────────────────────────────────

  /** Why a server can't be used now, if it can't: off, waiting for Allow, needs sign-in, failed. */
  #gate(server: Server): { state: ServerState; why: string } | undefined {
    const { config, name } = server
    if (server.invalid) return { state: 'failed', why: `${name}'s config won't do: ${server.invalid}` }
    if (config.enabled === false) return { state: 'off', why: `${name} is switched off (Settings → MCP servers)` }
    if (config.allowed === false && config.command) return { state: 'waiting', why: `${name} hasn't been allowed to run yet: the user allows it in Settings → MCP servers` }
    if (server.missing.length) {
      const what = config.auth?.type === 'api-key' ? 'its API key' : `its secret${server.missing.length > 1 ? 's' : ''} ${server.missing.join(', ')}`
      return { state: 'needs-sign-in', why: `${name} needs ${what} set first (Settings → MCP servers → ${name})` }
    }
    if (server.refused) return { state: 'needs-sign-in', why: `${name} needs you to sign in again (Settings → MCP servers): ${server.refused}` }
    if (server.failed) return { state: 'failed', why: `${name} has failed and won't start until it's restarted (Settings → MCP servers): ${server.failed}` }
    return undefined
  }

  stateOf(server: Server): ServerState {
    const gate = this.#gate(server)
    if (gate) return gate.state
    const slots = [...server.slots.values()]
    if (slots.some((s) => s.connection && !s.connection.closed)) return 'running'
    if (slots.some((s) => s.starting)) return 'starting'
    return 'stopped'
  }

  /** Why it can't be used, for the model and the thread. */
  whyNot(server: Server) { return this.#gate(server)?.why }

  async info(server: Server): Promise<ServerInfo> {
    const stored = await this.secretsOf(server)
    const state = this.stateOf(server)
    const error = this.#gate(server)?.why ?? server.error
    const running = [...server.slots.values()].filter((s) => s.thread && s.connection && !s.connection.closed).length
    return {
      id: server.id, name: server.name, from: server.from, runs: runsOf(server.config), config: server.config, state,
      ...(server.config.title ? { title: server.config.title } : {}),
      ...(error && state !== 'running' && state !== 'stopped' ? { error } : server.error ? { error: server.error } : {}),
      ...(server.listing ? { tools: server.offered.length, deferred: server.deferred, listedAt: server.listing.listedAt } : {}),
      ...(server.skipped.length ? { skipped: server.skipped } : {}),
      ...(server.listing?.server ? { server: server.listing.server } : {}),
      ...((server.config.lifetime ?? DEFAULTS.lifetime) === 'thread' ? { running } : {}),
      secrets: secretNames(server.config).map((name) => ({ name, set: Boolean(stored[name]) })),
    }
  }

  // ── Tools ─────────────────────────────────────────────────────────────────────────────────────────────────────────

  #offer(server: Server) {
    const { offered, skipped, deferred } = offerTools(server.name, server.listing?.tools ?? [], server.config)
    server.offered = offered
    server.skipped = skipped
    server.deferred = deferred
  }

  /** Its tools changed (listed again, or its config's `tools`): its part replaced, so the next request offers them. */
  #reoffer(server: Server) {
    this.#offer(server)
    if (this.servers.get(server.id) === server) server.part.replace(this.#partOf(server))
  }

  #partOf(server: Server): Extension {
    return defineExtension({
      name: server.partName,
      tools: server.offered.map((tool) => defineTool({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
        ...(server.deferred ? { deferred: true as const } : {}),
        ...(tool.outputSchema ? { structuredOutputSchema: tool.outputSchema } : {}),
        // Never run again after a restart: its side effects are unknown (readOnlyHint is only a hint).
        replay: 'unsafe',
        execute: (args, api, context) => this.call(server, tool, args as Record<string, unknown>, api, context),
      })),
    })
  }

  /** Call one of a server's tools for a thread: its session started if it isn't, the result made into pi content. */
  async call(server: Server, tool: OfferedTool, args: Record<string, unknown>, api: ToolExecutionApi, context: Context): Promise<ToolExecutionResult> {
    const thread = this.#api.threads.of(api.conversationId)
    const details: CallDetails = {
      server: server.name, tool: tool.tool, ...(tool.title ? { title: tool.title } : {}), ...(server.config.title ? { serverTitle: server.config.title } : {}),
      ...(tool.annotations ? { annotations: tool.annotations } : {}),
    }
    const fail = (message: string): ToolExecutionResult => ({ isError: true, output: text(message), details })
    // The server as it is now: removed, or replaced by another of its name, its calls fail.
    const current = this.servers.get(server.id)
    if (!current) return fail(`${server.name} is no longer set up on this machine.`)
    server = current
    const gate = this.#gate(server)
    if (gate) return fail(gate.why)
    if (server.listing && !server.listing.tools.some((t) => t.name === tool.tool)) return fail(`${server.name} no longer has a tool ${tool.tool}: its tools changed. Look again at what it offers.`)
    const slot = this.#slot(server, thread)
    slot.lastUsed = Date.now()
    const timeout = (server.config.timeout ?? DEFAULTS.timeout) * 1000
    const run = async (connection: Connection) => connection.call(tool.tool, args, {
      timeout, ...(context.abortSignal ? { signal: context.abortSignal } : {}),
      onprogress: (progress) => api.output(`${progress.message ?? 'Progress'}${progress.total ? ` (${progress.progress}/${progress.total})` : progress.progress ? ` (${progress.progress})` : ''}\n`),
    })
    let connection: Connection | undefined
    const use = async () => {
      connection = await this.connect(server, slot)
      connection.inflight++
      try { return await run(connection) } finally { this.#done(connection) }
    }
    try {
      let result
      try {
        result = await use()
      } catch (error) {
        if (!sessionGone(error)) throw error
        // The server forgot the session: set it up again, once.
        server.log.write('session expired; starting another')
        if (slot.connection === connection) this.#retire(server, slot)
        result = await use()
      }
      // Its tools changed while it ran: the listing first, so the next request offers them.
      if (server.listed) await Promise.race([server.listed, new Promise((resolve) => setTimeout(resolve, 5_000))])
      const files = thread ? { dir: this.#api.threads.attachments(thread), call: api.callId } : { dir: join(this.#api.dataDir, 'mcp', 'files'), call: api.callId }
      const { content, saved } = await contentOf(result, files)
      return {
        output: content, details: { ...details, ...(saved.length ? { files: saved } : {}) },
        ...(result.isError ? { isError: true } : {}),
        ...(tool.outputSchema && result.structuredContent && !result.isError ? { structuredOutput: result.structuredContent as never } : {}),
      }
    } catch (error) {
      if (context.abortSignal?.aborted) throw error
      if (this.#refused(server, error)) return fail(this.#gate(server)!.why)
      if (error instanceof McpError && error.code === ErrorCode.RequestTimeout) {
        return fail(`${server.name}.${tool.tool} took over ${timeout / 1000}s without a word of progress, so Superego stopped waiting (and told the server to stop).`)
      }
      return fail(`${server.name}.${tool.tool} failed: ${errorText(error)}`)
    } finally {
      slot.lastUsed = Date.now()
    }
  }

  /** A call on a connection ended: one retired meanwhile is closed once it has none left. */
  #done(connection: Connection) {
    connection.inflight--
    if (connection.retired && !connection.inflight) void connection.close()
  }

  /** A 401: the key or token was refused, so the server needs sign-in. */
  #refused(server: Server, error: unknown) {
    const status = (error as { code?: unknown })?.code
    if (!(error instanceof UnauthorizedError) && !(status === 401 && /HTTP|401|nauthori/i.test(errorText(error)))) return false
    server.refused = server.config.auth?.type === 'api-key' ? 'its API key was refused' : server.config.auth?.type === 'oauth' ? 'it asks for an OAuth sign-in' : 'it asks to be signed in to'
    server.log.write(`refused: ${server.refused}`)
    this.stopAll(server)
    this.#changed()
    return true
  }

  // ── Sessions ──────────────────────────────────────────────────────────────────────────────────────────────────────

  #slot(server: Server, thread: string | undefined): Slot {
    const own = (server.config.lifetime ?? DEFAULTS.lifetime) === 'thread' && thread
    const key = own ? thread : ''
    let slot = server.slots.get(key)
    if (!slot) server.slots.set(key, slot = { key, ...(own ? { thread } : {}), lastUsed: Date.now() })
    return slot
  }

  /** The slot's session, started if it isn't running (once, however many ask). */
  async connect(server: Server, slot: Slot): Promise<Connection> {
    if (slot.connection && !slot.connection.closed) return slot.connection
    if (slot.starting) return slot.starting
    const gate = this.#gate(server)
    if (gate) throw new RpcError('unavailable', gate.why)
    if (!server.slots.has(slot.key)) server.slots.set(slot.key, slot)
    let mine: Connection | undefined
    const starting = slot.starting = (async () => {
      const root = slot.thread ? (await this.#api.threads.get(slot.thread)).cwd : undefined
      const connection = await Connection.open({
        name: server.name, config: server.config, cwd: root ?? server.cwd, secrets: await this.secretsOf(server), log: server.log,
        ...(root ? { root } : {}),
        onToolsChanged: () => this.#relistSoon(server, slot),
        onClose: (exit) => { if (mine) this.#crashed(server, slot, mine, exit) },
      })
      mine = connection
      slot.connection = connection
      slot.lastUsed = Date.now()
      // Its config changed while it started: this one goes once it's used, the next need starts another.
      if (runKey(connection.launch.config) !== runKey(server.config)) this.#retire(server, slot)
      delete server.error
      if (!server.listedNow) await this.#list(server, connection).catch((error) => server.log.write(`listing tools failed: ${errorText(error)}`))
      return connection
    })()
    this.#changed()
    try {
      return await starting
    } catch (error) {
      if (!this.#refused(server, error)) {
        server.error = errorText(error).split('\n')[0]
        this.#count(server, errorText(error))
      }
      throw error
    } finally {
      if (slot.starting === starting) delete slot.starting
      this.#changed()
    }
  }

  async #list(server: Server, connection: Connection) {
    const listing = await connection.list()
    server.listing = { ...listing, listedAt: Date.now() }
    server.listedNow = true
    const cache: Cache = {
      id: server.id, name: server.name, ...listing, listedAt: server.listing.listedAt,
      ...(server.from.type === 'profile' ? { from: server.from, config: server.config } : {}),
    }
    await mkdir(this.#cacheDir, { recursive: true })
    await writeFile(join(this.#cacheDir, `${server.file}.json`), JSON.stringify(cache, null, 2))
    server.log.write(`listed ${listing.tools.length} tool${listing.tools.length === 1 ? '' : 's'}`)
    this.#reoffer(server)
    this.#changed()
  }

  /**
   * Its tools changed: listed again shortly (a burst of changes is one listing), the cache and its part updated. A call
   * that was going when it changed waits for the listing before it answers, so the next request offers the new tools.
   */
  #relistSoon(server: Server, slot: Slot) {
    clearTimeout(server.relisting)
    // One listing for a burst of changes; a call waits for it, and for one already going.
    if (!server.settleListed) {
      const next = new Promise<void>((resolve) => { server.settleListed = resolve })
      server.listed = Promise.all([server.listed, next]).then(() => {})
    }
    const settle = server.settleListed!
    const listed = server.listed!
    server.relisting = setTimeout(() => {
      delete server.settleListed
      const connection = slot.connection
      const listing = connection && !connection.closed ? this.#list(server, connection) : Promise.resolve()
      void listing.catch((error) => server.log.write(`listing tools failed: ${errorText(error)}`)).finally(() => {
        settle()
        if (server.listed === listed) delete server.listed
      })
    }, 20)
  }

  /** A session ended by itself: a crash, counted (three in a minute and it's failed); the next need starts it again. */
  #crashed(server: Server, slot: Slot, connection: Connection, exit: Exit | undefined) {
    if (slot.connection === connection) slot.connection = undefined
    if (!slot.connection && !slot.starting && server.slots.get(slot.key) === slot) server.slots.delete(slot.key)
    const how = exit ? (exit.error ?? (exit.signal ? `killed by ${exit.signal}` : `exited with code ${exit.code}`)) : 'its session ended'
    server.error = `${server.name} ${how}${exit?.stderr.length ? `: ${exit.stderr.at(-1)}` : ''}`
    this.#count(server, server.error)
    this.#changed()
  }

  #count(server: Server, why: string) {
    const now = Date.now()
    server.crashes = [...server.crashes.filter((at) => now - at < CRASH_WINDOW), now]
    if (server.crashes.length >= CRASHES && !server.failed) {
      server.failed = why.split('\n')[0]!
      server.log.write(`failed ${CRASHES} times within a minute: not started again until it's restarted`)
      this.stopAll(server)
    }
  }

  #forget(server: Server) {
    delete server.failed
    delete server.error
    server.crashes = []
  }

  /** Let a slot's session go: closed now when it has no calls going, else once they end. The next need starts another. */
  #retire(server: Server, slot: Slot) {
    const connection = slot.connection
    slot.connection = undefined
    if (server.slots.get(slot.key) === slot && !slot.starting) server.slots.delete(slot.key)
    this.#changed()
    if (!connection) return
    connection.retired = true
    if (!connection.inflight) void connection.close()
  }

  /** Stop a slot's session now, calls and all. */
  async #close(server: Server, slot: Slot) {
    const connection = slot.connection
    slot.connection = undefined
    if (server.slots.get(slot.key) === slot && !slot.starting) server.slots.delete(slot.key)
    this.#changed()
    await connection?.close()
  }

  /** Stop every session of a server now. */
  stopAll(server: Server) {
    for (const slot of [...server.slots.values()]) void this.#close(server, slot)
  }

  /** Stop a thread's own sessions (it was archived). */
  stopThread(thread: string) {
    for (const server of this.servers.values()) {
      const slot = server.slots.get(thread)
      if (slot) this.#retire(server, slot)
    }
  }

  /** Stop what's been idle too long: a shared session no working thread has, a thread's own after its last call. */
  sweep(now = Date.now()) {
    const busy = new Set([...this.working].flatMap((thread) => this.selected.get(thread) ?? []))
    for (const server of this.servers.values()) {
      for (const slot of server.slots.values()) {
        if (!slot.connection || slot.connection.inflight || slot.starting || now - slot.lastUsed < this.#idle) continue
        if (!slot.thread && busy.has(server.id)) continue
        server.log.write('idle: stopping')
        void this.#close(server, slot)
      }
    }
  }

  /** Start a server's session for a thread now, without waiting (its turn started): the first call needn't wait. */
  warm(server: Server, thread: string) {
    if (this.#gate(server)) return
    const slot = this.#slot(server, thread)
    slot.lastUsed = Date.now()
    void this.connect(server, slot).catch(() => {})
  }

  /**
   * Start it to check it and list its tools (added, edited, allowed, its secrets set, restarted), waiting up to `wait`
   * ms; then stopped again if no thread is working with it. A thread's own server is checked in the server's folder.
   */
  async check(server: Server, wait = 30_000) {
    if (this.#gate(server)) return
    const own = (server.config.lifetime ?? DEFAULTS.lifetime) === 'thread'
    const slot: Slot = own ? { key: '\u0000check', lastUsed: Date.now() } : this.#slot(server, undefined)
    server.listedNow = false
    const done = this.connect(server, slot).then(async (connection) => { if (!server.listedNow) await this.#list(server, connection) })
    let timer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([done.catch(() => {}), new Promise((resolve) => { timer = setTimeout(resolve, wait) })])
    clearTimeout(timer)
    const busy = [...this.working].some((thread) => this.selected.get(thread)?.includes(server.id))
    void done.then(() => { if (own || !busy) this.#retire(server, slot) }, () => {})
  }

  /** Restart: every session stopped, a failure forgotten, and started again to check it. */
  async restart(server: Server, wait?: number) {
    this.#forget(server)
    delete server.refused
    for (const slot of [...server.slots.values()]) await this.#close(server, slot)
    await this.check(server, wait)
  }

  /**
   * For `agentParts`: servers a thread has that were never listed get up to `firstListing` ms to start and list their
   * tools, all at once. They're left running for the turn.
   */
  async firstListings(servers: Server[], thread: string) {
    const unlisted = servers.filter((s) => !s.listing && !this.#gate(s))
    if (!unlisted.length) return
    let timer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([
      Promise.all(unlisted.map((s) => this.connect(s, this.#slot(s, thread)).catch(() => {}))),
      new Promise((resolve) => { timer = setTimeout(resolve, this.#firstListing) }),
    ])
    clearTimeout(timer)
  }

  /** Whether a server's tools are found by search (a thread with it gets `tool_search`). */
  isDeferred(server: Server) { return server.deferred && server.offered.length > 0 }
}
