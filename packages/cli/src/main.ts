#!/usr/bin/env node
// `mu`: the command line for mu. With no command it starts a session in the current directory and opens it in the
// app. Everything else (sessions, machines, settings, sign-in, the daemon itself) works on this computer or, with
// `-m <machine>`, on any machine the app knows. `mu connect` is what `ssh <host> mu connect` runs on the far side.
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, openSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createInterface } from 'node:readline'
import { createConnection } from 'node:net'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { checkIdentity, MachineStore, openLocal, openMachine, routeOf, type MachineConfig, type Transport } from '@mu/client'
import { defaultDataDir, isListening, serveDaemon, socketPath } from '@mu/daemon'
import {
  FEATURES, PROTOCOL_VERSION, RpcError, type AuthEvent, type Hello, type Json, type MethodName, type Params, type ProviderAuthInfo, type Result,
  type SessionInfo, type SettingsSnapshot,
} from '@mu/protocol'

const dataDir = defaultDataDir()
const socket = socketPath(dataDir)
const machines = new MachineStore(dataDir)
const self = fileURLToPath(import.meta.url)

const HELP = `mu: an agent environment

Usage:
  mu [dir] [-p prompt]          Start a session in dir (default: here) and open it in the app
  mu open <session>             Open a session in the app
  mu sessions                   List sessions (also: mu ls)
  mu new [dir] [-p prompt]      Start a session without opening the app; prints its id
  mu send <session> <text...>   Send a message to a session

  mu machines                   List machines and whether they answer
  mu machines add <ssh-target> [--name N] [--command C]
  mu machines add --via '<cmd>' [--name N]
                                Add a machine reached by any command piping stdio to mu
  mu machines rm|enable|disable|trust <machine>

  mu settings                   List settings and their values
  mu settings set <key> <value> Change a setting (value is JSON, or plain text)
  mu settings reset <key>       Back to the default
  mu auth                       List providers and how they are signed in
  mu auth key <provider>        Store an API key (prompted, or read from stdin)
  mu auth logout <provider>     Remove a stored credential

  mu daemon [status|stop]       Run this computer's daemon in the foreground, or check on it
  mu connect [--start]          Bridge stdio to this computer's daemon (ssh runs this)

Options:
  -m, --machine <name>          Work on another machine (default: this computer)
      --all                     settings set/reset: every enabled machine
      --json                    Print JSON
  -h, --help
`

// ── Output ──────────────────────────────────────────────────────────────────────────────────────────────────────────

let json = false
const print = (value: unknown, human: () => void) => { if (json) console.log(JSON.stringify(value, null, 2)); else human() }
function table(rows: string[][]) {
  const widths = rows[0]?.map((_, i) => Math.max(...rows.map((row) => (row[i] ?? '').length))) ?? []
  for (const row of rows) console.log(row.map((cell, i) => i === row.length - 1 ? cell : cell.padEnd(widths[i]!)).join('  ').trimEnd())
}
const GLYPH: Record<string, string> = { idle: '○', working: '●', done: '*', blocked: '?', error: '!' }

// ── Reaching daemons ────────────────────────────────────────────────────────────────────────────────────────────────

/** Start this computer's daemon in the background, logging next to its data. */
function startDaemon() {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 })
  const log = openSync(`${dataDir}/daemon.log`, 'a')
  spawn(process.execPath, [self, 'daemon'], { detached: true, stdio: ['ignore', log, log], env: process.env }).unref()
}

type Machine = { id: string; label: string; config?: MachineConfig }

function resolveMachine(name: string | undefined): Machine {
  if (!name || name === 'local' || name === 'this') return { id: 'local', label: 'This computer' }
  const config = machines.find(name)
  if (!config) throw new RpcError('not_found', `No machine called ${name}. See: mu machines`)
  return { id: config.id, label: config.label, config }
}

/** Connect to a machine, say hello, and check it is who it should be. */
async function connect(machine: Machine): Promise<{ transport: Transport; hello: Hello }> {
  const transport = machine.config ? await openMachine(machine.config) : await openLocal(socket, startDaemon)
  try {
    const hello = await transport.peer.call<Hello>('hello', { client: 'mu-cli', version: PROTOCOL_VERSION, features: [...FEATURES] })
    if (machine.config) checkIdentity(hello, { target: routeOf(machine.config), ...(machine.config.daemonId ? { expected: machine.config.daemonId } : {}) }, [])
    return { transport, hello }
  } catch (error) {
    transport.close()
    throw error
  }
}

/** Run `work` with typed calls on a machine, closing the connection after. */
async function on<T>(machine: Machine, work: (call: <M extends MethodName>(method: M, params: Params<M>) => Promise<Result<M>>, hello: Hello) => Promise<T>) {
  const { transport, hello } = await connect(machine)
  try {
    return await work((method, params) => transport.peer.call(method, params), hello)
  } finally {
    transport.close()
  }
}

// ── The app ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Show a session in the app, starting the app if it isn't running. The app is single-instance: a second launch hands
 * its arguments to the running one and exits. `MU_APP` points at the app's directory; by default, this checkout's.
 */
function openInApp(machine: string, session: string) {
  const appDir = process.env.MU_APP ?? fileURLToPath(new URL('../../../app/', import.meta.url))
  if (!existsSync(resolve(appDir, 'out/main/main.js'))) {
    throw new RpcError('no_app', `The app isn't built in ${appDir}`, { hint: 'Run pnpm build in the mu checkout.' })
  }
  const electron = createRequire(resolve(appDir, 'package.json'))('electron') as string
  spawn(electron, [appDir, `--mu-open=${machine}/${session}`], { detached: true, stdio: 'ignore' }).unref()
}

// ── Commands ────────────────────────────────────────────────────────────────────────────────────────────────────────

async function startSession(args: { dir?: string; machine?: string; prompt?: string; open: boolean }) {
  const machine = resolveMachine(args.machine)
  // A local directory is resolved here; on another machine it is passed as given, or left to that daemon's default.
  const cwd = machine.config ? args.dir : resolve(args.dir ?? '.')
  const session = await on(machine, async (call) => {
    const created = await call('session.create', cwd ? { cwd } : {})
    if (args.prompt) await call('session.submit', { id: created.id, text: args.prompt })
    return created
  })
  if (args.open) openInApp(machine.id, session.id)
  print({ machine: machine.id, ...session }, () => {
    if (args.open) console.log(`Opened session ${session.id} in ${session.cwd}${machine.config ? ` on ${machine.label}` : ''}`)
    else console.log(session.id)
  })
}

async function sessions(machineName?: string) {
  const machine = resolveMachine(machineName)
  const list = await on(machine, (call) => call('session.list', {}))
  print(list, () => {
    if (!list.length) return console.log(`No sessions on ${machine.label}. Start one with: mu`)
    table(list.map((s: SessionInfo) => [s.id, `${GLYPH[s.status.state]} ${s.status.state}`, s.title, s.cwd]))
  })
}

async function listMachines() {
  const all: Machine[] = [{ id: 'local', label: 'This computer' }, ...machines.list().map((config) => ({ id: config.id, label: config.label, config }))]
  const rows = await Promise.all(all.map(async (machine) => {
    if (machine.config && !machine.config.enabled) return { ...machine, state: 'disabled' }
    try {
      const { transport, hello } = await withTimeout(connect(machine), 15_000)
      transport.close()
      return { ...machine, state: 'answers', hostname: hello.machine.hostname, features: hello.features }
    } catch (error) {
      return { ...machine, state: 'error', error: error instanceof Error ? error.message : String(error) }
    }
  }))
  print(rows, () => table(rows.map((row) => [
    row.id === 'local' ? 'local' : row.id.slice(0, 8), row.label, row.config ? routeOf(row.config) : 'this computer',
    'error' in row ? `error: ${row.error}` : 'hostname' in row ? `${row.state} (${row.hostname})` : row.state,
  ])))
}

const withTimeout = <T>(promise: Promise<T>, ms: number) => Promise.race([
  promise, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`no answer in ${ms / 1000}s`)), ms).unref()),
])

async function machinesCommand(sub: string | undefined, rest: string[], options: { name?: string; command?: string; via?: string }) {
  if (!sub || sub === 'ls' || sub === 'list') return listMachines()
  if (sub === 'add') {
    const added = await machines.add({ target: rest[0], label: options.name, command: options.command, via: options.via })
    // Learn who answers there now, so a different machine later is refused.
    try {
      const { transport, hello } = await withTimeout(connect({ id: added.id, label: added.label, config: added }), 15_000)
      transport.close()
      await machines.update(added.id, { daemonId: hello.machine.id })
      return print(added, () => console.log(`Added ${added.label} (${hello.machine.hostname}).`))
    } catch (error) {
      return print(added, () => console.log(`Added ${added.label}, but it doesn't answer yet: ${(error as Error).message}`))
    }
  }
  const machine = resolveMachine(rest[0])
  if (!machine.config) throw new RpcError('invalid', rest[0] ? 'This computer is always there.' : `Which machine? mu machines ${sub} <machine>`)
  if (sub === 'rm' || sub === 'remove') await machines.remove(machine.id)
  else if (sub === 'enable' || sub === 'disable') await machines.update(machine.id, { enabled: sub === 'enable' })
  else if (sub === 'trust') await machines.forgetIdentity(machine.id)
  else throw new RpcError('usage', `Unknown: mu machines ${sub}`)
  print({ ok: true }, () => console.log(`${sub === 'rm' ? 'Removed' : sub === 'trust' ? 'Will trust whoever answers at' : `${sub[0]!.toUpperCase()}${sub.slice(1)}d`} ${machine.label}.`))
}

/** A value from the command line: JSON when it parses, else the text itself. */
const parseValue = (text: string): Json => { try { return JSON.parse(text) } catch { return text } }

async function settingsCommand(sub: string | undefined, rest: string[], options: { machine?: string; all?: boolean }) {
  const targets = options.all ? [{ id: 'local', label: 'This computer' }, ...machines.list().filter((m) => m.enabled).map((config) => ({ id: config.id, label: config.label, config }))]
    : [resolveMachine(options.machine)]
  if (!sub || sub === 'ls' || sub === 'list') {
    if (options.all) throw new RpcError('usage', '--all is for set and reset')
    const snapshot = await on(targets[0]!, (call) => call('settings.watch', {}).then((r) => r.value)) as SettingsSnapshot
    return print(snapshot, () => {
      for (const section of snapshot.sections) {
        const settings = section.settings.filter((s) => !s.hidden)
        if (!settings.length) continue
        console.log(`${section.title}`)
        table(settings.map((s) => ['  ' + s.key, JSON.stringify(snapshot.values[s.key] ?? null), s.type === 'choice' && s.options.length <= 8 ? s.options.map((o) => o.value).join(' | ') : s.title]))
      }
    })
  }
  const [key, ...value] = rest
  if (!key || (sub === 'set' && !value.length)) throw new RpcError('usage', `mu settings ${sub} <key>${sub === 'set' ? ' <value>' : ''}`)
  const next = sub === 'reset' ? undefined : parseValue(value.join(' '))
  for (const target of targets) {
    try {
      await on(target, async (call) => {
        const snapshot = (await call('settings.watch', {})).value
        const setting = snapshot.sections.flatMap((s) => s.settings).find((s) => s.key === key)
        if (!setting) throw new RpcError('unknown_setting', `No setting ${key}`)
        await call('settings.set', { key, value: next === undefined ? setting.default : next })
      })
      if (!json) console.log(`${target.label}: ${key} = ${JSON.stringify(next ?? 'default')}`)
    } catch (error) {
      if (!options.all) throw error
      console.error(`${target.label}: ${(error as Error).message}`)
      process.exitCode = 1
    }
  }
}

async function readSecret(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) {
    let text = ''
    for await (const chunk of process.stdin) text += chunk
    return text.trim()
  }
  process.stdout.write(prompt)
  return new Promise((done) => {
    const rl = createInterface({ input: process.stdin, output: undefined, terminal: true })
    rl.question('', (answer) => { rl.close(); process.stdout.write('\n'); done(answer.trim()) })
  })
}

async function authCommand(sub: string | undefined, rest: string[], machineName?: string) {
  const machine = resolveMachine(machineName)
  if (!sub || sub === 'ls' || sub === 'list') {
    const snapshot = await on(machine, (call) => call('settings.watch', {}).then((r) => r.value))
    const providers = (snapshot.sections.find((s) => s.id === 'providers')?.data ?? []) as ProviderAuthInfo[]
    return print(providers, () => table(providers.map((p) => [p.id, p.auth ? `${p.auth.type === 'oauth' ? 'signed in' : 'api key'}${p.auth.source ? ` (${p.auth.source})` : ''}` : 'not signed in'])))
  }
  const provider = rest[0]
  if (!provider) throw new RpcError('usage', `mu auth ${sub} <provider>`)
  if (sub === 'logout') {
    await on(machine, (call) => call('auth.logout', { provider }))
    return print({ ok: true }, () => console.log(`Signed out of ${provider} on ${machine.label}.`))
  }
  if (sub !== 'key') throw new RpcError('usage', `Unknown: mu auth ${sub}. Sign in with a browser from the app's Settings.`)
  const key = await readSecret(`API key for ${provider}: `)
  if (!key) throw new RpcError('usage', 'No key given')
  // Sign in on that machine and wait for it to say how it went.
  const { transport } = await connect(machine)
  try {
    const outcome = new Promise<AuthEvent>((done) => transport.peer.on('auth.event', ({ event }: { event: AuthEvent }) => {
      if (event.type === 'done' || event.type === 'failed') done(event)
    }))
    await transport.peer.call('auth.login', { provider, type: 'api_key', key })
    const event = await withTimeout(outcome, 30_000)
    if (event.type === 'failed') throw new RpcError('auth_failed', event.message)
  } finally {
    transport.close()
  }
  return print({ ok: true }, () => console.log(`Stored an API key for ${provider} on ${machine.label}.`))
}

async function daemonCommand(sub: string | undefined) {
  if (!sub) return serveDaemon({ dataDir, socket, defaultCwd: process.env.MU_CWD ?? process.cwd() })
  const running = await isListening(socket)
  if (sub === 'status') {
    if (!running) return print({ running: false }, () => console.log('Not running.'))
    const hello = await on({ id: 'local', label: 'This computer' }, async (_call, hello) => hello)
    return print({ running: true, ...hello.machine }, () => console.log(`Running: pid ${hello.machine.pid}, ${socket}`))
  }
  if (sub === 'stop') {
    if (!running) return print({ stopped: false }, () => console.log('Not running.'))
    const { pid } = (await on({ id: 'local', label: 'This computer' }, async (_call, hello) => hello)).machine
    process.kill(pid, 'SIGTERM')
    for (let i = 0; i < 50 && await isListening(socket); i++) await new Promise((done) => setTimeout(done, 100))
    return print({ stopped: true, pid }, () => console.log(`Stopped daemon ${pid}. Running agents stop with it.`))
  }
  throw new RpcError('usage', `Unknown: mu daemon ${sub}`)
}

/** Splice stdio to this computer's daemon without parsing anything: the transport stays dumb, ssh does auth. */
async function bridge(start: boolean) {
  if (start && !(await isListening(socket))) await openLocal(socket, startDaemon).then((t) => t.close())
  const conn = createConnection(socket)
  conn.on('error', (error) => { console.error(`mu connect: ${error.message}`); process.exit(1) })
  process.stdin.pipe(conn)
  conn.pipe(process.stdout)
  conn.on('close', () => process.exit(0))
}

// ── Dispatch ────────────────────────────────────────────────────────────────────────────────────────────────────────

const COMMANDS = new Set(['open', 'sessions', 'ls', 'new', 'send', 'machines', 'settings', 'auth', 'daemon', 'connect', 'help'])

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      machine: { type: 'string', short: 'm' }, prompt: { type: 'string', short: 'p' }, json: { type: 'boolean' },
      all: { type: 'boolean' }, name: { type: 'string' }, command: { type: 'string' }, via: { type: 'string' },
      start: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
    },
  })
  json = Boolean(values.json)
  const [first, ...rest] = positionals
  if (values.help || first === 'help') return console.log(HELP)
  // No command, or a directory: start a session there and open it.
  if (!first || !COMMANDS.has(first)) return startSession({ dir: first, machine: values.machine, prompt: values.prompt, open: true })
  switch (first) {
    case 'open': {
      if (!rest[0]) throw new RpcError('usage', 'mu open <session>')
      const machine = resolveMachine(values.machine)
      await on(machine, (call) => call('session.list', {})).then((list) => {
        if (!list.some((s) => s.id === rest[0])) throw new RpcError('not_found', `No session ${rest[0]} on ${machine.label}`)
      })
      return openInApp(machine.id, rest[0])
    }
    case 'sessions': case 'ls': return sessions(values.machine)
    case 'new': return startSession({ dir: rest[0], machine: values.machine, prompt: values.prompt, open: false })
    case 'send': {
      const [id, ...text] = rest
      if (!id || !text.length) throw new RpcError('usage', 'mu send <session> <text...>')
      await on(resolveMachine(values.machine), (call) => call('session.submit', { id, text: text.join(' ') }))
      return print({ ok: true }, () => {})
    }
    case 'machines': return machinesCommand(rest[0], rest.slice(1), values)
    case 'settings': return settingsCommand(rest[0], rest.slice(1), values)
    case 'auth': return authCommand(rest[0], rest.slice(1), values.machine)
    case 'daemon': return daemonCommand(rest[0])
    case 'connect': return bridge(Boolean(values.start))
  }
}

main().catch((error: unknown) => {
  const hint = error instanceof RpcError && error.hint ? `\n${error.hint}` : ''
  console.error(`mu: ${error instanceof Error ? error.message : String(error)}${hint}`)
  process.exit(1)
})
