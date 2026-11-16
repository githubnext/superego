// A machine's servers, kept in `<dataDir>/mcp-servers.json` (no secrets: those are in the store), and what can be said
// of a config without running it: whether it'll do, what it runs in a line, and the secrets it needs.
import { readFile, rename, writeFile } from 'node:fs/promises'
import { RpcError, type Json } from '@superego/protocol'
import { CLIENT_SECRET, SERVER_NAME, type ProfileServers, type ServerConfig, type ServersFile } from './shared.ts'

/** The file, read whole and written whole (atomically), one change at a time. */
export class ConfigFile {
  readonly path: string
  #queue: Promise<unknown> = Promise.resolve()
  constructor(path: string) { this.path = path }

  /** Its servers; none when there's no file. A file that doesn't read throws (it's never overwritten then). */
  async read(): Promise<ServersFile> {
    let text: string
    try { text = await readFile(this.path, 'utf8') } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { servers: {} }
      throw error
    }
    let file: ServersFile
    try { file = JSON.parse(text) as ServersFile } catch (error) {
      // Not the parser's message: it quotes the file, and what's said here reaches Settings and Ego.
      throw new RpcError('invalid', `${this.path} isn't valid JSON${whereIn(text, error)}`)
    }
    if (!file || typeof file !== 'object' || !file.servers || typeof file.servers !== 'object' || Array.isArray(file.servers)) {
      throw new RpcError('invalid', `${this.path} must be { "servers": { … } }`)
    }
    return file
  }

  /** Resolves once the changes going now have finished, their writes landed. */
  async settled() { await this.#queue }

  /** Change it: `edit` gets the servers as they are now and returns them as they should be. */
  modify<T>(edit: (file: ServersFile) => T | Promise<T>): Promise<T> {
    const run = this.#queue.then(async () => {
      const file = await this.read()
      const result = await edit(file)
      const temp = `${this.path}.${process.pid}.tmp`
      await writeFile(temp, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 })
      await rename(temp, this.path)
      return result
    })
    this.#queue = run.catch(() => {})
    return run
  }
}

/** Where in `text` a JSON parse error is, as " (line L, column C)", when the error says its position. */
function whereIn(text: string, error: unknown): string {
  const message = error instanceof Error ? error.message : ''
  const lineColumn = /line (\d+) column (\d+)/.exec(message)
  if (lineColumn) return ` (line ${lineColumn[1]}, column ${lineColumn[2]})`
  const position = /at position (\d+)/.exec(message)
  if (!position) return ''
  const before = text.slice(0, Number(position[1])).split('\n')
  return ` (line ${before.length}, column ${before.at(-1)!.length + 1})`
}

const loopback = (host: string) => host === 'localhost' || host === '[::1]' || host === '::1' || /^127\./.test(host)

/** Why a server's config won't do, if it won't: its name, one of a command or a URL, `https` off loopback, its auth. */
export function configProblem(name: string, config: ServerConfig): string | undefined {
  if (!SERVER_NAME.test(name)) return `${JSON.stringify(name)} isn't a server name: lower-case letters, digits and hyphens, starting with a letter, up to 24`
  if (!config || typeof config !== 'object') return `${name} must be an object`
  const command = typeof config.command === 'string' && config.command.trim() !== ''
  const url = typeof config.url === 'string' && config.url.trim() !== ''
  if (command === url) return `${name} needs one of a command or a URL${command ? ', not both' : ''}`
  if (url) {
    let parsed: URL
    try { parsed = new URL(config.url!) } catch { return `${name}: ${config.url} isn't a URL` }
    if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback(parsed.hostname))) return `${name}: the URL must use https (http only on this computer: localhost, 127.0.0.1)`
    if (config.auth?.type === 'env') return `${name}: secret env vars are for a command; a URL server signs in with an API key or OAuth`
  }
  if (command && config.auth?.type === 'oauth') return `${name}: OAuth is for a URL server; a command takes secret env vars`
  if (config.auth?.type === 'env' && (!Array.isArray(config.auth.names) || !config.auth.names.length)) return `${name}: auth env needs the names of its secret variables`
  if (config.timeout !== undefined && !(config.timeout > 0)) return `${name}: timeout is in seconds, above 0`
  return undefined
}

/** The same, as an error to throw. */
export function checkConfig(name: string, config: ServerConfig) {
  const problem = configProblem(name, config)
  if (problem) throw new RpcError('invalid', problem)
}

/** What a server runs, in a line: the command line, or the URL's host and path. */
export function runsOf(config: ServerConfig): string {
  if (config.command) return [config.command, ...config.args ?? []].map((part) => /[\s"']/.test(part) ? JSON.stringify(part) : part).join(' ')
  try {
    const url = new URL(config.url!)
    return `${url.host}${url.pathname === '/' ? '' : url.pathname.replace(/\/$/, '')}`
  } catch {
    return config.url ?? ''
  }
}

/** The secrets a server's `auth` needs set: `key` for an API key, each variable for env; none for none or OAuth. */
export function secretNames(config: ServerConfig): string[] {
  if (config.auth?.type === 'api-key') return ['key']
  if (config.auth?.type === 'env') return [...config.auth.names]
  return []
}

/** Secrets it may have but doesn't need: `client-secret` for an OAuth client registered by hand (`auth.clientId`). */
export function optionalSecretNames(config: ServerConfig): string[] {
  return config.auth?.type === 'oauth' && config.auth.clientId ? [CLIENT_SECRET] : []
}

/** What makes a server run differently: a change to any of it restarts it. Not its title or how threads use it. */
export function runKey(config: ServerConfig): string {
  const { command, args, cwd, env, url, headers, auth, lifetime } = config
  return JSON.stringify({ command, args, cwd, env, url, headers, auth, lifetime })
}

/** The config, without what a profile's server doesn't have. */
export function profileConfig(config: ServerConfig): ServerConfig {
  const { unprofiled: _u, enabled: _e, allowed: _a, ...rest } = config
  return rest
}

// ── A profile's `mcpServers` ────────────────────────────────────────────────────────────────────────────────────────

/** What a profile's `mcpServers` says: the machine's servers by name, and its own by name (a later one of a name winning). */
export function profileServers(value: ProfileServers | undefined): { names: string[]; own: Record<string, ServerConfig> } {
  const names: string[] = []
  const own: Record<string, ServerConfig> = {}
  for (const item of value ?? []) {
    if (typeof item === 'string') { if (!names.includes(item)) names.push(item) } else Object.assign(own, item)
  }
  return { names: names.filter((name) => !(name in own)), own }
}

/** Why a profile's `mcpServers` won't do, if it won't: a list of server names and objects of servers by name. */
export function profileServersProblem(value: Json): string | undefined {
  if (!Array.isArray(value)) return "mcpServers must be a list: the machine's servers by name, and servers of its own as objects ({ docs: { command: … } })"
  for (const item of value) {
    if (typeof item === 'string') {
      if (!SERVER_NAME.test(item)) return `mcpServers: ${JSON.stringify(item)} isn't a server name: lower-case letters, digits and hyphens, starting with a letter, up to 24`
    } else if (item && typeof item === 'object' && !Array.isArray(item)) {
      for (const [name, config] of Object.entries(item)) {
        if (!config || typeof config !== 'object' || Array.isArray(config)) return `mcpServers: ${name} must be an object`
        const problem = configProblem(name, config as ServerConfig) ?? shapeProblem(name, config as Record<string, Json>)
        if (problem) return `mcpServers: ${problem}`
      }
    } else {
      return `mcpServers: ${JSON.stringify(item)} is neither a server's name nor an object of servers by name`
    }
  }
  return undefined
}

/** What `configProblem` takes for granted of a hand-written config: lists of strings, and objects of strings. */
function shapeProblem(name: string, config: Record<string, Json>): string | undefined {
  if (config.args !== undefined && (!Array.isArray(config.args) || config.args.some((arg) => typeof arg !== 'string'))) return `${name}.args must be a list of strings`
  for (const key of ['env', 'headers']) {
    const map = config[key]
    if (map !== undefined && (!map || typeof map !== 'object' || Array.isArray(map) || Object.values(map).some((v) => typeof v !== 'string'))) return `${name}.${key} must be an object of strings`
  }
  return undefined
}

/** The servers of a profile's `mcpServers` by name, for where profiles are told about: the machine's it names, and its own. */
export const profileServerNames = (value: ProfileServers) => {
  const { names, own } = profileServers(value)
  return [...names, ...Object.keys(own)]
}
