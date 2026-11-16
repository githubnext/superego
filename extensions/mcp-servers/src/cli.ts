// `superego mcp-servers`: a machine's MCP servers, as Settings → MCP servers shows them (the live value
// `mcp-servers.servers`), what a thread's last turn had, a server's log, a restart, a secret set, and an OAuth sign-in
// from the terminal. A command of the app's own (`runCli`'s `commands`; see packages/cli/src/command.ts).
import { createInterface } from 'node:readline'
import type { CliCommand, CliContext, Transport } from '@superego/cli'
import { offers, RpcError, type AuthEvent, type Notifications } from '@superego/protocol'
import { catchRedirect } from './loopback.ts'
import { ACTIONS, LEFT_OUT, SERVERS_VALUE, type CheckResult, type LogResult, type SectionData, type ServerInfo, type ThreadServers } from './shared.ts'

export const mcpServersCommand: CliCommand = {
  name: 'mcp-servers',
  help: [
    { use: 'mcp-servers', does: "The MCP servers a machine's agents use (Settings → MCP servers): how each stands" },
    { use: 'mcp-servers --thread <thread>', does: 'The servers its last turn had, and those it was left without, and why', options: [['    --thread <thread>', 'That thread\'s']] },
    { use: 'mcp-servers logs <name> [--lines N]', does: 'Its log: stderr, log messages, connection errors (secrets hidden)', options: [['    --lines <n>', 'How many of its last lines (default: 100)']] },
    { use: 'mcp-servers restart <name>', does: 'Stop it, forget that it failed, and start it again to check it' },
    { use: 'mcp-servers set-secret <name> [VAR]', does: 'Store its API key, or the value of a secret env var (prompted, or read from stdin)' },
    { use: 'mcp-servers sign-in <name>', does: 'Sign in to it with OAuth: open the page it prints, or paste where the browser ends up' },
    { use: 'mcp-servers sign-out <name>', does: 'Forget its secrets and its sign-in' },
  ],
  options: { lines: { type: 'string' }, thread: { type: 'string' } },
  async run(cli, sub, rest, values) {
    const { machine } = cli
    if (typeof values.thread === 'string') {
      if (sub) throw new RpcError('usage', `${cli.app.id} mcp-servers --thread <thread> takes nothing more`)
      return threadServers(cli, values.thread)
    }
    const run = <T>(id: string, params: object) => cli.on((call) => call('action.run', { id, params, exposure: 'cli' })) as Promise<T>
    const line = (s: ServerInfo) => [
      s.from.type === 'machine' ? s.name : `${s.name} (${s.from.scope}:${s.from.profile})`,
      s.runs,
      s.state + (s.tools !== undefined ? ` · ${s.tools} tool${s.tools === 1 ? '' : 's'}${s.deferred ? ', by search' : ''}` : '') + (s.config.unprofiled ? ' · without a profile too' : ''),
    ]
    /** The machine's servers, as Settings → MCP servers draws them (the extension's live value): null while it's off. */
    const listed = () => cli.on((call) => call('value.watch', { key: SERVERS_VALUE }).then((r) => r.value as SectionData | null))
    if (!sub) {
      const data = await listed()
      if (!data) throw new RpcError('not_found', `${machine.label} has no MCP servers: the extension is off (Settings → Extensions)`)
      return cli.print(data, () => {
        if (!data.servers.length && !data.profiles.length) return console.log(`No MCP servers on ${machine.label} yet. Add one in the app's Settings → MCP servers.`)
        cli.table([...data.servers, ...data.profiles].map(line))
        for (const s of [...data.servers, ...data.profiles]) if (s.error && (s.state === 'failed' || s.state === 'needs-sign-in' || s.state === 'waiting')) console.log(`\n${s.name}: ${s.error}`)
      })
    }
    const name = rest[0]
    if (!name) throw new RpcError('usage', `${cli.app.id} mcp-servers ${sub} <name>`)
    /** A profile's server goes by its id; a name finds it when it's the only one of that name. */
    const idOf = async (given: string) => {
      if (given.includes('#')) return given
      const data = await listed()
      const found = [...data?.servers ?? [], ...data?.profiles ?? []].filter((s) => s.name === given)
      if (found.length > 1 && !found.some((s) => s.id === given)) throw new RpcError('usage', `More than one server is called ${given}: name one by its id (${found.map((s) => s.id).join(', ')})`)
      return found[0]?.id ?? given
    }
    if (sub === 'logs') {
      const lines = typeof values.lines === 'string' ? Number(values.lines) : 100
      const log = await run<LogResult>(ACTIONS.log, { server: await idOf(name), lines })
      return cli.print(log, () => console.log(log.text || `Nothing in ${log.path} yet.`))
    }
    if (sub === 'restart') {
      const { server } = await run<CheckResult>(ACTIONS.restart, { server: await idOf(name) })
      return cli.print(server, () => { cli.table([line(server)]); if (server.error) console.log(server.error) })
    }
    if (sub === 'set-secret') {
      const id = await idOf(name)
      const data = await listed()
      const server = [...data?.servers ?? [], ...data?.profiles ?? []].find((s) => s.id === id)
      if (!server) throw new RpcError('not_found', `No MCP server ${name} on ${machine.label}`)
      const names = server.secrets.map((s) => s.name)
      if (!names.length) throw new RpcError('usage', `${name} takes no secrets: its auth is ${server.config.auth?.type ?? 'none'}`)
      const which = rest[1] ?? (names.length === 1 ? names[0]! : undefined)
      if (!which || !names.includes(which)) throw new RpcError('usage', `Which? ${cli.app.id} mcp-servers set-secret ${name} <${names.join('|')}>`)
      const value = await cli.readSecret(which === 'key' ? `API key for ${name}: ` : `${which} for ${name}: `)
      if (!value) throw new RpcError('usage', 'Nothing given')
      const checked = await run<CheckResult>(ACTIONS.setSecret, { server: id, values: { [which]: value } })
      return cli.print(checked.server, () => { cli.table([line(checked.server)]); if (checked.server.error) console.log(checked.server.error) })
    }
    if (sub === 'sign-in') {
      const id = await idOf(name)
      const { transport } = await cli.connect()
      try { await signIn(transport, machine.remote, id, name) } finally { transport.close() }
      const data = await listed()
      const server = [...data?.servers ?? [], ...data?.profiles ?? []].find((s) => s.id === id)
      return cli.print(server ?? { id }, () => { console.log(`Signed in to ${name} on ${machine.label}.`); if (server) cli.table([line(server)]) })
    }
    if (sub === 'sign-out') {
      const { server } = await run<CheckResult>(ACTIONS.signOut, { server: await idOf(name) })
      return cli.print(server, () => console.log(`Signed out of ${name} on ${machine.label}.`))
    }
    throw new RpcError('usage', `Unknown: ${cli.app.id} mcp-servers ${sub}`)
  },
}

/** What a thread's last turn had (its facts, as the header and Details show them): each server, and those left out. */
async function threadServers(cli: CliContext, id: string) {
  const { thread } = await cli.on((call, hello) => {
    if (!offers(hello, 'thread-read')) throw new RpcError('unsupported', `${cli.machine.label} runs a Superego too old to say: update it`)
    return call('thread.read', { thread: id })
  })
  const servers = thread.facts?.['mcp-servers'] as ThreadServers | undefined
  cli.print(servers ?? null, () => {
    if (!servers) return console.log(`Thread ${id} has had no turn with MCP servers on ${cli.machine.label} yet.`)
    for (const s of servers.servers) console.log(`${s.name}: ${s.from === 'profile' ? "its profile's" : "this machine's"}, ${s.state}, ${s.tools} tool${s.tools === 1 ? '' : 's'}${s.deferred ? ' (by search)' : ''}${s.error ? `: ${s.error}` : ''}`)
    for (const l of servers.left ?? []) console.log(`without ${l.name}: ${LEFT_OUT[l.why]}`)
    if (!servers.servers.length && !servers.left?.length) console.log('None.')
  })
}

/**
 * Sign in to a server with OAuth from here (`mcp-servers.signIn`): the page to open is printed, and the address the
 * browser ends up on is caught by the machine's daemon (this computer's), by this command (another machine's: it
 * listens where the browser is sent, as the desktop app does), or pasted.
 */
async function signIn(transport: Transport, remote: boolean, server: string, name: string) {
  let flow: string | undefined
  const early: Notifications['auth.event'][] = []
  let hear = (_event: AuthEvent) => {}
  transport.peer.on('auth.event', (params: Notifications['auth.event']) => {
    if (flow === undefined) early.push(params)
    else if (params.flow === flow) hear(params.event)
  })
  const stop = new AbortController()
  let rl: ReturnType<typeof createInterface> | undefined
  /** The prompt waiting for the address, and the address once this command caught it. */
  let waiting: { id: string; asked: AbortController } | undefined
  let caught: string | undefined
  const respond = (prompt: string, value: string) => transport.peer.call('auth.respond', { flow: flow!, prompt, value }).catch((error: Error) => console.error(error.message))
  const ended = new Promise<AuthEvent>((resolve) => {
    hear = (event) => {
      if (event.type === 'auth_url') {
        console.error(`Open this page to sign in to ${name}:\n\n  ${event.url}\n`)
        if (remote && event.callback) {
          void catchRedirect(event.callback, stop.signal, event.url).then((url) => {
            caught = url
            if (waiting) respond(waiting.id, url)
          // It rejects only once the sign-in is over (`stop`): nothing waits for it then.
          }, () => {})
        }
      } else if (event.type === 'prompt' && event.prompt.type === 'manual_code') {
        if (caught) return void respond(event.id, caught)
        waiting = { id: event.id, asked: new AbortController() }
        const { id, asked } = waiting
        rl ??= createInterface({ input: process.stdin, output: process.stderr })
        rl.question(`${event.prompt.message}\n> `, { signal: asked.signal }, (value) => { if (value.trim()) respond(id, value.trim()) })
      } else if (event.type === 'prompt_closed') {
        if (waiting?.id === event.id) { waiting.asked.abort(); waiting = undefined }
      } else if (event.type === 'progress' || event.type === 'info') {
        console.error(event.message)
      } else if (event.type === 'done' || event.type === 'failed') {
        resolve(event)
      }
    }
  })
  try {
    ({ flow } = await transport.peer.call('action.run', { id: ACTIONS.signIn, params: { server }, exposure: 'cli' }) as { flow: string })
    for (const params of early.splice(0)) if (params.flow === flow) hear(params.event)
    const end = await ended
    if (end.type === 'failed') throw new RpcError('auth_failed', end.message)
  } finally {
    stop.abort()
    waiting?.asked.abort()
    rl?.close()
  }
}
