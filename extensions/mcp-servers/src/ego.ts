// What Ego, Superego's own agent, gets of this extension in its thread (and no other thread does): superego_mcp_servers,
// to set up this machine's servers, and a word in its prompt on how. The tool lists the servers and the well-known ones,
// adds one (from the catalogue by name, or a command or a URL), edits, removes, and switches "Use in threads without a
// profile", all through this extension's actions. It never handles a secret: nothing in its schema takes one, a value
// that looks like one is refused, and the user is sent to Settings → MCP servers to sign in or set a key. A command it
// adds or edits waits for the user's Allow (`allowed: false`). It refuses outside agents altogether.
import { defineExtension, defineTool, section } from '@earendil-works/pi-durable'
import { map, oneOf } from '@earendil-works/pi-schema'
import { arr, bool, obj, opt, str, type AppConfig, type Json } from '@superego/protocol'
import { CATALOG, fromCatalog } from './catalog.ts'
import { configOf, formOf, quote } from './describe.ts'
import { ACTIONS, type CheckResult, type SectionData, type ServerConfig, type ServerInfo } from './shared.ts'

/** Ego's extension: its thread is the one it owns. */
export const EGO = 'ego'

/** Where the user does what Ego doesn't. */
const where = (name: string) => `Settings → MCP servers → ${name}`

/** A name or flag that says it holds a secret. */
const SECRETISH = /token|secret|passw|api[-_]?key|private[-_]?key|credential|auth/i

/** What the user has to do for a server, if anything, in a line for Ego to pass on. */
export function userStep(server: Pick<ServerInfo, 'name' | 'state' | 'config' | 'error'>): string | undefined {
  switch (server.state) {
    case 'waiting': return `It runs a command, so it waits for the user: ${where(server.name)} → Allow (it shows the whole command line).`
    case 'needs-sign-in': return server.config.auth?.type === 'oauth'
      ? `The user signs in: ${where(server.name)} → Sign in (in the browser).`
      : `The user sets its secret: ${where(server.name)} → Set key. Never ask for it in chat.`
    case 'failed': return `It failed${server.error ? `: ${server.error}` : ''}. The log is at ${where(server.name)} → Show log.`
    case 'off': return 'It is switched off.'
    default: return undefined
  }
}

/**
 * A server as Ego reports it: what it is and runs, how it stands, and what the user still has to do. Never its config's
 * env or header values (a header may well hold a key): what Ego sees, an outside agent asking it may see too.
 */
export const brief = (s: ServerInfo) => ({
  name: s.name, ...(s.config.title ? { title: s.config.title } : {}), runs: s.runs, state: s.state,
  ...(s.tools !== undefined ? { tools: s.tools } : {}), ...(s.error ? { error: s.error } : {}),
  ...(s.from.type === 'profile' ? { profile: s.from.profile, project: s.from.project } : { unprofiled: s.config.unprofiled === true }),
  ...(s.config.auth ? { signsIn: s.config.auth.type === 'env' ? `secret env: ${s.config.auth.names.join(', ')}` : s.config.auth.type } : {}),
  ...(userStep(s) ? { user: userStep(s) } : {}),
})

/** The tool's fields that make a config. */
export type Fields = {
  title?: string | undefined; command?: string | undefined; args?: string[] | undefined; cwd?: string | undefined; env?: Record<string, string> | undefined
  secretEnv?: string[] | undefined; url?: string | undefined; auth?: 'none' | 'oauth' | 'api-key' | undefined
  lifetime?: 'machine' | 'thread' | undefined; tools?: 'auto' | 'all' | 'search' | undefined
}

/** Refuse anything among the fields that looks like a secret, saying where it goes instead. */
function refuseSecrets(fields: Fields) {
  for (const [name, value] of Object.entries(fields.env ?? {})) {
    if (SECRETISH.test(name)) throw new Error(`${name} looks like a secret. Give its name in secretEnv instead: the user sets its value in Settings, never in chat.`)
    if (/^(?:sk|pk|ghp|gho|github_pat|xox[bp]|sntrys|lin_api)[-_]/i.test(value)) throw new Error(`${name}'s value looks like a key. Keys are the user's to set, in Settings.`)
  }
  for (const arg of fields.args ?? []) {
    if (/^--?[\w-]+/.test(arg) && SECRETISH.test(arg.split('=')[0]!)) throw new Error(`${arg.split('=')[0]} takes a secret. Use a secret env var (secretEnv) instead, set by the user in Settings.`)
  }
  if (fields.url) {
    let url: URL
    try { url = new URL(fields.url) } catch { throw new Error(`${fields.url} isn't a URL.`) }
    if (url.username || url.password || [...url.searchParams.keys()].some((key) => SECRETISH.test(key) || /^key$/i.test(key))) {
      throw new Error("That URL carries a credential. Give it without, and set the server's sign-in to oauth or api-key: the user signs in or sets the key in Settings.")
    }
  }
}

/**
 * A config from the tool's fields over `base` (the server edited, or a catalogue entry), made as the Add and Edit
 * dialog makes one (`configOf`): the fields given replace what they say, the rest of `base` is kept.
 */
export function configFrom(name: string, fields: Fields, base: ServerConfig = {}): ServerConfig {
  refuseSecrets(fields)
  if (fields.command !== undefined && fields.url !== undefined) throw new Error('A server is a command or a URL, not both.')
  const form = formOf(name, base)
  if (fields.title !== undefined) form.title = fields.title
  if (fields.command !== undefined || fields.args !== undefined) {
    const command = fields.command ?? base.command
    if (!command) throw new Error('Give the command it runs, or a URL.')
    const args = fields.args ?? (fields.command === undefined ? base.args ?? [] : [])
    form.kind = 'command'
    form.line = [command, ...args].map(quote).join(' ')
  }
  if (fields.url !== undefined) { form.kind = 'url'; form.url = fields.url }
  if (fields.env) form.env = [...Object.entries(fields.env).map(([name, value]) => ({ name, value, secret: false })), ...form.env.filter((row) => row.secret)]
  if (fields.secretEnv) form.env = [...form.env.filter((row) => !row.secret), ...fields.secretEnv.map((name) => ({ name, value: '', secret: true }))]
  if (fields.auth) form.auth = fields.auth
  if (fields.lifetime) form.lifetime = fields.lifetime
  if (fields.tools) form.tools = fields.tools
  const { config } = configOf(form, base)
  if (fields.cwd !== undefined && config.command) config.cwd = fields.cwd
  return config
}

/** What Ego is told of MCP servers, beside its tool. */
export const egoSection = (app: Pick<AppConfig, 'id' | 'name'>) => `MCP servers are other people's tools for the agents in threads (Linear, GitHub, Sentry, a browser): a command a
machine runs or a URL it reaches, set up per machine in Settings → MCP servers. A thread uses those its profile names
(\`mcpServers: ['linear']\`, with servers of its own as objects there), or without a profile those switched to "Use in
threads without a profile". "Outside agents" (\`${app.id} mcp\`) are the other way round: agents outside ${app.name}
using this machine.

You set up this machine's MCP servers with superego_mcp_servers: a well-known one by name (op catalog lists them),
else a command or a URL. Say what you'll change first, ask before removing one, and afterwards say where the user sees
it. A command you add doesn't run until the user allows it (Settings → MCP servers shows the whole command line, with
Allow): say so. Signing in is the user's: never ask for a key, token or password in chat, where it would stay in the
transcript, and never put one in a server's config. Send them to Settings → MCP servers → <name> → Sign in (OAuth, in
the browser) or Set key; if they paste one anyway, don't use it, and tell them to set it there (and to revoke it, if it
matters). An outside agent never sets up MCP servers: superego_mcp_servers refuses it, since a server runs commands and
reaches the user's accounts.`

/** Ego's part: superego_mcp_servers, and its section. */
export function egoPart({ app, data, dispatch, refuse }: {
  app: Pick<AppConfig, 'id' | 'name'>
  /** The machine's servers, as Settings has them. */
  data(): Promise<SectionData>
  /** Run one of this extension's actions. */
  dispatch(id: string, params: Record<string, Json>): Promise<unknown>
  /** Why it may not run now, for its call `callId` in conversation `conversation` (an outside agent asked); nothing when it may. */
  refuse(conversation: number, callId: string): Promise<string | undefined>
}) {
  const json = (value: unknown) => ({ output: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] })
  const own = async (name: string | undefined) => {
    const { servers, profiles } = await data()
    const found = servers.find((s) => s.name === name)
    if (!found) throw new Error(name ? `No server ${name} here: ${servers.map((s) => s.name).join(', ') || 'none yet'}${profiles.some((s) => s.name === name) ? ` (${name} is a profile's: it's set up in that profile.ts)` : ''}` : 'Which server? Give its name.')
    return found
  }
  /** What a save said: the server as it stands after its check, and what the user has to do. */
  const after = (result: unknown) => {
    const server = (result as CheckResult).server
    return json({ ...brief(server), ...(server.state === 'running' || server.state === 'stopped' ? { checked: server.tools !== undefined ? `Connected: ${server.tools} tools` : 'Saved' } : {}) })
  }
  const tool = defineTool({
    name: 'superego_mcp_servers',
    description: "This machine's MCP servers: other people's tools (Linear, GitHub, a browser) for the agents in its threads, as in Settings → MCP servers. " +
      'op: list (its servers, and those of profiles); catalog (well-known servers to add by name); add (by catalog name, or a command or a URL); edit; remove; unprofiled (on: threads without a profile use it). ' +
      "It takes no secrets: a server that needs a key or a sign-in tells you what the user does in Settings. A command you add runs only once the user allows it there.",
    parameters: obj({
      op: oneOf(['list', 'catalog', 'add', 'edit', 'remove', 'unprofiled']),
      name: opt(str({ description: 'The server: add, its name (lower-case, digits, hyphens; a catalog name adds that one); the others, which' })),
      catalog: opt(str({ description: 'add: a well-known server by name (op catalog lists them), when name is another' })),
      title: opt(str()),
      command: opt(str({ description: 'add, edit: the command it runs (stdio), e.g. npx' })),
      args: opt(arr(str(), { description: "The command's arguments, e.g. ['-y', '@sentry/mcp-server']" })),
      cwd: opt(str({ description: 'Where the command runs' })),
      env: opt(map(str(), { description: 'Plain environment values (never a secret)' })),
      secretEnv: opt(arr(str(), { description: 'Names of environment variables holding secrets: the user sets their values in Settings' })),
      url: opt(str({ description: 'add, edit: the URL it answers at (Streamable HTTP), https' })),
      auth: opt(oneOf(['none', 'oauth', 'api-key'], { description: 'A URL server\'s sign-in: OAuth in the browser, or an API key the user sets' })),
      lifetime: opt(oneOf(['machine', 'thread'], { description: 'machine: one process for all threads (default); thread: one per thread, in its folder (a browser, say)' })),
      tools: opt(oneOf(['auto', 'all', 'search'], { description: 'How its tools reach the model: auto (default), all offered, or found by search' })),
      on: opt(bool({ description: 'unprofiled: whether threads without a profile use it' })),
    }),
    async execute({ op, name, catalog, on, ...fields }, api) {
      const refused = await refuse(Number(api.conversationId), api.callId)
      if (refused) throw new Error(refused)
      switch (op) {
        case 'list': { const { servers, profiles } = await data(); return json({ servers: servers.map(brief), profiles: profiles.map(brief) }) }
        case 'catalog': return json(CATALOG.map((e) => ({ name: e.name, title: e.title, description: e.description, runs: e.server.url ?? [e.server.command, ...e.server.args ?? []].join(' '), ...(e.setup ? { setup: e.setup } : {}) })))
        case 'add': {
          const known = catalog !== undefined ? fromCatalog(catalog) : fields.command === undefined && fields.url === undefined && name ? fromCatalog(name) : undefined
          if (catalog !== undefined && !known) throw new Error(`No well-known server ${catalog}: ${CATALOG.map((e) => e.name).join(', ')}. Give a command or a URL instead.`)
          const as = name ?? known?.name
          if (!as) throw new Error('Give it a name.')
          const config = configFrom(as, fields, known?.server)
          // A command is code: it waits for the user's Allow.
          return after(await dispatch(ACTIONS.add, { name: as, server: config as Json, ...(config.command ? { allowed: false } : {}) }))
        }
        case 'edit': {
          const server = await own(name)
          const config = configFrom(server.name, fields, server.config)
          return after(await dispatch(ACTIONS.edit, { name: server.name, server: config as Json, ...(config.command ? { allowed: false } : {}) }))
        }
        case 'remove': {
          const server = await own(name)
          await dispatch(ACTIONS.remove, { name: server.name })
          return json({ removed: server.name })
        }
        case 'unprofiled': {
          const server = await own(name)
          if (on === undefined) throw new Error('Say on: true or false.')
          await dispatch(ACTIONS.set, { name: server.name, unprofiled: on })
          return json({ name: server.name, unprofiled: on })
        }
      }
    },
  })
  return defineExtension({ name: 'mcp-servers-ego', tools: [tool], sections: [section('mcp-servers-ego', () => egoSection(app))] })
}
