// One session with an MCP server, over the SDK's client: a command run as a process group of its own (stdio, in a
// clean environment), or a URL (Streamable HTTP, SSE when the URL answers as SSE). What it says on stderr and in log
// messages goes to its log, secrets hidden. The runtime (servers.ts) decides when one starts and stops.
import { appendFile, mkdir, readFile, rename, stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { StreamableHTTPClientTransport, StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js'
import { ReadBuffer, serializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import {
  CallToolResultSchema, ListRootsRequestSchema, LoggingMessageNotificationSchema, ToolListChangedNotificationSchema,
  type CallToolResult, type JSONRPCMessage, type Progress, type Tool,
} from '@modelcontextprotocol/sdk/types.js'
import { spawnGroup, type SpawnedGroup } from '@superego/daemon/sdk'
import { redact, type ServerSecrets } from './store.ts'
import type { ServerConfig } from './shared.ts'

// ── Logs ────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** A server's log (`<dataDir>/logs/mcp/<file>.log`): appended to, secrets hidden, rotated at 1 MB keeping one old file. */
export class ServerLog {
  readonly path: string
  #secrets: () => readonly string[]
  #queue: Promise<unknown> = Promise.resolve()
  #limit: number
  constructor(path: string, secrets: () => readonly string[], limit = 1024 * 1024) {
    this.path = path
    this.#secrets = secrets
    this.#limit = limit
  }

  write(line: string) {
    const text = `${new Date().toISOString()} ${redact(line.replace(/\s+$/, ''), this.#secrets())}\n`
    this.#queue = this.#queue.then(async () => {
      await mkdir(dirname(this.path), { recursive: true })
      const size = await stat(this.path).then((s) => s.size, () => 0)
      if (size + text.length > this.#limit) await rename(this.path, `${this.path}.1`).catch(() => {})
      await appendFile(this.path, text)
    }).catch(() => {})
  }

  /** Its last `lines` lines (the old file's too, when this one is short), secrets hidden. */
  async tail(lines: number): Promise<string> {
    await this.#queue
    const read = (path: string) => readFile(path, 'utf8').catch(() => '')
    let all = (await read(this.path)).split('\n').filter(Boolean)
    if (all.length < lines) all = [...(await read(`${this.path}.1`)).split('\n').filter(Boolean), ...all]
    return redact(all.slice(-lines).join('\n'), this.#secrets())
  }
}

// ── stdio, as a process group ───────────────────────────────────────────────────────────────────────────────────────

/** How a command ended: its code or signal, and its last lines on stderr. */
export type Exit = { code: number | null; signal: string | null; stderr: string[]; stopped: boolean; error?: string }

/** The SDK's stdio transport, but the command runs as a process group (`spawnGroup`), so stopping it stops all of it. */
class GroupTransport implements Transport {
  onclose?: () => void
  onerror?: (error: Error) => void
  onmessage?: (message: JSONRPCMessage) => void
  #group?: SpawnedGroup
  #buffer = new ReadBuffer()
  #stderr: string[] = []
  #partial = ''
  exit?: Exit
  command: string
  args: string[]
  options: { cwd: string; env: Record<string, string>; log: ServerLog }
  constructor(command: string, args: string[], options: { cwd: string; env: Record<string, string>; log: ServerLog }) {
    this.command = command
    this.args = args
    this.options = options
  }

  start() {
    return new Promise<void>((resolve, reject) => {
      const group = this.#group = spawnGroup(this.command, this.args, { cwd: this.options.cwd, env: this.options.env, stdio: ['pipe', 'pipe', 'pipe'], grace: 2000 })
      group.child.once('spawn', () => resolve())
      group.child.once('error', (error) => { if (group.child.pid === undefined) reject(error) })
      group.child.stdout!.on('data', (chunk: Buffer) => {
        this.#buffer.append(chunk)
        for (;;) {
          let message: JSONRPCMessage | null
          try { message = this.#buffer.readMessage() } catch (error) {
            this.options.log.write(`not a message on stdout: ${(error as Error).message}`)
            continue
          }
          if (!message) break
          this.onmessage?.(message)
        }
      })
      group.child.stderr!.on('data', (chunk: Buffer) => {
        const lines = (this.#partial + chunk.toString('utf8')).split('\n')
        this.#partial = lines.pop() ?? ''
        for (const line of lines) this.#line(line)
      })
      group.child.stdin!.on('error', (error) => this.onerror?.(error))
      void group.exited.then(({ code, signal, stopped, error }) => {
        if (this.#partial) this.#line(this.#partial)
        this.exit = { code, signal, stopped, stderr: this.#stderr.slice(-10), ...(error ? { error: error.message } : {}) }
        this.onclose?.()
      })
    })
  }

  #line(line: string) {
    if (!line.trim()) return
    this.#stderr.push(line)
    if (this.#stderr.length > 50) this.#stderr.shift()
    this.options.log.write(`stderr: ${line}`)
  }

  send(message: JSONRPCMessage) {
    return new Promise<void>((resolve, reject) => {
      const stdin = this.#group?.child.stdin
      if (!stdin || stdin.destroyed) return reject(new Error('Not connected'))
      if (stdin.write(serializeMessage(message))) resolve()
      else stdin.once('drain', () => resolve())
    })
  }

  async close() { await this.#group?.stop() }

  /** Its process group's leader, while it runs. */
  get pid() { return this.#group?.child.pid }
}

// ── A session ───────────────────────────────────────────────────────────────────────────────────────────────────────

export type Launch = {
  /** For messages and the log. */
  name: string
  config: ServerConfig
  /** Where a command runs. */
  cwd: string
  /** Its secrets' values: `key`, or its env variables'. */
  secrets: ServerSecrets
  /** A thread's own server: the thread's folder, its one root. Shared servers are told of none. */
  root?: string
  log: ServerLog
  /** Lane 3: OAuth for a URL server signing in with it. */
  oauth?: OAuthClientProvider
  /** Its tools changed (`notifications/tools/list_changed`). */
  onToolsChanged?(): void
  /** It closed: a command exited (`exit`), or an HTTP session ended. Not called for `close()`. */
  onClose?(exit: Exit | undefined): void
}

export type Listing = { tools: Tool[]; instructions?: string; server?: { name: string; version?: string } }

const CLIENT = { name: 'superego', version: '1.0.0' }

/** The headers a URL server is sent: its own, and its API key in the header its auth names. */
export function headersOf(config: ServerConfig, secrets: ServerSecrets): Record<string, string> {
  const headers = { ...config.headers }
  if (config.auth?.type === 'api-key' && secrets.key) {
    const header = config.auth.header ?? 'Authorization'
    const scheme = config.auth.scheme ?? (header.toLowerCase() === 'authorization' ? 'Bearer' : '')
    headers[header] = scheme ? `${scheme} ${secrets.key}` : secrets.key
  }
  return headers
}

/** A command's environment: the SDK's safe few (HOME, PATH, SHELL, TERM, USER, LOGNAME), its config's, its secrets. */
export function envOf(config: ServerConfig, secrets: ServerSecrets): Record<string, string> {
  const env: Record<string, string> = { ...getDefaultEnvironment(), ...config.env }
  if (config.auth?.type === 'env') for (const name of config.auth.names) if (secrets[name] !== undefined) env[name] = secrets[name]
  return env
}

/** An HTTP session the server no longer knows (`404` with `Mcp-Session-Id`): set up again once, without telling anyone. */
export const sessionGone = (error: unknown) => error instanceof StreamableHTTPError && error.code === 404

export class Connection {
  readonly client: Client
  readonly launch: Launch
  #transport: Transport
  #closing = false
  closed = false
  /** Calls going on it now. */
  inflight = 0
  /** Replaced (its config changed, or it's stopping): closed once its calls end. */
  retired = false

  private constructor(launch: Launch, client: Client, transport: Transport) {
    this.launch = launch
    this.client = client
    this.#transport = transport
  }

  /** Start it and say hello (`initialize`); throws when it can't. */
  static async open(launch: Launch, signal?: AbortSignal): Promise<Connection> {
    const { config, log } = launch
    const make = () => {
      const client = new Client(CLIENT, { capabilities: launch.root ? { roots: { listChanged: false } } : {} })
      client.setNotificationHandler(LoggingMessageNotificationSchema, ({ params }) => {
        log.write(`${params.level}${params.logger ? ` ${params.logger}` : ''}: ${typeof params.data === 'string' ? params.data : JSON.stringify(params.data)}`)
      })
      client.setNotificationHandler(ToolListChangedNotificationSchema, () => launch.onToolsChanged?.())
      if (launch.root) {
        const root = launch.root
        client.setRequestHandler(ListRootsRequestSchema, () => ({ roots: [{ uri: pathToFileURL(root).href, name: root.split('/').pop() || root }] }))
      }
      return client
    }
    if (config.command) {
      const transport = new GroupTransport(config.command, config.args ?? [], { cwd: launch.cwd, env: envOf(config, launch.secrets), log })
      const client = make()
      const connection = new Connection(launch, client, transport)
      transport.onclose = () => connection.#closed(transport.exit)
      log.write(`starting: ${config.command} ${(config.args ?? []).join(' ')} (in ${launch.cwd})`)
      try {
        await client.connect(transport, { ...(signal ? { signal } : {}) })
      } catch (error) {
        await transport.close().catch(() => {})
        throw connection.#failure(error, transport.exit)
      }
      log.write(`connected (pid ${transport.pid ?? '?'})`)
      return connection
    }
    const url = new URL(config.url!)
    const requestInit = { headers: headersOf(config, launch.secrets) }
    log.write(`connecting: ${url.href}`)
    const streamable = new StreamableHTTPClientTransport(url, { requestInit, ...(launch.oauth ? { authProvider: launch.oauth } : {}) })
    let client = make()
    let connection = new Connection(launch, client, streamable)
    try {
      await client.connect(streamable, { ...(signal ? { signal } : {}) })
    } catch (error) {
      await streamable.close().catch(() => {})
      // An older server speaks SSE: it refuses the POST that Streamable HTTP starts with.
      if (!(error instanceof StreamableHTTPError) || !error.code || error.code < 400 || error.code >= 500 || error.code === 401 || error.code === 403) throw connection.#failure(error)
      log.write(`no Streamable HTTP (${error.code}); trying SSE`)
      const sse = new SSEClientTransport(url, { requestInit, ...(launch.oauth ? { authProvider: launch.oauth } : {}) })
      client = make()
      connection = new Connection(launch, client, sse)
      try {
        await client.connect(sse, { ...(signal ? { signal } : {}) })
      } catch (second) {
        await sse.close().catch(() => {})
        throw connection.#failure(second)
      }
    }
    const opened = connection
    // `connect` set the transport's onclose (through the client): ours goes after it.
    const theirs = opened.#transport.onclose
    opened.#transport.onclose = () => { theirs?.(); opened.#closed(undefined) }
    log.write('connected')
    return opened
  }

  /** What it offers: every page of `tools/list`, and its instructions and name from `initialize`. */
  async list(): Promise<Listing> {
    const tools: Tool[] = []
    let cursor: string | undefined
    do {
      const page = await this.client.listTools(cursor ? { cursor } : {})
      tools.push(...page.tools)
      cursor = page.nextCursor
    } while (cursor && tools.length < 2000)
    const version = this.client.getServerVersion()
    const instructions = this.client.getInstructions()
    return { tools, ...(instructions ? { instructions } : {}), ...(version ? { server: { name: version.name, ...(version.version ? { version: version.version } : {}) } } : {}) }
  }

  /** Call a tool. `timeout`: ms, reset by each progress notification. */
  async call(name: string, args: Record<string, unknown>, options: { signal?: AbortSignal; timeout: number; onprogress?: (progress: Progress) => void }): Promise<CallToolResult> {
    try {
      return await this.client.callTool({ name, arguments: args }, CallToolResultSchema, {
        timeout: options.timeout, resetTimeoutOnProgress: true,
        ...(options.signal ? { signal: options.signal } : {}), ...(options.onprogress ? { onprogress: options.onprogress } : {}),
      }) as CallToolResult
    } catch (error) {
      throw this.#failure(error, (this.#transport as Partial<GroupTransport>).exit)
    }
  }

  /** Stop it: the command's whole group, or the HTTP session (ended with a DELETE where the server keeps sessions). */
  async close() {
    if (this.#closing) return
    this.#closing = true
    this.launch.log.write('stopping')
    const http = this.#transport instanceof StreamableHTTPClientTransport ? this.#transport : undefined
    if (http?.sessionId) await http.terminateSession().catch(() => {})
    await this.client.close().catch(() => {})
    await this.#transport.close().catch(() => {})
    this.closed = true
  }

  #closed(exit: Exit | undefined) {
    if (this.closed) return
    this.closed = true
    if (this.#closing) return
    const how = exit ? (exit.error ?? (exit.signal ? `killed by ${exit.signal}` : `exited with code ${exit.code}`)) : 'the session ended'
    this.launch.log.write(`closed: ${how}`)
    this.launch.onClose?.(exit)
  }

  /** An error as the model and Settings are told it: a command's exit and its last words, an HTTP status. */
  #failure(error: unknown, exit?: Exit): Error {
    const message = error instanceof Error ? error.message : String(error)
    if (exit && !exit.stopped) {
      const how = exit.error ?? (exit.signal ? `was killed by ${exit.signal}` : `exited with code ${exit.code}`)
      const said = exit.stderr.length ? `. Its last words on stderr:\n${exit.stderr.join('\n')}` : ''
      const failure = new Error(redact(`${this.launch.name} ${how}${said}`, Object.values(this.launch.secrets)))
      this.launch.log.write(`failed: ${failure.message.split('\n')[0]}`)
      return Object.assign(failure, { crashed: true })
    }
    if (error instanceof StreamableHTTPError) this.launch.log.write(`HTTP ${error.code ?? '?'}`)
    else this.launch.log.write(`error: ${message}`)
    if (error instanceof Error) {
      error.message = redact(error.message, Object.values(this.launch.secrets))
      return error
    }
    return new Error(redact(message, Object.values(this.launch.secrets)))
  }
}

/** Whether a call's or a start's failure was its command exiting. */
export const crashed = (error: unknown) => Boolean((error as { crashed?: boolean })?.crashed)
