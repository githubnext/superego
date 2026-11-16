// Ego's superego_mcp_servers: this machine's MCP servers, set up through the mcp-servers extension's actions. It lists
// them and the well-known ones, adds one (from the catalogue by name, or a command or a URL), edits, removes, and
// switches "Use in threads without a profile". It never handles a secret: nothing in its schema takes one, a value that
// looks like one is refused, and the user is sent to Settings → MCP servers to sign in or set a key. A command it adds
// or edits waits for the user's Allow (`allowed: false`). It refuses outside agents altogether.
import { defineTool } from '@earendil-works/pi-durable'
import { map, oneOf } from '@earendil-works/pi-schema'
import { arr, bool, obj, opt, str, type Json, type SettingsSnapshot } from '@superego/protocol'
import { CATALOG, fromCatalog } from '@superego/mcp-servers/catalog'
import { ACTIONS, SECTION, type CheckResult, type SectionData, type ServerConfig, type ServerInfo } from '@superego/mcp-servers/shared'

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

type Fields = {
  title?: string | undefined; command?: string | undefined; args?: string[] | undefined; cwd?: string | undefined; env?: Record<string, string> | undefined
  secretEnv?: string[] | undefined; url?: string | undefined; auth?: 'none' | 'oauth' | 'api-key' | undefined
  lifetime?: 'machine' | 'thread' | undefined; tools?: 'auto' | 'all' | 'search' | undefined
}

/** A config from the tool's fields, over `base` (the server edited); refusing anything that looks like a secret. */
export function configFrom(fields: Fields, base: ServerConfig = {}): ServerConfig {
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
  if (fields.command !== undefined && fields.url !== undefined) throw new Error('A server is a command or a URL, not both.')
  const kind = fields.command !== undefined ? 'command' : fields.url !== undefined ? 'url' : base.url ? 'url' : 'command'
  const { command, args, cwd, env, url, headers, auth, allowed: _allowed, ...rest } = base
  const config: ServerConfig = { ...rest }
  if (fields.title !== undefined) { if (fields.title) config.title = fields.title; else delete config.title }
  if (kind === 'command') {
    const next = fields.command ?? command
    if (!next) throw new Error('Give the command it runs, or a URL.')
    config.command = next
    const nextArgs = fields.args ?? (fields.command === undefined ? args : undefined)
    if (nextArgs?.length) config.args = nextArgs
    const nextCwd = fields.cwd ?? (fields.command === undefined ? cwd : undefined)
    if (nextCwd) config.cwd = nextCwd
    const nextEnv = fields.env ?? env
    if (nextEnv && Object.keys(nextEnv).length) config.env = nextEnv
    const names = fields.secretEnv ?? (auth?.type === 'env' ? auth.names : [])
    if (names.length) config.auth = { type: 'env', names }
  } else {
    config.url = fields.url ?? url!
    if (headers && fields.url === undefined) config.headers = headers
    const how = fields.auth ?? (auth?.type === 'oauth' || auth?.type === 'api-key' ? auth.type : 'none')
    if (how !== 'none') config.auth = auth?.type === how ? auth : { type: how }
  }
  if (fields.lifetime) config.lifetime = fields.lifetime
  if (fields.tools) config.tools = fields.tools
  return config
}

/** Settings → MCP servers as Ego reads it (`superego_settings`): each server in brief. */
export function briefSection(data: SectionData & { problem?: string }) {
  return { servers: data.servers.map(brief), profiles: data.profiles.map(brief), ...(data.problem ? { problem: data.problem } : {}) }
}

export function serversTool({ dispatch, snapshot, refuse }: {
  dispatch(id: string, params: Record<string, Json>): Promise<unknown>
  snapshot(): Promise<SettingsSnapshot>
  /**
   * Why it may not run now, for its call `callId` in conversation `conversation` (an outside agent asked); nothing when
   * it may.
   */
  refuse?(conversation: number, callId: string): Promise<string | undefined>
}) {
  const json = (value: unknown) => ({ output: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] })
  /** The machine's servers, as Settings has them; none when the extension is off here. */
  async function servers(): Promise<SectionData> {
    const section = (await snapshot()).sections.find((s) => s.id === SECTION)
    if (!section) throw new Error('This machine runs no MCP servers: the mcp-servers extension is off (Settings → Extensions).')
    return section.data as SectionData
  }
  const own = async (name: string | undefined) => {
    const data = await servers()
    const found = data.servers.find((s) => s.name === name)
    if (!found) throw new Error(name ? `No server ${name} here: ${data.servers.map((s) => s.name).join(', ') || 'none yet'}${data.profiles.some((s) => s.name === name) ? ` (${name} is a profile's: it's set up in that profile.ts)` : ''}` : 'Which server? Give its name.')
    return found
  }
  /** What a save said: the server as it stands after its check, and what the user has to do. */
  const after = (result: unknown) => {
    const server = (result as CheckResult).server
    return json({ ...brief(server), ...(server.state === 'running' || server.state === 'stopped' ? { checked: server.tools !== undefined ? `Connected: ${server.tools} tools` : 'Saved' } : {}) })
  }
  return defineTool({
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
      const refused = await refuse?.(Number(api.conversationId), api.callId)
      if (refused) throw new Error(refused)
      switch (op) {
        case 'list': { const data = await servers(); return json({ servers: data.servers.map(brief), profiles: data.profiles.map(brief) }) }
        case 'catalog': return json(CATALOG.map((e) => ({ name: e.name, title: e.title, description: e.description, runs: e.server.url ?? [e.server.command, ...e.server.args ?? []].join(' '), ...(e.setup ? { setup: e.setup } : {}) })))
        case 'add': {
          await servers()
          const known = catalog !== undefined ? fromCatalog(catalog) : fields.command === undefined && fields.url === undefined && name ? fromCatalog(name) : undefined
          if (catalog !== undefined && !known) throw new Error(`No well-known server ${catalog}: ${CATALOG.map((e) => e.name).join(', ')}. Give a command or a URL instead.`)
          const config = configFrom(fields, known?.server)
          const as = name ?? known?.name
          if (!as) throw new Error('Give it a name.')
          // A command is code: it waits for the user's Allow.
          const result = await dispatch(ACTIONS.add, { name: as, server: config as Json, ...(config.command ? { allowed: false } : {}) })
          return after(result)
        }
        case 'edit': {
          const server = await own(name)
          const config = configFrom(fields, server.config)
          const result = await dispatch(ACTIONS.edit, { name: server.name, server: config as Json, ...(config.command ? { allowed: false } : {}) })
          return after(result)
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
}
