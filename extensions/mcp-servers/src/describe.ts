// What the UI half says of servers and calls, in words: a server's state and command line, a name for a new one, and
// whose tool a call is. Plain functions, apart from React, so they're tested as such.
import { SERVER_NAME, TOOL_PREFIX, type ServerConfig, type ServerInfo, type ServerState } from './shared.ts'

/** An argument as a shell would need it: bare when it can be, else in single quotes. */
export const quote = (arg: string) => /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`

/**
 * A command's whole line, as Allow shows it: its plain env, the command and its arguments, and where it runs. What's
 * allowed is all of it, so nothing is cut.
 */
export function commandLine(config: Pick<ServerConfig, 'command' | 'args' | 'env' | 'cwd'>): string {
  if (!config.command) return ''
  const env = Object.entries(config.env ?? {}).map(([name, value]) => `${name}=${quote(value)}`)
  const line = [...env, quote(config.command), ...(config.args ?? []).map(quote)].join(' ')
  return config.cwd ? `cd ${quote(config.cwd)} && ${line}` : line
}

/** A command line typed into one field, split as a shell would: quotes keep spaces, a backslash escapes. */
export function splitCommandLine(line: string): string[] {
  const words: string[] = []
  let word: string | undefined
  let quoted: '"' | "'" | undefined
  const add = (text: string) => { word = (word ?? '') + text }
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!
    if (quoted) {
      if (c === quoted) quoted = undefined
      else if (c === '\\' && quoted === '"' && i + 1 < line.length) add(line[++i]!)
      else add(c)
    } else if (c === '"' || c === "'") { quoted = c; add('') }
    else if (c === '\\' && i + 1 < line.length) add(line[++i]!)
    else if (/\s/.test(c)) { if (word !== undefined) words.push(word); word = undefined }
    else add(c)
  }
  if (word !== undefined) words.push(word)
  return words
}

/** Words in a host or a package's name that say nothing of what the server is. */
const NOISE = new Set(['mcp', 'server', 'api', 'www', 'app', 'com', 'io', 'dev', 'net', 'org', 'ai', 'co', 'sh', 'cloud', 'v1', 'sse', 'localhost'])
/** Commands that run a package: its name is the first argument that isn't a flag. */
const RUNNERS = new Set(['npx', 'bunx', 'uvx', 'pnpx', 'pipx', 'deno', 'docker'])

/** A name made to fit: lower case, hyphens, starting with a letter, up to 24 characters; none when nothing's left. */
export function fitName(text: string): string | undefined {
  const name = text.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^[^a-z]+/, '').replace(/-+/g, '-').slice(0, 24).replace(/-+$/, '')
  return SERVER_NAME.test(name) ? name : undefined
}

/** A name for a server not named yet, from its URL's host or the package its command runs: `mcp.linear.app` → linear. */
export function nameFrom({ command, args = [], url }: { command?: string; args?: string[]; url?: string }): string | undefined {
  if (url) {
    let host: string
    try { host = new URL(url).hostname } catch { return undefined }
    if (/^[\d.]+$|^\[/.test(host)) return undefined
    const label = host.split('.').find((part) => !NOISE.has(part))
    return label ? fitName(label) : undefined
  }
  if (!command) return undefined
  const base = command.split('/').pop()!
  const named = RUNNERS.has(base) || base === 'pnpm' || base === 'yarn' ? args.find((a) => !a.startsWith('-') && a !== 'dlx' && a !== 'run' && a !== 'x') : args.find((a) => !a.startsWith('-')) ?? base
  if (!named) return undefined
  // `@scope/mcp-server@1.2` → its scope, when the rest says nothing; `chrome-devtools-mcp@latest` → chrome-devtools;
  // `./tools/docs-mcp.js` → docs.
  const [, scope, rest = named] = /^(?:@([^/@]+)\/)?([^@]+)(?:@.*)?$/.exec(named) ?? []
  const file = rest.split('/').pop()!.replace(/\.(m?[jt]s|cjs|py)$/, '')
  const kept = file.split(/[-_.]/).filter((part) => part && !NOISE.has(part.toLowerCase())).join('-')
  return fitName(kept || scope || '')
}

/** Its state, in words: "Running · 23 tools". */
export function stateText(server: Pick<ServerInfo, 'state' | 'tools' | 'deferred' | 'running' | 'config'>): string {
  const tools = server.tools !== undefined ? `${server.tools} ${server.tools === 1 ? 'tool' : 'tools'}${server.deferred ? ', found by search' : ''}` : undefined
  switch (server.state) {
    case 'off': return 'Off'
    case 'waiting': return 'Waiting for Allow'
    case 'starting': return 'Starting…'
    case 'needs-sign-in': return 'Needs sign-in'
    case 'failed': return 'Failed'
    case 'stopped': return ['Stopped', tools].filter(Boolean).join(' · ')
    case 'running': {
      const where = server.config.lifetime === 'thread' ? server.running ? `Running in ${server.running} ${server.running === 1 ? 'thread' : 'threads'}` : 'Per thread' : 'Running'
      return [where, tools].filter(Boolean).join(' · ')
    }
  }
}

/** The status dot a state is drawn with (the app's `superego-status--*`). */
export const DOT: Record<ServerState, string> = {
  off: 'off', stopped: 'idle', starting: 'working', running: 'done', 'needs-sign-in': 'blocked', waiting: 'blocked', failed: 'error',
}

/** Whether a server needs the user before it can run: OAuth to sign in to, or a key or secret env value to set. */
export function needs(server: Pick<ServerInfo, 'state' | 'config' | 'secrets'>): 'sign-in' | 'key' | undefined {
  if (server.state !== 'needs-sign-in') return undefined
  return server.config.auth?.type === 'oauth' ? 'sign-in' : 'key'
}

/** A call's server and tool, from its name (`mcp__linear__create_issue`), until its result says them exactly. */
export function toolOf(name: string): { server: string; tool: string } {
  const rest = name.startsWith(TOOL_PREFIX) ? name.slice(TOOL_PREFIX.length) : name
  const at = rest.indexOf('__')
  return at < 0 ? { server: rest, tool: '' } : { server: rest.slice(0, at), tool: rest.slice(at + 2) }
}

/** Arguments that say what a call is about, when it has one: its title, name or query, before the rest. */
const ABOUT = ['title', 'name', 'query', 'q', 'search', 'subject', 'url', 'path', 'id']

/** What a call is about, in a line: a short, one-line string among its arguments, a title or query first. */
export function firstShortString(args: Record<string, unknown>): string | undefined {
  const short = (value: unknown): value is string => typeof value === 'string' && Boolean(value.trim()) && value.length <= 80 && !value.includes('\n')
  for (const key of ABOUT) if (short(args[key])) return (args[key] as string).trim()
  for (const value of Object.values(args)) if (short(value)) return value.trim()
  return undefined
}

/** Whether a result is that of a call cut off by a restart: it may or may not have run (see the daemon's afterTool). */
export const interrupted = (text: string) => /Superego restarted while .* was running|was interrupted (?:by a restart )?and may have partially run/.test(text)

// ── The Add and Edit dialog's form ───────────────────────────────────────────────────────────────────────────────────

/** An env var as the dialog edits it: plain (in the config), or secret (its name in `auth`, its value in the store). */
export type EnvRow = { name: string; value: string; secret: boolean }

/** What the dialog edits: a command (one line, split as a shell would) or a URL, with how it signs in, and More. */
export type ServerForm = {
  kind: 'command' | 'url'
  name: string
  title: string
  line: string
  url: string
  env: EnvRow[]
  /** For a URL: none, OAuth or an API key. A command's is its secret env, if any. */
  auth: 'none' | 'oauth' | 'api-key'
  /** An API key to set (blank: unchanged). */
  key: string
  lifetime: 'machine' | 'thread'
  tools: 'auto' | 'all' | 'search'
  timeout: string
}

export const emptyForm = (): ServerForm => ({ kind: 'command', name: '', title: '', line: '', url: '', env: [], auth: 'none', key: '', lifetime: 'machine', tools: 'auto', timeout: '' })

/** A config (a catalogue entry's, or one being edited) as the form shows it. Secret values aren't known: blank. */
export function formOf(name: string, config: ServerConfig): ServerForm {
  const secretNames = config.auth?.type === 'env' ? config.auth.names : []
  return {
    kind: config.url ? 'url' : 'command',
    name, title: config.title ?? '',
    line: config.command ? [config.command, ...config.args ?? []].map(quote).join(' ') : '',
    url: config.url ?? '',
    env: [...Object.entries(config.env ?? {}).map(([name, value]) => ({ name, value, secret: false })), ...secretNames.map((name) => ({ name, value: '', secret: true }))],
    auth: config.auth?.type === 'oauth' ? 'oauth' : config.auth?.type === 'api-key' ? 'api-key' : 'none',
    key: '',
    lifetime: config.lifetime ?? 'machine', tools: config.tools ?? 'auto', timeout: config.timeout ? String(config.timeout) : '',
  }
}

/**
 * The form as a config to save, and the secret values typed to set after (by name: `key`, or each env var's). What the
 * form doesn't show of `base` (cwd, headers, OAuth's scopes, the switches) is kept. Throws what's wrong, in a line.
 */
export function configOf(form: ServerForm, base: ServerConfig = {}): { name: string; config: ServerConfig; secrets: Record<string, string> } {
  const name = form.name.trim()
  if (!SERVER_NAME.test(name)) throw new Error('A name is lower-case letters, digits and hyphens, starting with a letter, up to 24.')
  const { command: _c, args: _a, env: _e, url: _u, headers, auth: had, title: _t, lifetime: _l, tools: _o, timeout: _m, allowed: _w, ...kept } = base
  const config: ServerConfig = { ...kept }
  const secrets: Record<string, string> = {}
  if (form.title.trim()) config.title = form.title.trim()
  if (form.kind === 'command') {
    const [command, ...args] = splitCommandLine(form.line)
    if (!command) throw new Error('Give the command it runs.')
    config.command = command
    if (args.length) config.args = args
    const rows = form.env.filter((row) => row.name.trim())
    for (const row of rows) if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(row.name.trim())) throw new Error(`${row.name.trim()} isn't a variable's name.`)
    const plain = rows.filter((row) => !row.secret)
    if (plain.length) config.env = Object.fromEntries(plain.map((row) => [row.name.trim(), row.value]))
    const secret = rows.filter((row) => row.secret)
    if (secret.length) config.auth = { type: 'env', names: secret.map((row) => row.name.trim()) }
    for (const row of secret) if (row.value) secrets[row.name.trim()] = row.value
  } else {
    let url: URL
    try { url = new URL(form.url.trim()) } catch { throw new Error('Give the URL it answers at.') }
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) throw new Error('Its URL needs https (http only on this computer: localhost).')
    config.url = form.url.trim()
    if (headers) config.headers = headers
    if (form.auth === 'oauth') config.auth = had?.type === 'oauth' ? had : { type: 'oauth' }
    if (form.auth === 'api-key') {
      config.auth = had?.type === 'api-key' ? had : { type: 'api-key' }
      if (form.key) secrets.key = form.key
    }
  }
  if (form.lifetime !== 'machine') config.lifetime = form.lifetime
  if (form.tools !== 'auto') config.tools = form.tools
  if (form.timeout.trim()) {
    const timeout = Number(form.timeout)
    if (!(timeout >= 1)) throw new Error('Its timeout is a number of seconds.')
    config.timeout = timeout
  }
  return { name, config, secrets }
}

/** What a check said, in a line: "Connected · 23 tools", or why not. */
export function checkText(server: ServerInfo): { ok: boolean; text: string } {
  const tools = server.tools !== undefined ? ` · ${server.tools} ${server.tools === 1 ? 'tool' : 'tools'}` : ''
  switch (server.state) {
    case 'running': case 'stopped': return server.listedAt || server.tools !== undefined ? { ok: true, text: `Connected${tools}` } : { ok: true, text: 'Saved' }
    case 'starting': return { ok: true, text: 'Saved; still starting' }
    case 'waiting': return { ok: true, text: 'Saved; it runs once you allow it' }
    case 'off': return { ok: true, text: 'Saved, switched off' }
    case 'needs-sign-in': return { ok: true, text: server.config.auth?.type === 'oauth' ? 'Saved; sign in to connect' : 'Saved; set its key to connect' }
    case 'failed': return { ok: false, text: server.error ?? 'It failed to start' }
  }
}
