// What the UI half says of servers and calls, in words: a server's state and command line, a name for a new one, what
// a call is about; and the Add and Edit dialog's form, which Ego's tool makes configs with too (ego.ts). Plain
// functions, apart from React, so they're tested as such.
import { CLIENT_SECRET, SERVER_NAME, type SecretInfo, type ServerConfig, type ServerInfo, type ServerState, type SignInInfo } from './shared.ts'
import type { GlyphShape } from '@superego/ui'

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

/** The mark a state is drawn with (@superego/ui's `Glyph`): off a ring, starting the grey dots, running a check. */
export const DOT: Record<ServerState, GlyphShape> = {
  off: 'offline', stopped: 'idle', starting: 'connecting', running: 'landed', 'needs-sign-in': 'signin', waiting: 'permission', failed: 'error',
}

/** Whether a server needs the user before it can run: OAuth to sign in to, or a key or secret env value to set. */
export function needs(server: Pick<ServerInfo, 'state' | 'config' | 'secrets'>): 'sign-in' | 'key' | undefined {
  if (server.state !== 'needs-sign-in') return undefined
  return server.config.auth?.type === 'oauth' ? 'sign-in' : 'key'
}

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** A span in short: "5 min", "3 h", "12 days", as Settings says it elsewhere. */
function span(ms: number): string {
  if (ms < HOUR) return `${Math.max(1, Math.floor(ms / MINUTE))} min`
  if (ms < 2 * DAY) return `${Math.floor(ms / HOUR)} h`
  return `${Math.floor(ms / DAY)} days`
}

/** "just now", "5 min ago", "3 h ago", "12 days ago". */
export const ago = (time: number, now = Date.now()) => now - time < MINUTE ? 'just now' : `${span(now - time)} ago`

/**
 * An OAuth server's sign-in, in a few words, once it's signed in: "Signed in 3 days ago"; "Signed in, expires in 40 min"
 * when its token won't renew and runs out within a day. Nothing when it isn't signed in: its state says so.
 */
export function signInText(oauth: SignInInfo | undefined, now = Date.now()): string | undefined {
  if (!oauth?.signedIn) return undefined
  if (oauth.expires !== undefined && !oauth.refreshes) {
    const left = oauth.expires - now
    if (left <= 0) return 'Sign-in expired'
    if (left < DAY) return `Signed in, expires in ${span(left)}`
  }
  return oauth.since !== undefined ? `Signed in ${ago(oauth.since, now)}` : 'Signed in'
}

/** The rest of it, a line each, for the tooltip: when, whether it renews (or when it runs out), the scope granted. */
export function signInDetails(oauth: SignInInfo | undefined, date = (ms: number) => new Date(ms).toLocaleString()): string | undefined {
  if (!oauth?.signedIn) return undefined
  return [
    oauth.since !== undefined && `Signed in ${date(oauth.since)}`,
    oauth.refreshes ? 'Renews on its own' : oauth.expires !== undefined && `Expires ${date(oauth.expires)}`,
    oauth.scope && `Scope: ${oauth.scope}`,
  ].filter(Boolean).join('\n') || undefined
}

/** A secret's field label: "API key", "Client secret"; none for an env var's, drawn as its name. */
export const secretLabel = (name: string) => name === 'key' ? 'API key' : name === CLIENT_SECRET ? 'Client secret' : undefined

/** A secret's field placeholder: whether it's set, else whether it may be left blank. */
export const secretPlaceholder = (secret: SecretInfo) => secret.set ? 'Set (type to replace)' : secret.optional ? 'Optional' : ''

/**
 * What a row's menu offers for signing in: Sign in (OAuth, not signed in) or Set key; Client secret, for an OAuth
 * client registered by hand; and Sign out, when there's something to forget.
 */
export function authMenu(server: Pick<ServerInfo, 'config' | 'secrets' | 'oauth'>): { help?: 'Sign in…' | 'Set key…'; clientSecret: boolean; signOut: boolean } {
  const auth = server.config.auth
  if (!auth) return { clientSecret: false, signOut: false }
  const anySet = server.secrets.some((s) => s.set)
  if (auth.type !== 'oauth') return { help: 'Set key…', clientSecret: false, signOut: anySet }
  const signedIn = server.oauth?.signedIn === true
  return { ...(signedIn ? {} : { help: 'Sign in…' as const }), clientSecret: server.secrets.some((s) => s.name === CLIENT_SECRET), signOut: signedIn || anySet }
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
