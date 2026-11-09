// The command line of an app built on mu (`mu` for mu itself). With no command it starts a thread in the current
// directory and opens it in the app. Everything else (threads, machines, settings, sign-in, the daemon itself) works on
// this computer or, with `-m <machine>`, on any machine the app knows. `<id> connect` is what `ssh <host> <id> connect`
// runs on the far side. An app's bin calls `runCli(app, { appDir, bin })`.
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, openSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { createConnection } from 'node:net'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { devApp } from './dev-app.ts'
import { checkIdentity, MachineStore, openLocal, openMachine, routeOf, type MachineConfig, type Transport } from '@mu/client'
import { appEnv, defaultDataDir, isListening, readBuild, serveDaemon, socketPath } from '@mu/daemon'
import {
  FEATURES, PROTOCOL_VERSION, RpcError, type ActionInfo, type AppConfig, type AuthEvent, type Hello, type Json, type MethodName, type Params, type ProviderAuthInfo, type Result,
  type ProfileInfo, type ThreadInfo, type SettingsSnapshot,
} from '@mu/protocol'

export type CliOptions = {
  /** The app's directory: where its built Electron app (`out/`) and `package.json` are. */
  appDir: string
  /** The bin file itself, run with Node to start a daemon from source when the app isn't built. */
  bin: string
}

// One CLI run serves one app; `runCli` sets these before anything else runs.
let app: AppConfig
let options: CliOptions
let dataDir: string
let socket: string
let machines: MachineStore

const help = () => `${app.id}: ${app.name}

Usage:
  ${app.id} [dir] [-p prompt]          Start a thread in dir (default: here) and open it in the app
  ${app.id} open <thread>             Open a thread in the app
  ${app.id} threads [--archived]      List threads, or the archived ones (also: mu ls)
  ${app.id} create [dir] [-p prompt]   Start a thread without opening the app; prints its id (also: new)
  ${app.id} send <thread> <text...>   Send a message to a thread
      -P, --profile <name>        Start with this profile (default: the folder's default, the project's before yours)

  ${app.id} profile                    List the profiles a thread here could start with
  ${app.id} profile new [name] [--user] Make a profile in this project's .mu/profiles (or yours, ~/.${app.id}/profiles)
  ${app.id} profile allow [name]       Let this project's profile run (again, after it changed)

  ${app.id} machines                   List machines and whether they answer
  ${app.id} machines add <ssh-target> [--name N] [--command C]
  ${app.id} machines add --via '<cmd>' [--name N]
                                Add a machine reached by any command piping stdio to it
  ${app.id} machines rm|enable|disable|trust <machine>

  ${app.id} settings                   List settings and their values
  ${app.id} settings set <key> <value> Change a setting (value is JSON, or plain text)
  ${app.id} settings reset <key>       Back to the default
  ${app.id} auth                       List providers and how they are signed in
  ${app.id} auth key <provider>        Store an API key (prompted, or read from stdin)
  ${app.id} auth logout <provider>     Remove a stored credential

  ${app.id} actions [--all]            List the actions a machine takes from the command line (--all: every action)
  ${app.id} do <action> [--<param> <value>...] [--params '<json>']
                                Run an action; values are coerced to the action's schema
  ${app.id} actions log                Its newest dispatches, from anywhere

  ${app.id} daemon [status|stop]       Run this computer's daemon in the foreground, or check on it
  ${app.id} daemon restart [--now]     Restart it onto the installed code; --now interrupts working agents
  ${app.id} connect [--start]          Bridge stdio to this computer's daemon (ssh runs this)

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

const appDir = () => appEnv(app)('APP') ?? options.appDir

/**
 * The daemon code this computer would run: the app's build when there is one (so the app and `mu` agree on what is
 * current, and the app's restart notice means the same as ours), else this checkout's source.
 */
function installedDaemon(): { dir: string; command: string[]; env: NodeJS.ProcessEnv } {
  const bundled = resolve(appDir(), 'out/main/daemon.js')
  if (existsSync(bundled)) {
    // The app's own (development) bundle, so the daemon is "mu" in Activity Monitor, not "Electron".
    return { dir: resolve(appDir(), 'out/main'), command: [devApp(appDir(), app), bundled], env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } }
  }
  return { dir: fileURLToPath(new URL('../../daemon/src/', import.meta.url)), command: [process.execPath, options.bin, 'daemon'], env: process.env }
}

/** Start this computer's daemon in the background, logging next to its data. */
function startDaemon() {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 })
  const log = openSync(`${dataDir}/daemon.log`, 'a')
  const { command: [program, ...args], env } = installedDaemon()
  spawn(program!, args, { detached: true, stdio: ['ignore', log, log], env }).unref()
}

type Machine = { id: string; label: string; config?: MachineConfig }

function resolveMachine(name: string | undefined): Machine {
  if (!name || name === 'local' || name === 'this') return { id: 'local', label: 'This computer' }
  const config = machines.find(name)
  if (!config) throw new RpcError('not_found', `No machine called ${name}. See: ${app.id} machines`)
  return { id: config.id, label: config.label, config }
}

/** Connect to a machine, say hello, and check it is who it should be. */
async function connect(machine: Machine): Promise<{ transport: Transport; hello: Hello }> {
  const transport = machine.config ? await openMachine(machine.config, app) : await openLocal(socket, startDaemon)
  try {
    const hello = await transport.peer.call<Hello>('hello', { client: `${app.id}-cli`, version: PROTOCOL_VERSION, features: [...FEATURES] })
    if (machine.config) checkIdentity(hello, { target: routeOf(machine.config, app), ...(machine.config.daemonId ? { expected: machine.config.daemonId } : {}) }, [])
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
 * Show a thread in the app, starting the app if it isn't running. The app is single-instance: a second launch hands
 * its arguments to the running one and exits. `<ID>_APP` overrides where the app is.
 */
function openInApp(machine: string, thread: string) {
  const dir = appDir()
  if (!existsSync(resolve(dir, 'out/main/main.js'))) {
    throw new RpcError('no_app', `The app isn't built in ${dir}`, { hint: 'Build it: pnpm build in the app.' })
  }
  spawn(devApp(dir, app), [dir, `--mu-open=${machine}/${thread}`], { detached: true, stdio: 'ignore' }).unref()
}

// ── Commands ────────────────────────────────────────────────────────────────────────────────────────────────────────

async function startThread(args: { dir?: string; machine?: string; prompt?: string; profile?: string; open: boolean }) {
  const machine = resolveMachine(args.machine)
  // A local directory is resolved here; on another machine it is passed as given, or left to that daemon's default.
  const cwd = machine.config ? args.dir : resolve(args.dir ?? '.')
  const thread = await on(machine, async (call) => {
    // Actions take their parameters by name; thread.create picks the folder's profile unless one is named.
    const created = await call('action.run', { id: 'thread.create', params: { ...(cwd ? { cwd } : {}), ...(args.profile ? { profile: args.profile } : {}), ...(args.prompt ? { prompt: args.prompt } : {}) }, exposure: 'cli' }) as ThreadInfo
    return created
  })
  if (args.open) openInApp(machine.id, thread.id)
  print({ machine: machine.id, ...thread }, () => {
    if (args.open) console.log(`Opened thread ${thread.id} in ${thread.cwd}${machine.config ? ` on ${machine.label}` : ''}`)
    else console.log(thread.id)
  })
}

async function threads(machineName?: string, archived = false) {
  const machine = resolveMachine(machineName)
  const list = await on(machine, (call) => call('thread.list', archived ? { archived: true } : {}))
  print(list, () => {
    if (!list.length) return console.log(`No threads on ${machine.label}. Start one with: ${app.id}`)
    table(list.map((s: ThreadInfo) => [s.id, `${GLYPH[s.status.state]} ${s.status.state}`, s.title, s.cwd]))
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
    row.id === 'local' ? 'local' : row.id.slice(0, 8), row.label, row.config ? routeOf(row.config, app) : 'this computer',
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
  if (!machine.config) throw new RpcError('invalid', rest[0] ? 'This computer is always there.' : `Which machine? ${app.id} machines ${sub} <machine>`)
  if (sub === 'rm' || sub === 'remove') await machines.remove(machine.id)
  else if (sub === 'enable' || sub === 'disable') await machines.update(machine.id, { enabled: sub === 'enable' })
  else if (sub === 'trust') await machines.forgetIdentity(machine.id)
  else throw new RpcError('usage', `Unknown: ${app.id} machines ${sub}`)
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
  if (!key || (sub === 'set' && !value.length)) throw new RpcError('usage', `${app.id} settings ${sub} <key>${sub === 'set' ? ' <value>' : ''}`)
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
  if (!provider) throw new RpcError('usage', `${app.id} auth ${sub} <provider>`)
  if (sub === 'logout') {
    await on(machine, (call) => call('auth.logout', { provider }))
    return print({ ok: true }, () => console.log(`Signed out of ${provider} on ${machine.label}.`))
  }
  if (sub !== 'key') throw new RpcError('usage', `Unknown: ${app.id} auth ${sub}. Sign in with a browser from the app's Settings.`)
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

async function daemonCommand(sub: string | undefined, now: boolean) {
  if (!sub) return serveDaemon({ app, dataDir, socket })
  const local: Machine = { id: 'local', label: 'This computer' }
  const running = await isListening(socket)
  if (sub === 'status') {
    const installed = readBuild(installedDaemon().dir)
    if (!running) return print({ running: false, installed }, () => console.log('Not running.'))
    const hello = await on(local, async (_call, hello) => hello)
    const current = hello.machine.build === installed
    return print({ running: true, ...hello.machine, installed, current }, () => {
      console.log(`Running: pid ${hello.machine.pid}, build ${hello.machine.build}, ${socket}`)
      if (!current) console.log(`An update is installed (build ${installed}). Restart with: ${app.id} daemon restart`)
    })
  }
  if (sub === 'stop') {
    if (!running) return print({ stopped: false }, () => console.log('Not running.'))
    const { pid } = (await on(local, async (_call, hello) => hello)).machine
    process.kill(pid, 'SIGTERM')
    await stopped()
    return print({ stopped: true, pid }, () => console.log(`Stopped daemon ${pid}. Running agents stop with it.`))
  }
  if (sub === 'restart') {
    if (!running) {
      startDaemon()
      const hello = await on(local, async (_call, hello) => hello)
      return print({ restarted: true, build: hello.machine.build }, () => console.log(`Started daemon ${hello.machine.pid}, build ${hello.machine.build}.`))
    }
    const before = await on(local, async (call, hello) => {
      if (!hello.features.includes('restart')) {
        process.kill(hello.machine.pid, 'SIGTERM')
        return hello
      }
      const result = await call('daemon.restart', { build: hello.machine.build, interrupt: now })
      if (!result.restarted) {
        throw new RpcError('busy', 'Agents are working, so the daemon was not restarted.', { hint: `Wait for them, or: ${app.id} daemon restart --now (they resume after the restart).` })
      }
      return hello
    })
    await stopped()
    const after = await on(local, async (_call, hello) => hello)
    return print({ restarted: true, from: before.machine.build, build: after.machine.build }, () =>
      console.log(`Restarted: build ${before.machine.build} → ${after.machine.build}, pid ${after.machine.pid}.`))
  }
  throw new RpcError('usage', `Unknown: ${app.id} daemon ${sub}`)
}

/** Until nothing answers on the socket any more. */
async function stopped() {
  for (let i = 0; i < 100 && await isListening(socket); i++) await new Promise((done) => setTimeout(done, 100))
}

/** Splice stdio to this computer's daemon without parsing anything: the transport stays dumb, ssh does auth. */
async function bridge(start: boolean) {
  if (start && !(await isListening(socket))) await openLocal(socket, startDaemon).then((t) => t.close())
  const conn = createConnection(socket)
  conn.on('error', (error) => { console.error(`${app.id} connect: ${error.message}`); process.exit(1) })
  process.stdin.pipe(conn)
  conn.pipe(process.stdout)
  conn.on('close', () => process.exit(0))
}

// ── Profiles ────────────────────────────────────────────────────────────────────────────────────────────────────

const PROFILE_TEMPLATE = (name: string) => `// The ${name} profile: what an agent started with it is. Threads in this folder (and below) can start with it;
// "default" is the one they get unless they ask for another. Edits apply from the next turn.
import { defineProfile } from 'mu'

export default defineProfile({
  description: '',
  // model: 'anthropic/claude-sonnet-4-5',
  // thinking: 'medium',
  // prompt: 'You work on this project. …',
  // extensions: ['./extensions/example.ts'],   // agent extensions: tools, prompt sections, hooks
  // without: ['ask-user'],                       // built-ins this profile does without
  // extends: 'user:default',                     // start from your own profile of that name
})
`

async function profileCommand(sub: string | undefined, rest: string[], values: { machine?: string; user?: boolean }) {
  const machine = resolveMachine(values.machine)
  const run = (id: string, params: Record<string, unknown>) => on(machine, (call) => call('action.run', { id, params, exposure: 'cli' }))
  const cwd = machine.config ? undefined : process.cwd()
  if (!sub || sub === 'ls' || sub === 'list') {
    const list = await run('profile.list', cwd ? { cwd } : {}) as ProfileInfo[]
    return print(list, () => {
      if (!list.length) return console.log(`No profiles here. Make one: ${app.id} profile new`)
      table(list.map((p) => [p.name, p.scope === 'project' ? 'project' : 'yours', p.allowed ? '' : 'not allowed', p.dir]))
    })
  }
  if (sub === 'new') {
    if (machine.config) throw new RpcError('usage', `${app.id} profile new makes a profile here; on ${machine.label}, run it there`)
    const name = rest[0] ?? 'default'
    if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) throw new RpcError('usage', 'A profile name is lowercase letters, digits and dashes')
    const dir = values.user ? join(dataDir, 'profiles', name) : join(process.cwd(), '.mu', 'profiles', name)
    if (existsSync(join(dir, 'profile.ts'))) throw new RpcError('exists', `${join(dir, 'profile.ts')} is there already`)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'profile.ts'), PROFILE_TEMPLATE(name))
    // You wrote it, so it may run.
    if (!values.user) await run('profile.allow', { cwd: process.cwd(), name })
    return print({ name, dir }, () => console.log(`Made ${join(dir, 'profile.ts')}`))
  }
  if (sub === 'allow') {
    const allowed = await run('profile.allow', { ...(cwd ? { cwd } : {}), ...(rest[0] ? { name: rest[0] } : {}) }) as ProfileInfo
    return print(allowed, () => console.log(`Allowed ${allowed.name} (${allowed.dir}) as it is now`))
  }
  throw new RpcError('usage', `Unknown: ${app.id} profile ${sub}`)
}

// ── Actions ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/** A one-line signature for an action's params: `id* text whenBusy?=steer|followUp`. */
function signature(schema: ActionInfo['params']): string {
  const props = (schema as { properties?: Record<string, { enum?: unknown[]; type?: unknown }> } | undefined)?.properties
  if (!props) return ''
  const required = new Set((schema as { required?: string[] }).required ?? [])
  return Object.entries(props).map(([key, p]) => `${key}${required.has(key) ? '' : '?'}${p.enum ? '=' + p.enum.join('|') : ''}`).join(' ')
}

async function actionsCommand(sub: string | undefined, values: { machine?: string; all?: boolean }) {
  const machine = resolveMachine(values.machine)
  if (sub === 'log') {
    const log = await on(machine, (call) => call('action.log', {}))
    return print(log, () => table(log.map((e) => [new Date(e.at).toLocaleTimeString(), e.ok ? '✓' : '✗', e.id, e.source, `${e.ms}ms`, e.error ?? JSON.stringify(e.params ?? {})])))
  }
  if (sub) throw new RpcError('usage', `Unknown: ${app.id} actions ${sub}`)
  const list = (await on(machine, (call) => call('action.list', {}))).filter((a) => values.all || a.expose.includes('cli'))
  print(list, () => table(list.map((a) => [a.id, signature(a.params), a.title])))
}

/** `do <id> [-m machine] [--json] [--params json] [--key value | --key=value | --flag]...`, parsed by hand: keys are the action's. */
export function parseDo(argv: string[]): { id?: string; machine?: string; json: boolean; params: Record<string, unknown> } {
  const out: { id?: string; machine?: string; json: boolean; params: Record<string, unknown> } = { json: false, params: {} }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg === '-m' || arg === '--machine') { out.machine = argv[++i]; continue }
    if (arg === '--json') { out.json = true; continue }
    if (arg === '--params') {
      const parsed: unknown = JSON.parse(argv[++i] ?? '{}')
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new RpcError('usage', '--params takes a JSON object')
      Object.assign(out.params, parsed)
      continue
    }
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=')
      if (eq > 0) { out.params[arg.slice(2, eq)] = arg.slice(eq + 1); continue }
      const next = argv[i + 1]
      out.params[arg.slice(2)] = next === undefined || next.startsWith('--') ? true : (i++, next)
      continue
    }
    if (out.id) throw new RpcError('usage', `One action at a time; got "${out.id}" and "${arg}"`)
    out.id = arg
  }
  return out
}

async function doCommand(argv: string[]) {
  const parsed = parseDo(argv)
  json = parsed.json
  if (!parsed.id) throw new RpcError('usage', `${app.id} do <action> [--<param> <value>...]; list them with: ${app.id} actions`)
  const result = await on(resolveMachine(parsed.machine), (call) => call('action.run', { id: parsed.id!, params: parsed.params, exposure: 'cli' }))
  print(result ?? { ok: true }, () => { if (result !== undefined && result !== null) console.log(typeof result === 'string' ? result : JSON.stringify(result, null, 2)) })
}

// ── Dispatch ────────────────────────────────────────────────────────────────────────────────────────────────────────

const COMMANDS = new Set(['open', 'threads', 'ls', 'new', 'send', 'machines', 'settings', 'auth', 'daemon', 'connect', 'help', 'create', 'actions', 'do', 'profile', 'profiles'])

async function main() {
  // `do` takes the action's own --params, which parseArgs would refuse.
  const at = process.argv.indexOf('do', 2)
  if (at >= 0 && process.argv.slice(2, at).every((a, i, all) => a === '--json' || a === '-m' || a === '--machine' || all[i - 1] === '-m' || all[i - 1] === '--machine')) {
    return doCommand([...process.argv.slice(2, at), ...process.argv.slice(at + 1)])
  }
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      machine: { type: 'string', short: 'm' }, prompt: { type: 'string', short: 'p' }, json: { type: 'boolean' }, profile: { type: 'string', short: 'P' },
      user: { type: 'boolean' }, archived: { type: 'boolean' },
      all: { type: 'boolean' }, name: { type: 'string' }, command: { type: 'string' }, via: { type: 'string' },
      start: { type: 'boolean' }, now: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
    },
  })
  json = Boolean(values.json)
  const [first, ...rest] = positionals
  if (values.help || first === 'help') return console.log(help())
  // No command, or a directory: start a thread there and open it.
  if (!first || !COMMANDS.has(first)) return startThread({ dir: first, machine: values.machine, prompt: values.prompt, profile: values.profile, open: true })
  switch (first) {
    case 'open': {
      if (!rest[0]) throw new RpcError('usage', `${app.id} open <thread>`)
      const machine = resolveMachine(values.machine)
      await on(machine, (call) => call('thread.list', {})).then((list) => {
        if (!list.some((s) => s.id === rest[0])) throw new RpcError('not_found', `No thread ${rest[0]} on ${machine.label}`)
      })
      return openInApp(machine.id, rest[0])
    }
    case 'threads': case 'ls': return threads(values.machine, Boolean(values.archived))
    case 'new': case 'create': return startThread({ dir: rest[0], machine: values.machine, prompt: values.prompt, profile: values.profile, open: false })
    case 'profile': case 'profiles': return profileCommand(rest[0], rest.slice(1), values)
    case 'send': {
      const [id, ...text] = rest
      if (!id || !text.length) throw new RpcError('usage', `${app.id} send <thread> <text...>`)
      await on(resolveMachine(values.machine), (call) => call('thread.submit', { id, text: text.join(' ') }))
      return print({ ok: true }, () => {})
    }
    case 'machines': return machinesCommand(rest[0], rest.slice(1), values)
    case 'settings': return settingsCommand(rest[0], rest.slice(1), values)
    case 'auth': return authCommand(rest[0], rest.slice(1), values.machine)
    case 'daemon': return daemonCommand(rest[0], Boolean(values.now))
    case 'connect': return bridge(Boolean(values.start))
    case 'actions': return actionsCommand(rest[0], values)
  }
}

/** Run the command line for `config`, with `process.argv`. */
export function runCli(config: AppConfig, cliOptions: CliOptions) {
  app = config
  options = cliOptions
  dataDir = defaultDataDir(app)
  socket = socketPath(app, dataDir)
  machines = new MachineStore(dataDir)
  main().catch((error: unknown) => {
    const hint = error instanceof RpcError && error.hint ? `\n${error.hint}` : ''
    console.error(`${app.id}: ${error instanceof Error ? error.message : String(error)}${hint}`)
    process.exit(1)
  })
}
