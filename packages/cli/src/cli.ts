// The command line of an app built on Superego (`superego` for Superego itself). With no command it starts a thread in the current
// directory and opens it in the app. Everything else (threads, machines, settings, sign-in, the daemon itself) works on
// this computer or, with `-m <machine>`, on any machine the app knows. `<id> connect` is what `ssh <host> <id> connect`
// runs on the far side. An app's bin calls `runCli(app, { appDir, bin })`.
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { createConnection } from 'node:net'
import { hostname } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { renderUnicodeCompact } from 'uqr'
import { devApp } from './dev-app.ts'
import { authorTypes, newExtension, testExtension } from './extensions.ts'
import { setUpProfileTypes, type ProfileTypes } from '@superego/client/author-types'
import { formatReport } from './inspect.ts'
import { readThread } from './read.ts'
import { skill } from './skill.ts'
import { KIND_SAYS, starterKind } from './starter.ts'
import { commandHelp, commandNames, help } from './usage.ts'
import type { CliCommand, CliContext } from './command.ts'
import {
  checkIdentity, collectProfileUi, controlPath, filesOf, hashProfileUi, loginArgs, machineHub, MachineStore, masterAlive, openLocal, openMachine, routeOf, runUpdate, UiAllowStore, updateScript, within,
  type MachineConfig, type Transport,
} from '@superego/client'
// The daemon itself only for `daemon run`: loading it costs every other command most of its start.
import { appEnv, appSocketPath, connectSocket, daemonStarting, defaultDataDir, installService, isListening, readBuild, socketPath, spawnDaemon, startService, uninstallService } from '@superego/daemon/client'
import {
  AUTH_REJECTED, compareVersions, consentRefused, driftPhrase, PROTOCOL_VERSION, RpcError, threadEnv, unreadThreads, versionOf, statusShape, statusWord, STATUS_WORDS, type ActionInfo, type AppConfig, type AuthEvent, type AuthPrompt, type Hello, type Json, type MethodName, type Params, type ProviderAuthInfo, type Result,
  type ProfileInfo, type ProfileRef, type ProfileSourceInfo, type ProviderRejection, type ThreadInfo, type SettingInfo, type SettingsSnapshot,
} from '@superego/protocol'

export type CliOptions = {
  /** The app's directory: where its built Electron app (`out/`) and `package.json` are. */
  appDir: string
  /** The bin file itself, run with Node to start a daemon from source when the app isn't built. */
  bin: string
  /**
   * The app's daemon entry (its `src/daemon.ts`), run with Node when the app isn't built: the daemon with the app's
   * extensions and its web build. Without it, `<id> daemon` is the bare core.
   */
  daemon?: string
  /**
   * The app's own executable, when this CLI is the build inside a packaged app (run on it as Node): it runs the daemon
   * and opens the app. Without it, the checkout's development bundle (see dev-app.ts).
   */
  executable?: string
  /** The types for profile authors this build carries (a packaged app's out/types); without, built from the checkout. */
  types?: string
  /** What `<id> extension test` checks and tests with (a packaged app's out/main/author-test.js); without, the checkout's. */
  authorTest?: string
  /** Commands of the app's own (its bundled extensions'), beside the core's: see command.ts. */
  commands?: CliCommand[]
}

// One CLI run serves one app; `runCli` sets these before anything else runs.
let app: AppConfig
let options: CliOptions
let dataDir: string
let socket: string
let machines: MachineStore

// ── Output ──────────────────────────────────────────────────────────────────────────────────────────────────────────

let json = false
const print = (value: unknown, human: () => void) => { if (json) console.log(JSON.stringify(value, null, 2)); else human() }
function table(rows: string[][]) {
  const widths = rows[0]?.map((_, i) => Math.max(...rows.map((row) => (row[i] ?? '').length))) ?? []
  for (const row of rows) console.log(row.map((cell, i) => i === row.length - 1 ? cell : cell.padEnd(widths[i]!)).join('  ').trimEnd())
}
/** A thread's state as a column of words, as the app says them (Working, Question, Permission, Sign in, Failed, Done); blank when idle. */
const stateOf = (thread: ThreadInfo) => statusWord(thread.status, thread.quiet)

/** The providers that rejected a machine's credentials. */
const rejectedOn = (call: <M extends MethodName>(method: M, params: Params<M>) => Promise<Result<M>>) =>
  call('value.watch', { key: AUTH_REJECTED }).then((r) => (r.value ?? []) as ProviderRejection[])

/** What to say of each rejected provider: what happened, what waits, and how to sign in again. */
function sayRejected(rejections: ProviderRejection[], machine: Machine) {
  const on = machine.config ? ` -m ${/\s/.test(machine.label) ? JSON.stringify(machine.label) : machine.label}` : ''
  for (const r of rejections) {
    const since = new Date(r.since).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' })
    const waiting = r.threads.length === 0 ? 'New turns wait' : `${r.threads.length} thread${r.threads.length === 1 ? ' is' : 's are'} waiting`
    console.log(`\n${r.summary}${machine.config ? ` on ${machine.label}` : ''} (since ${since}). ${waiting} for sign-in, and go on once it's done.`)
    console.log(`  Sign in again: ${app.id} providers key ${r.provider}${on}, or in the app's Settings → Providers`)
    console.log(`  Retry now:     ${app.id} providers retry ${r.provider}${on}`)
  }
}

// ── Reaching daemons ────────────────────────────────────────────────────────────────────────────────────────────────

const appDir = () => appEnv(app)('APP') ?? options.appDir
/** The packaged app's executable this CLI came in, unless `<ID>_APP` points elsewhere. */
const packaged = () => appEnv(app)('APP') ? undefined : options.executable
/** What runs the app at `appDir()`: the packaged app itself, or the checkout's development bundle. */
const appExecutable = () => packaged() ?? devApp(appDir(), app)

/**
 * The daemon code this computer would run: the app's build when there is one (so the app and `superego` agree on what is
 * current, and the app's restart notice means the same as ours), else this checkout's source.
 */
function installedDaemon(): { dir: string; command: string[]; env: NodeJS.ProcessEnv } {
  const bundled = resolve(appDir(), 'out/main/daemon.js')
  if (existsSync(bundled)) {
    // The app's own (development) bundle, so the daemon is "Superego" in Activity Monitor, not "Electron".
    return { dir: resolve(appDir(), 'out/main'), command: [appExecutable(), bundled], env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } }
  }
  const command = options.daemon ? [process.execPath, options.daemon] : [process.execPath, options.bin, 'daemon']
  return { dir: fileURLToPath(new URL('../../daemon/src/', import.meta.url)), command, env: process.env }
}

/** Start this computer's daemon in the background, unless one is on its way; whether it still is (see `openLocal`). */
function startDaemon(): () => boolean {
  const starting = () => daemonStarting(dataDir)
  if (starting()) return starting
  // A service, when one is installed, is what starts it: it then lives and restarts as the service says. Its daemon
  // names itself only once it listens, so it's given ten seconds.
  if (startService({ app })) {
    const until = Date.now() + 10_000
    return () => Date.now() < until
  }
  const { command, env } = installedDaemon()
  return spawnDaemon(dataDir, command, env)
}

type Machine = { id: string; label: string; config?: MachineConfig }

function resolveMachine(name: string | undefined): Machine {
  if (!name || name === 'local' || name === 'this') return { id: 'local', label: 'This computer' }
  const config = machines.find(name)
  if (!config) throw new RpcError('not_found', `No machine called ${name}. See: ${app.id} machines`)
  return { id: config.id, label: config.label, config }
}

/**
 * The thread whose agent's shell this command runs in (`<ID>_THREAD`, which the daemon sets there): an agent's command
 * line, not the user's. It says so in hello, so the daemon refuses it the user's consent; what only this command line
 * does (allow a machine's profile UI, trust a machine), it refuses itself.
 */
const agentThread = () => process.env[threadEnv(app)] || undefined

/** Refuse `what` when an agent runs this: it records the user's consent (see `ActionInfo.consent`). */
function userOnly(what: string) {
  if (agentThread()) throw consentRefused(what)
}

/**
 * How long a machine has to answer hello once its transport is open (ssh connecting, and `connect --start` starting a
 * daemon there, included); a check of several machines (the listing, before an update) gives each less.
 */
const ANSWER = 30_000
const PROBE = 15_000

type How = {
  /** Start this computer's daemon if none is running (the default). */
  start?: boolean
  /** How long hello may take. In `on`, the work's too: given, that is bounded as well. */
  deadline?: number
}

/**
 * Connect to a machine, say hello, and check it is who it should be. One that doesn't answer in time (a peer that
 * accepts and never answers) is closed, its ssh with it, and fails as a `timeout`.
 */
async function connect(machine: Machine, as: { client: string; label: string } = { client: `${app.id}-cli`, label: hostname() }, { start = true, deadline = ANSWER }: How = {}): Promise<{ transport: Transport; hello: Hello }> {
  const transport = machine.config ? await openMachine(machine.config, app, dataDir) : await openLocal(socket, start ? startDaemon : undefined)
  try {
    const from = agentThread()
    const hello = await within(transport.peer.call<Hello>('hello', { ...as, version: PROTOCOL_VERSION, ...(from ? { from } : {}) }), deadline, () => timedOut(machine, deadline))
    if (machine.config) checkIdentity(hello, { target: routeOf(machine.config, app), ...(machine.config.daemonId ? { expected: machine.config.daemonId } : {}) }, [])
    return { transport, hello }
  } catch (error) {
    transport.close()
    throw error
  }
}

const timedOut = (machine: Machine, ms: number) => new RpcError('timeout', `${machine.label} did not answer in ${ms / 1000}s`)

/** Run `work` with typed calls on a machine, closing the connection after (and when a deadline passes). */
async function on<T>(machine: Machine, work: (call: <M extends MethodName>(method: M, params: Params<M>) => Promise<Result<M>>, hello: Hello) => Promise<T>, how: How = {}) {
  const { transport, hello } = await connect(machine, undefined, how)
  try {
    const done = work((method, params) => transport.peer.call(method, params), hello)
    return await (how.deadline ? within(done, how.deadline, () => timedOut(machine, how.deadline!)) : done)
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
  // A packaged app is its own app; a development bundle is Electron, told which app to run. Not as Node, as this may be.
  const args = packaged() ? [] : [dir]
  const { ELECTRON_RUN_AS_NODE: _, ...env } = process.env
  spawn(appExecutable(), [...args, `--superego-open=${machine}/${thread}`], { detached: true, stdio: 'ignore', env }).unref()
}

// ── Commands ────────────────────────────────────────────────────────────────────────────────────────────────────────

async function startThread(args: { dir?: string; machine?: string; prompt?: string; profile?: string; worktree?: boolean; open: boolean }) {
  const machine = resolveMachine(args.machine)
  // A local directory is resolved here; on another machine it is passed as given, or left to that daemon's default.
  const cwd = machine.config ? args.dir : resolve(args.dir ?? '.')
  const thread = await on(machine, async (call) => {
    // Actions take their parameters by name; thread.start picks the folder's profile unless one is named.
    const created = await call('action.run', { id: 'thread.start', params: { ...(cwd ? { cwd } : {}), ...(args.profile ? { profile: args.profile } : {}), ...(args.prompt ? { prompt: args.prompt } : {}), ...(args.worktree ? { options: { worktrees: true } } : {}) }, exposure: 'cli' }) as ThreadInfo
    return created
  })
  if (args.open) openInApp(machine.id, thread.id)
  print({ machine: machine.id, ...thread }, () => {
    // Its worktree, as the worktrees extension says.
    const tree = thread.facts?.worktrees as { branch: string } | undefined
    const where = tree ? `its worktree ${thread.cwd} (branch ${tree.branch})` : thread.cwd
    if (args.open) console.log(`Opened thread ${thread.id} in ${where}${machine.config ? ` on ${machine.label}` : ''}`)
    else console.log(thread.id)
  })
}

async function threads(machineName?: string, archived = false) {
  const machine = resolveMachine(machineName)
  const { list, rejected } = await on(machine, async (call) => ({
    list: await call('thread.list', archived ? { archived: true } : {}),
    rejected: archived ? [] : await rejectedOn(call),
  }))
  print(list, () => {
    if (!list.length) console.log(`No threads on ${machine.label}. Start one with: ${app.id}`)
    else table(list.map((s: ThreadInfo) => [s.id, stateOf(s), s.title, s.cwd]))
    sayRejected(rejected, machine)
  })
}

/**
 * The unread threads, the most pressing first (protocol's `unreadThreads`, the app icon's count): this computer's,
 * and those of every machine its daemon reaches and is connected to. Only a running daemon is asked: none is started,
 * so a status bar polling this gets nothing (0) while there's none. `-m`, one machine's only.
 */
async function unreadCommand(machineName: string | undefined, countOnly: boolean) {
  const heard: { machine: string; label: string; thread: ThreadInfo }[] = []
  const machine = resolveMachine(machineName)
  if (machine.config || await isListening(socket)) {
    await on(machine, async (call, hello) => {
      const add = (id: string, label: string, list: ThreadInfo[]) => { for (const thread of list) heard.push({ machine: id, label, thread }) }
      add(machine.id, machine.label, await call('thread.list', {}))
      if (machine.config) return
      const { value } = await call('machines.watch', {})
      await Promise.all(value.filter((m) => m.id !== 'local' && m.state === 'connected').map(async (m) => {
        // One that went away since it was listed counts as nothing, and says so: the rest still count.
        const list = await call('relay.call', { machine: m.id, method: 'thread.list', params: {} }).then((list) => list as ThreadInfo[], (error: Error) => {
          console.error(`${app.id}: ${m.label}: ${error.message}`)
          return []
        })
        add(m.id, m.label, list)
      }))
    }, { start: false })
  }
  const found = unreadThreads(heard)
  const threads = found.map(({ machine, thread }) => ({ machine, id: thread.id, title: thread.title, state: thread.status.state }))
  if (countOnly && !json) return void console.log(String(threads.length))
  print({ count: threads.length, threads }, () => {
    if (!found.length) return void console.log('Nothing unread')
    const several = new Set(found.map((f) => f.machine)).size > 1
    table(found.map(({ label, thread }) => [thread.id, stateOf(thread), thread.title, ...(several ? [label] : [])]))
  })
}

async function listMachines() {
  const all: Machine[] = [{ id: 'local', label: 'This computer' }, ...machines.list().map((config) => ({ id: config.id, label: config.label, config }))]
  const rows = await Promise.all(all.map(async (machine) => {
    if (machine.config && !machine.config.enabled) return { ...machine, state: 'disabled' }
    try {
      const { transport, hello } = await connect(machine, undefined, { deadline: PROBE })
      transport.close()
      return { ...machine, state: 'answers', hostname: hello.machine.hostname, features: hello.features, version: versionOf(hello), keepsRunning: hello.machine.keepsRunning }
    } catch (error) {
      const kind = error instanceof RpcError ? error.kind : 'error'
      const state = kind === 'needs_login' ? 'needs login' : kind.startsWith('host_key') ? 'host key' : kind === 'timeout' ? 'not answering' : 'error'
      return { ...machine, state, error: error instanceof Error ? error.message : String(error), kind }
    }
  }))
  // Each machine's Superego next to this computer's.
  const here = rows[0] && 'version' in rows[0] ? rows[0].version : undefined
  const described = rows.map((row) => {
    const drift = row.config && 'version' in row ? compareVersions(here, row.version) : undefined
    return { ...row, ...(drift ? { drift } : {}) }
  })
  print(described, () => table(described.map((row) => [
    row.id === 'local' ? 'local' : row.id.slice(0, 8), row.label, row.config ? routeOf(row.config, app) : 'this computer',
    ((row as { kind?: string }).kind === 'needs_login' ? `needs login: ${app.id} machines login ${row.label}`
      : (row as { kind?: string }).kind === 'timeout' ? 'not answering (timed out connecting)'
      : 'error' in row ? `${row.state === 'error' ? 'error' : row.state}: ${row.error}`
      : 'hostname' in row ? `${row.state} (${row.hostname})${row.config && stopsEarly(row.keepsRunning) ? ` - stops at logout or reboot: run ${app.id} daemon install there` : ''}` : row.state)
      + ('drift' in row && driftPhrase(row.drift, app.name) ? ` · runs ${driftPhrase(row.drift, app.name)}` : ''),
  ])))
}

/** Whether a daemon's `keepsRunning` says it will go away. Unknown (a launchd agent) is not a warning. */
const stopsEarly = (keeps: Hello['machine']['keepsRunning']) => keeps.service === null || keeps.afterLogout === false

/** Run ssh in this terminal, so it can ask, and leave a master behind that links and commands ride. */
async function loginCommand(machine: Machine) {
  const config = machine.config!
  if (config.via) throw new RpcError('invalid', `${machine.label} is reached with a command, not ssh: there is no login`)
  const control = controlPath(dataDir, config.target)
  if (!(await masterAlive(control, config.target))) {
    mkdirSync(dirname(control), { recursive: true, mode: 0o700 })
    const result = spawnSync('ssh', [...loginArgs(control), '--', config.target], { stdio: 'inherit' })
    if (result.status !== 0) throw new RpcError('login_failed', `ssh did not log in to ${config.target}`)
  }
  // The master is what they ride now: check it gets to a daemon.
  try {
    const { transport, hello } = await connect(machine)
    transport.close()
    if (!config.daemonId) await machines.update(config.id, { daemonId: hello.machine.id })
    return print({ ok: true, hostname: hello.machine.hostname }, () => console.log(`Logged in to ${machine.label} (${hello.machine.hostname}).`))
  } catch (error) {
    return print({ ok: true, answers: false }, () => console.log(`Logged in to ${machine.label}, but ${app.name} doesn't answer there yet: ${(error as Error).message}`))
  }
}

async function machinesCommand(sub: string | undefined, rest: string[], options: { name?: string; command?: string; via?: string; now?: boolean }) {
  if (!sub) return listMachines()
  if (sub === 'add') {
    const added = await machines.add({ target: rest[0], label: options.name, command: options.command, via: options.via })
    // Learn who answers there now, so a different machine later is refused.
    try {
      const { transport, hello } = await connect({ id: added.id, label: added.label, config: added }, undefined, { deadline: PROBE })
      transport.close()
      await machines.update(added.id, { daemonId: hello.machine.id })
      return print(added, () => console.log(`Added ${added.label} (${hello.machine.hostname}).`))
    } catch (error) {
      return print(added, () => console.log(`Added ${added.label}, but it doesn't answer yet: ${(error as Error).message}`))
    }
  }
  const machine = resolveMachine(rest[0])
  if (sub === 'update' && rest[0] && !machine.config) {
    throw new RpcError('invalid', `This computer's ${app.name} is updated by hand: pull its checkout, then ${app.id} daemon restart.`)
  }
  if (!machine.config) throw new RpcError('invalid', rest[0] ? 'This computer is always there.' : `Which machine? ${app.id} machines ${sub} <machine>`)
  if (sub === 'login') return loginCommand(machine)
  if (sub === 'update') return updateMachine(machine as Machine & { config: MachineConfig }, Boolean(options.now))
  // Its profiles' UI allowed here goes with it: a machine added again is asked again.
  if (sub === 'rm') { await machines.remove(machine.id); await new UiAllowStore(dataDir).revoke(machine.id) }
  else if (sub === 'enable' || sub === 'disable') await machines.update(machine.id, { enabled: sub === 'enable' })
  else if (sub === 'trust') { userOnly(`Trust whoever answers at ${machine.label}`); await machines.forgetIdentity(machine.id) }
  else throw new RpcError('usage', `Unknown: ${app.id} machines ${sub}`)
  print({ ok: true }, () => console.log(`${sub === 'rm' ? 'Removed' : sub === 'trust' ? 'Will trust whoever answers at' : `${sub[0]!.toUpperCase()}${sub.slice(1)}d`} ${machine.label}.`))
}

/**
 * Update the Superego on a machine: its own install script, reached as the machine is, its output passed on as it
 * goes. The script restarts the daemon there, which interrupts agents at work: only with `now`.
 */
async function updateMachine(machine: Machine & { config: MachineConfig }, now: boolean) {
  // One that doesn't answer may still update (a daemon that won't start, say): then there's no work to interrupt.
  const before = await on(machine, async (call, hello) => ({ hello, threads: await call('thread.list', {}) }), { deadline: PROBE }).catch(() => undefined)
  const working = before?.threads.filter((t) => t.status.state === 'working') ?? []
  if (working.length && !now) {
    throw new RpcError('busy', `${working.length === 1 ? 'An agent is' : `${working.length} agents are`} working on ${machine.label}, and updating restarts its daemon.`, {
      hint: `Wait for them, or: ${app.id} machines update ${machine.label} --now (they resume after the restart).`,
    })
  }
  await runUpdate(machine.config, app, { now, onOutput: (text) => process.stderr.write(text) })
  const after = await on(machine, async (_call, hello) => hello)
  const short = (commit?: string) => commit?.slice(0, 7) ?? 'unknown'
  print({ updated: true, from: before && versionOf(before.hello), to: versionOf(after) }, () =>
    console.log(`Updated ${machine.label}: ${short(before?.hello.machine.commit)} → ${short(after.machine.commit)}, daemon ${after.machine.pid}.`))
}

/** Run this checkout's install script, as `<id> machines update` asks through a machine's `via` command. */
function updateHere(now: boolean) {
  const child = spawn('/bin/sh', ['-c', updateScript({ dir: resolve(options.appDir, '..') }, now)], { stdio: 'inherit' })
  child.once('close', (code) => process.exit(code ?? 1))
}

/** A value from the command line: JSON when it parses, else the text itself. */
const parseValue = (text: string): Json => { try { return JSON.parse(text) } catch { return text } }

async function settingsCommand(sub: string | undefined, rest: string[], options: { machine?: string; all?: boolean }) {
  const targets = options.all ? [{ id: 'local', label: 'This computer' }, ...machines.list().filter((m) => m.enabled).map((config) => ({ id: config.id, label: config.label, config }))]
    : [resolveMachine(options.machine)]
  if (!sub) {
    if (options.all) throw new RpcError('usage', '--all is for set and reset')
    const snapshot = await on(targets[0]!, (call) => call('settings.watch', {}).then((r) => r.value)) as SettingsSnapshot
    return print(snapshot, () => {
      for (const section of snapshot.sections) {
        const settings = section.settings.filter((s) => !s.hidden)
        if (!settings.length) continue
        console.log(`${section.title}`)
        table(settings.map((s) => ['  ' + s.key, shownValue(s, snapshot.values[s.key]), s.type === 'choice' && s.options.length <= 8 ? s.options.map((o) => o.value).join(' | ') : s.title]))
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

/** A setting's value as `settings` lists it: a secret only as whether it's set (a snapshot has no more of it). */
const shownValue = (setting: SettingInfo, value: Json | undefined) => setting.type === 'secret' ? (value === true ? 'set' : 'not set') : JSON.stringify(value ?? null)

/**
 * `secrets`: extensions' secret settings, listed (whether each is set), set (asked for without echo, or from stdin) or
 * cleared. Setting and clearing are the user's consent: refused here before asking, when an agent runs this.
 */
async function secretsCommand(sub: string | undefined, rest: string[], machineName: string | undefined) {
  const machine = resolveMachine(machineName)
  if (!sub) {
    const snapshot = await on(machine, (call) => call('settings.watch', {}).then((r) => r.value))
    const secrets = snapshot.sections.flatMap((section) => section.settings.filter((s) => s.type === 'secret').map((s) => ({ key: s.key, title: s.title, section: section.title, set: snapshot.values[s.key] === true })))
    return print(secrets, () => {
      if (!secrets.length) return console.log(`No extension on ${machine.label} asks for a secret now.`)
      table(secrets.map((s) => [s.key, s.set ? 'set' : 'not set', `${s.section}: ${s.title}`]))
    })
  }
  const key = rest[0]
  if ((sub !== 'set' && sub !== 'clear') || !key) throw new RpcError('usage', `${app.id} secrets [set|clear] <key>`)
  userOnly('Set a secret')
  let value: string | null = null
  if (sub === 'set') {
    // Known before asking for it: a typo, or an extension not set up yet, isn't found out after the secret is typed.
    const setting = await on(machine, (call) => call('settings.watch', {}).then((r) => r.value.sections.flatMap((s) => s.settings).find((s) => s.key === key)))
    if (!setting) throw new RpcError('unknown_setting', `No secret ${key} on ${machine.label}`, { hint: `Its extension declares it once it's set up. See: ${app.id} secrets` })
    if (setting.type !== 'secret') throw new RpcError('invalid_setting', `${key} isn't a secret: ${app.id} settings set ${key} <value>`)
    value = await readSecret(`${setting.title} (${key}): `)
    if (!value) throw new RpcError('usage', 'Nothing given: no secret was set')
  }
  await on(machine, (call) => call('action.run', { id: 'secrets.set', params: { key, value }, exposure: 'cli' }))
  return print({ key, set: value !== null }, () => console.log(`${machine.label}: ${key} ${value === null ? 'cleared' : 'set'}`))
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

/** How a provider is signed in, in a few words. */
const signedIn = (p: ProviderAuthInfo) => p.auth ? `${p.auth.type === 'oauth' ? 'signed in' : 'api key'}${p.auth.source ? ` (${p.auth.source})` : ''}` : 'not signed in'

async function providersCommand(sub: string | undefined, rest: string[], machineName: string | undefined, values: { name?: string; 'base-url'?: string; key?: string; model?: string[] }) {
  const machine = resolveMachine(machineName)
  if (!sub) {
    const { snapshot, rejected } = await on(machine, async (call) => ({ snapshot: await call('settings.watch', {}).then((r) => r.value), rejected: await rejectedOn(call) }))
    const providers = (snapshot.sections.find((s) => s.id === 'providers')?.data ?? []) as ProviderAuthInfo[]
    // Signed in first, then the rest; each part by name.
    const sorted = [...providers].sort((a, b) => Number(!a.auth) - Number(!b.auth) || a.name.localeCompare(b.name))
    const listed = sorted.map((p) => ({ ...p, ...(rejected.some((r) => r.provider === p.id) ? { rejected: rejected.find((r) => r.provider === p.id) } : {}) }))
    return print(listed, () => {
      table(listed.map((p) => [p.id, signedIn(p) + (p.rejected ? ' · rejected' : ''), `${p.models} model${p.models === 1 ? '' : 's'}`]))
      sayRejected(rejected, machine)
    })
  }
  if (sub === 'retry') {
    const { retried } = await on(machine, (call) => call('action.run', { id: 'auth.retry', params: rest[0] ? { provider: rest[0] } : {}, exposure: 'cli' })) as { retried: number }
    return print({ retried }, () => console.log(retried ? `Retrying ${retried} thread${retried === 1 ? '' : 's'} on ${machine.label}.` : `Nothing waits for sign-in on ${machine.label}.`))
  }
  if (sub === 'add') {
    if (!values.name || !values['base-url']) throw new RpcError('usage', `${app.id} providers add --name <name> --base-url <url> [--key -] [--model <id>...]`)
    const key = values.key === undefined ? undefined : values.key === '-' ? await readSecret(`API key for ${values.name}: `) : values.key
    const { id } = await on(machine, (call) => call('providers.save', { name: values.name!, baseUrl: values['base-url']!, ...(key ? { key } : {}), ...(values.model?.length ? { models: values.model } : {}) }))
    const added = await on(machine, (call) => call('settings.watch', {})).then((r) => (r.value.sections.find((s) => s.id === 'providers')?.data as ProviderAuthInfo[] | undefined)?.find((p) => p.id === id))
    return print({ id, models: added?.custom?.models ?? [] }, () => console.log(`Added ${values.name} (${id}) on ${machine.label}, with ${added?.custom?.models.length ?? 0} models: ${added?.custom?.models.join(', ') ?? ''}`))
  }
  const provider = rest[0]
  if (!provider) throw new RpcError('usage', `${app.id} providers ${sub} <provider>`)
  if (sub === 'sign-out') {
    await on(machine, (call) => call('auth.signOut', { provider }))
    return print({ ok: true }, () => console.log(`Signed out of ${provider} on ${machine.label}.`))
  }
  if (sub === 'remove') {
    await on(machine, (call) => call('providers.remove', { provider }))
    return print({ ok: true }, () => console.log(`Removed ${provider} from ${machine.label}.`))
  }
  if (sub !== 'key') throw new RpcError('usage', `Unknown: ${app.id} providers ${sub}. Sign in with a browser from the app's Settings.`)
  const info = await on(machine, (call) => call('settings.watch', {})).then((r) => (r.value.sections.find((s) => s.id === 'providers')?.data as ProviderAuthInfo[] | undefined)?.find((p) => p.id === provider))
  if (!info) throw new RpcError('not_found', `No provider ${provider} on ${machine.label}`, { hint: `See: ${app.id} providers` })
  // A provider that asks for more than its key (Bedrock's way to sign in, Azure's resource) asks each thing as it goes.
  const key = info.keyFlow ? undefined : await readSecret(`API key for ${provider}: `)
  if (!info.keyFlow && !key) throw new RpcError('usage', 'No key given')
  if (info.keyFlow && !process.stdin.isTTY) throw new RpcError('usage', `${info.name} asks more than a key as it's signed in to: run this in a terminal, or sign in from the app's Settings → Providers`)
  // Sign in on that machine and wait for it to say how it went.
  const { transport } = await connect(machine)
  try {
    const outcome = new Promise<AuthEvent>((done) => transport.peer.on('auth.event', ({ flow, event }: { flow: string; event: AuthEvent }) => {
      if (event.type === 'done' || event.type === 'failed') done(event)
      else if (event.type === 'info') console.log(event.message + (event.links?.length ? ` ${event.links.map((l) => l.url).join(' ')}` : ''))
      else if (event.type === 'prompt') void answer(event.prompt).then((value) => transport.peer.call('auth.respond', { flow, prompt: event.id, value }))
        .catch((error: Error) => { console.error(error.message); void transport.peer.call('auth.cancel', { flow }) })
    }))
    await transport.peer.call('auth.signIn', { provider, type: 'api_key', ...(key ? { key } : {}) })
    // A flow that asks waits on the user; one given just a key answers at once.
    const event = info.keyFlow ? await outcome : await within(outcome, 30_000, () => new RpcError('timeout', `${machine.label} did not say how signing in went in 30s`))
    if (event.type === 'failed') throw new RpcError('auth_failed', event.message)
  } finally {
    transport.close()
  }
  return print({ ok: true }, () => console.log(`Signed in to ${info.name} on ${machine.label}.`))
}

/** Ask what a sign-in flow asks, in the terminal: a choice by its number, else the text (a secret unechoed). */
async function answer(prompt: AuthPrompt): Promise<string> {
  if (prompt.type !== 'select') return prompt.type === 'secret' ? readSecret(`${prompt.message}: `) : readLine(`${prompt.message}${prompt.placeholder ? ` (${prompt.placeholder})` : ''}: `)
  prompt.options.forEach((option, i) => console.log(`  ${i + 1}. ${option.label}${option.description ? ` (${option.description})` : ''}`))
  for (;;) {
    const picked = prompt.options[Number(await readLine(`${prompt.message} [1-${prompt.options.length}]: `)) - 1]
    if (picked) return picked.id
  }
}

/** A line typed in the terminal, echoed. */
function readLine(prompt: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  return new Promise((done) => rl.question(prompt, (line) => { rl.close(); done(line.trim()) }))
}

async function modelsCommand(sub: string | undefined, rest: string[], machineName?: string) {
  const machine = resolveMachine(machineName)
  const catalog = await on(machine, (call) => call('agent.models', {}))
  const favourites = catalog.favourites ?? []
  if (!sub) {
    const starred = new Set(favourites.map((f) => f.value))
    type Listed = { value: string; label: string; group: string; favourite: boolean; unavailable?: string }
    const listed: Listed[] = [
      ...favourites.map((f) => ({ ...f, favourite: true })),
      ...catalog.models.filter((m) => !starred.has(m.value)).map((m) => ({ value: m.value, label: m.label, group: m.group, favourite: false })),
    ]
    return print(listed, () => table(listed.map((m) => [
      `${m.favourite ? '★' : ' '} ${m.value}`, m.label, m.unavailable ?? (m.value === catalog.default.model ? 'default' : ''),
    ])))
  }
  const model = rest[0]
  if ((sub !== 'favourite' && sub !== 'unfavourite') || !model) throw new RpcError('usage', `${app.id} models favourite|unfavourite <provider/model>`)
  const values = favourites.map((f) => f.value)
  if (sub === 'favourite' && !values.includes(model) && !catalog.models.some((m) => m.value === model)) {
    throw new RpcError('not_found', `No model ${model} among ${machine.label}'s signed-in providers`, { hint: `See: ${app.id} models` })
  }
  const next = sub === 'favourite' ? [...values.filter((v) => v !== model), model] : values.filter((v) => v !== model)
  await on(machine, (call) => call('settings.set', { key: 'agent.favourites', value: next }))
  return print({ favourites: next }, () => console.log(sub === 'favourite' ? `Starred ${model} on ${machine.label}.` : `Unstarred ${model} on ${machine.label}.`))
}

async function daemonCommand(sub: string | undefined, now: boolean) {
  // The app's own daemon entry (Superego's sets up its bundled extensions); without one, a plain daemon: the core only,
  // as this package knows no app's extensions.
  if (!sub) return options.daemon ? void await import(pathToFileURL(options.daemon).href) : (await import('@superego/daemon')).serveDaemon({ app, dataDir, socket, reach: (dir, self) => machineHub({ app, dataDir: dir, self }) })
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
    await gone(pid)
    return print({ stopped: true, pid }, () => console.log(`Stopped daemon ${pid}. Running agents stop with it.`))
  }
  if (sub === 'restart') {
    if (!running) {
      // Connecting starts it.
      const hello = await on(local, async (_call, hello) => hello)
      return print({ restarted: true, build: hello.machine.build }, () => console.log(`Started daemon ${hello.machine.pid}, build ${hello.machine.build}.`))
    }
    const before = await on(local, async (call, hello) => {
      // This shell's environment goes along, as it would to a daemon this started: keys from `box run`, say. Only what is
      // set, so a restart adds and never takes away.
      const env = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => Boolean(e[1])))
      const result = await call('daemon.restart', { build: hello.machine.build, interrupt: now, env })
      if (!result.restarted) {
        throw new RpcError('busy', 'Agents are working, so the daemon was not restarted.', { hint: `Wait for them, or: ${app.id} daemon restart --now (they resume after the restart).` })
      }
      return hello
    })
    await gone(before.machine.pid)
    const after = await on(local, async (_call, hello) => hello)
    return print({ restarted: true, from: before.machine.build, build: after.machine.build }, () =>
      console.log(`Restarted: build ${before.machine.build} → ${after.machine.build}, pid ${after.machine.pid}.`))
  }
  if (sub === 'install') {
    const { command, env } = installedDaemon()
    const installed = installService({ app }, {
      command, log: join(dataDir, 'daemon.log'), ...(env.ELECTRON_RUN_AS_NODE ? { env: { ELECTRON_RUN_AS_NODE: env.ELECTRON_RUN_AS_NODE } } : {}),
    })
    // A daemon already running (started on demand) is handed over to the service, unless agents are working in it.
    let handover = 'It starts with the next connection.'
    if (running) {
      handover = await daemonCommand('restart', false).then(() => 'The running daemon now runs under it.', (error: unknown) =>
        error instanceof RpcError && error.kind === 'busy' ? `Agents are working, so the running daemon is not under it yet: ${app.id} daemon restart` : Promise.reject(error))
    } else if (!startService({ app })) handover = `Could not start it now; ${app.id} connect --start will.`
    return print({ ...installed, handover }, () => {
      console.log(`Installed the ${installed.kind} service ${installed.file}. ${handover}`)
      if (installed.lingering === true) console.log('Lingering is on: it starts at boot and keeps running after you log out.')
      for (const note of installed.notes) console.log(note)
    })
  }
  if (sub === 'uninstall') {
    const removed = uninstallService({ app })
    return print({ removed }, () => console.log(removed ? 'Removed the service, and stopped the daemon it ran.' : 'No service is installed.'))
  }
  throw new RpcError('usage', `Unknown: ${app.id} daemon ${sub}`)
}

/** Until the daemon `pid` has exited (one that won't is given a minute). */
async function gone(pid: number) {
  const alive = () => { try { process.kill(pid, 0); return true } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM' } }
  for (const end = Date.now() + 60_000; alive() && Date.now() < end;) await new Promise((done) => setTimeout(done, 100))
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
import { defineProfile } from 'superego'

export default defineProfile({
  description: '',
  // model: 'anthropic/claude-sonnet-4-5',
  // thinking: 'medium',
  // prompt: 'You work on this project. …',
  // extensions: ['./extensions/example.ts'],   // agent parts: tools, prompt sections, hooks
  // without: ['agent-ui'],                       // built-ins this profile does without
  // extends: 'user:default',                     // start from your own profile of that name
})
`

/**
 * Types for profiles that are there already: each of this project's (and with `--user`, yours), or the one named. A
 * project's profile allowed as it was is allowed again: what changed is only the tsconfig.json written here.
 */
async function profileTypesCommand(name: string | undefined, values: { machine?: string; user?: boolean }, run: (id: string, params: Record<string, unknown>) => Promise<unknown>) {
  if (resolveMachine(values.machine).config) throw new RpcError('usage', `${app.id} profile types sets up profiles here; on another machine, run it there`)
  const list = (await run('profile.list', { cwd: process.cwd(), ...(values.user ? { user: true } : {}) }) as ProfileInfo[])
    .filter((p) => (values.user ? p.scope === 'user' : p.scope === 'project') && (!name || p.name === name))
  if (!list.length) {
    const where = values.user ? `yours (${join(dataDir, 'profiles')}, or a profile source's)` : 'this project'
    throw new RpcError('not_found', name ? `No profile ${name} in ${where}` : `No profiles in ${where}. Make one: ${app.id} profile new${values.user ? ' --user' : ''}`)
  }
  const typesDir = await authorTypes(dataDir, options.types)
  const done: (ProfileTypes & { name: string; dir: string })[] = []
  for (const profile of list) {
    const types = setUpProfileTypes(profile.dir, typesDir)
    if (profile.scope === 'project' && profile.allowed && !agentThread() && types.written.some((file) => file.endsWith('tsconfig.json'))) await run('profile.allow', { cwd: process.cwd(), name: profile.name })
    done.push({ name: profile.name, dir: profile.dir, ...types })
  }
  return print(done, () => {
    for (const profile of done) {
      console.log(`${profile.name} (${profile.dir}): ${profile.written.length ? `wrote ${profile.written.map((file) => file.slice(profile.dir.length + 1)).join(', ')}` : 'had its types already'}`)
      for (const note of profile.notes) console.log(`  ${note}`)
    }
    console.log(`Types: ${typesDir}`)
  })
}

async function profileCommand(sub: string | undefined, rest: string[], values: { machine?: string; user?: boolean }) {
  const machine = resolveMachine(values.machine)
  const run = (id: string, params: Record<string, unknown>) => on(machine, (call) => call('action.run', { id, params, exposure: 'cli' }))
  const cwd = machine.config ? undefined : process.cwd()
  if (!sub) {
    const list = await run('profile.list', cwd ? { cwd } : {}) as ProfileInfo[]
    return print(list, () => {
      if (!list.length) return console.log(`No profiles here. Make one: ${app.id} profile new`)
      table(list.map((p) => [p.name, whoseProfile(p), p.allowed ? '' : 'not allowed', p.dir]))
      for (const p of list) for (const problem of p.problems ?? []) console.log(`${p.name}: ${problem}`)
    })
  }
  if (sub === 'sources') {
    const sources = await run('profile.sources', {}) as ProfileSourceInfo[]
    return print(sources, () => {
      if (!sources.length) return console.log(`No profile sources. Add one: ${app.id} profile install git:<host>/<owner>/<repo>, or a folder`)
      for (const s of sources) {
        const state = s.state === 'ready' ? '' : s.state === 'not-cloned' ? `not cloned (${app.id} profile update)` : s.state === 'missing' ? 'missing' : 'no profiles/ folder'
        console.log([s.source, state, s.commit ?? '', s.dir].filter(Boolean).join('  '))
        for (const p of s.profiles) console.log(`  ${p.name}${p.shadowedBy ? `  shadowed by ${p.shadowedBy}` : ''}`)
      }
    })
  }
  if (sub === 'install' || sub === 'remove') {
    if (!rest[0]) throw new RpcError('usage', `${app.id} profile ${sub} <git:host/owner/repo[@ref] | folder>`)
    const source = machine.config ? rest[0] : sourceHere(rest[0])
    if (sub === 'remove') {
      const removed = await run('profile.remove', { source }) as { source: string; dir: string; deleted: boolean }
      return print(removed, () => console.log(`Removed ${removed.source}${removed.deleted ? `, and its clone (${removed.dir})` : ''}`))
    }
    const installed = await run('profile.install', { source }) as { source: ProfileSourceInfo; changed: boolean }
    return print(installed, () => {
      const { source: s } = installed
      console.log(`${installed.changed ? 'Installed' : 'Had'} ${s.source} (${s.dir})${s.profiles.length ? `: ${s.profiles.map((p) => p.name).join(', ')}` : ', with no profiles yet'}`)
      for (const p of s.profiles) if (p.shadowedBy) console.log(`  ${p.name} is shadowed by ${p.shadowedBy}, and isn't used`)
    })
  }
  if (sub === 'update') {
    const results = await run('profile.update', rest[0] ? { source: machine.config ? rest[0] : sourceHere(rest[0]) } : {}) as { source: string; result: string; from?: string; to?: string; error?: string }[]
    if (results.some((r) => r.result === 'failed')) process.exitCode = 1
    return print(results, () => {
      if (!results.length) return console.log('No profile sources to update')
      table(results.map((r) => [r.source, r.result === 'updated' ? `updated ${r.from}..${r.to}` : r.result === 'local' ? 'a folder: read in place' : r.result === 'pinned' ? 'pinned' : r.result === 'failed' ? `failed: ${r.error}` : r.result]))
    })
  }
  if (sub === 'new') {
    if (machine.config) throw new RpcError('usage', `${app.id} profile new makes a profile here; on ${machine.label}, run it there`)
    const name = rest[0] ?? 'default'
    if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) throw new RpcError('usage', 'A profile name is lowercase letters, digits and dashes')
    const dir = values.user ? join(dataDir, 'profiles', name) : join(process.cwd(), '.superego', 'profiles', name)
    if (existsSync(join(dir, 'profile.ts'))) throw new RpcError('exists', `${join(dir, 'profile.ts')} is there already (types for it: ${app.id} profile types ${name}${values.user ? ' --user' : ''})`)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'profile.ts'), PROFILE_TEMPLATE(name))
    const types = setUpProfileTypes(dir, await authorTypes(dataDir, options.types))
    // You wrote it, so it may run; an agent's waits for the user's Allow.
    const allowed = !values.user && !agentThread()
    if (allowed) await run('profile.allow', { cwd: process.cwd(), name })
    return print({ name, dir, ...types }, () => {
      console.log(`Made ${join(dir, 'profile.ts')}, with types for an editor (tsconfig.json; node_modules links to ${join(dataDir, 'types')})`)
      for (const note of types.notes) console.log(`  ${note}`)
      if (!values.user && !allowed) console.log(waitsForUser(name))
    })
  }
  if (sub === 'types') return profileTypesCommand(rest[0], values, run)
  if (sub === 'allow') {
    const allowed = await run('profile.allow', { ...(cwd ? { cwd } : {}), ...(rest[0] ? { name: rest[0] } : {}) }) as ProfileInfo
    return print(allowed, () => console.log(`Allowed ${allowed.name} (${allowed.dir}) as it is now`))
  }
  if (sub === 'allow-ui' || sub === 'revoke-ui') return profileUiCommand(sub, machine, rest[0])
  throw new RpcError('usage', `Unknown: ${app.id} profile ${sub}`)
}

/** A source as given here: a folder as a path from here made absolute (the daemon has no "here"); git ones and `~/…` as they are. */
const sourceHere = (source: string) => /^(git:|https?:\/\/|~(\/|$))/.test(source) || isAbsolute(source) ? source : resolve(source)

/** Whose a profile is, in a word: the project's, yours, or yours from a profile source. */
const whoseProfile = (p: ProfileRef) => p.scope === 'project' ? 'project' : p.source ? `yours, from ${p.source}` : 'yours'

/** What an agent that made or changed a project's profile tells the user: it runs once they allow it. */
const waitsForUser = (name: string) =>
  `${name} is a project's profile, so it runs only once the user allows it, as it is then: in the window (Settings → Profiles, or Allow where a thread asks), or with ${app.id} profile allow ${name} in their own terminal. Allowing is theirs to do, not an agent's.`

/** A profile `extension …` acts on, and why that one: named with -P, the one whose folder you're in, or the folder's default. */
type Chosen = ProfileRef & { by: 'name' | 'folder' | 'default' }

const realPath = (path: string) => { try { return realpathSync(path) } catch { return resolve(path) } }
const scopeOf = (p: ProfileRef) => p.scope === 'project' ? "this project's" : whoseProfile(p)

/** Where `extension …` says which profile it acts on, and how to pick another. */
const sayProfile = (p: Chosen) => `Profile ${p.name} (${scopeOf(p)}, ${p.dir})${
  p.by === 'folder' ? ": the one you're in" : p.by === 'default' ? ": the folder's default" : ''}${p.by === 'name' ? '' : `. Another: -P <name>${p.scope === 'user' ? ' --user' : ''}`}`

/**
 * The profile `extension …` acts on: the one `-P` names (with `--user`, yours), else the one whose folder holds the
 * working directory, else the one a thread here starts with (the project's default before yours). `make`: one to make
 * an extension in, which may not be there yet (the project's default, unless named otherwise or you're in another).
 */
async function profileHere(values: { profile?: string; user?: boolean }, command: string, make = false): Promise<Chosen> {
  const here = realPath(process.cwd())
  const inside = (dir: string) => { const at = relative(realPath(dir), here); return !at.startsWith('..') && !isAbsolute(at) }
  const profiles = (params: Record<string, unknown>) => on(resolveMachine(undefined), (call) => call('action.run', { id: 'profile.list', params: { cwd: process.cwd(), ...params }, exposure: 'cli' })) as Promise<ProfileInfo[]>
  // Yours, wherever they are (~/.superego/profiles, or a profile source's), those shadowed by another of their name too.
  const mine = await profiles({ user: true })
  const chosen = (p: ProfileRef, by: Chosen['by']): Chosen => ({ scope: p.scope, name: p.name, dir: p.dir, ...(p.source ? { source: p.source } : {}), by })
  // Yours of that name (the one used), else where a new one of yours goes.
  const yours = (name: string, by: Chosen['by']): Chosen => {
    const found = mine.find((p) => p.name === name)
    return found ? chosen(found, by) : { scope: 'user', name, dir: join(dataDir, 'profiles', name), by }
  }
  // Yours you're in, a project's of that name or not.
  const yoursHere = mine.filter((p) => inside(p.dir)).sort((a, b) => b.dir.length - a.dir.length)[0]
  const exists = (p: ProfileRef) => existsSync(join(p.dir, 'profile.ts'))
  if (values.user || (yoursHere && !values.profile)) {
    const picked = values.profile ? yours(values.profile, 'name') : yoursHere ? chosen(yoursHere, 'folder') : yours('default', 'default')
    if (make || exists(picked)) return picked
  }
  const list = await profiles({})
  if (!values.user) {
    if (values.profile) {
      const found = list.find((p) => p.name === values.profile && p.scope === 'project') ?? (make ? undefined : list.find((p) => p.name === values.profile))
      if (found) return chosen(found, 'name')
      if (make) return { scope: 'project', name: values.profile, dir: join(process.cwd(), '.superego', 'profiles', values.profile), by: 'name' }
    } else {
      // The innermost one you're in.
      const enclosing = list.filter((p) => inside(p.dir)).sort((a, b) => b.dir.length - a.dir.length)[0]
      if (enclosing) return chosen(enclosing, 'folder')
      const fallback = list.find((p) => p.name === 'default' && (!make || p.scope === 'project'))
      if (fallback) return chosen(fallback, 'default')
      if (make) return { scope: 'project', name: 'default', dir: join(process.cwd(), '.superego', 'profiles', 'default'), by: 'default' }
    }
  }
  // Which, then? The ones there are, and how to pick one.
  const wanted = values.profile ?? 'default'
  const missing = values.user ? `You have no profile ${wanted} (in ${join(dataDir, 'profiles')}, or a profile source)`
    : values.profile ? `No profile ${wanted} here or of yours` : `${here} isn't in a profile's folder, and has no default profile`
  if (!list.length) throw new RpcError('not_found', `There are no profiles here or of yours.`, { hint: `Make one: ${app.id} extension new <name> --user` })
  const width = Math.max(...list.map((p) => p.name.length))
  const listed = list.map((p) => `  ${p.name.padEnd(width)}  ${p.scope === 'project' ? 'project' : 'yours  '}  ${p.dir}`).join('\n')
  throw new RpcError('not_found', `${missing}. The profiles here:\n${listed}`, {
    hint: `Pick one: ${app.id} extension ${command} -P <name> (yours: -P <name> --user), or run it in the profile's folder.`,
  })
}

/** `extensions`: what each extension on a machine is and does (inspect.ts), with `--thread`, what that thread goes without. */
async function extensionsCommand(values: { machine?: string; thread?: string }) {
  const machine = resolveMachine(values.machine)
  const report = await on(machine, (call) => call('extension.inspect', values.thread ? { thread: values.thread } : {}))
  return print(report, () => console.log(formatReport(report, machine.label, app.id)))
}

async function extensionCommand(sub: string | undefined, rest: string[], values: { profile?: string; user?: boolean; ui?: boolean; tool?: boolean; badge?: boolean; machine?: string; timeout?: string }) {
  if (sub === 'new') {
    const name = rest[0]
    if (!name) throw new RpcError('usage', `${app.id} extension new <name> [--tool] [--ui] [--badge] [-P profile] [--user]`)
    const kind = starterKind(values)
    const profile = await profileHere(values, 'new', true)
    const { dir } = profile
    const { written, madeProfile, missing, notes } = newExtension(dir, name, kind, await authorTypes(dataDir, options.types))
    // You wrote it, so it may run: a project's profile is allowed as it is now. An agent's waits for the user's Allow.
    const project = profile.scope === 'project'
    if (project && !agentThread()) await on(resolveMachine(undefined), (call) => call('action.run', { id: 'profile.allow', params: { cwd: dir, name: profile.name }, exposure: 'cli' }))
    return print({ dir, written, madeProfile, missing }, () => {
      console.log(`Made ${name} (${KIND_SAYS[kind]}) in ${dir}${madeProfile ? ', a new profile' : ''}:`)
      for (const file of written) console.log(`  ${file}`)
      if (missing.length) console.log(`Add to its profile.ts's defineProfile({ … }): ${missing.join(', ')}`)
      for (const note of notes) console.log(note)
      const pick = `${profile.by === 'name' || profile.name !== 'default' ? ` -P ${profile.name}` : ''}${project ? '' : ' --user'}`
      console.log(`\nNext: ${app.id} extension test ${name}${pick}, then send one of the profile's threads a message.`)
      if (project && agentThread()) console.log(waitsForUser(profile.name))
      else if (project) console.log(`After you edit it: ${app.id} profile allow ${profile.name} (a project's profile runs as it was allowed).`)
    })
  }
  if (sub === 'test') {
    if (resolveMachine(values.machine).config) throw new RpcError('usage', `${app.id} extension test runs here; on another machine, run it there`)
    const profile = await profileHere(values, 'test')
    // An extension (its folder) or a test file: in the profile, or from here.
    const target = rest[0] ? [resolve(rest[0]), join(profile.dir, rest[0])].find((at) => existsSync(at) && !relative(realPath(profile.dir), realPath(at)).startsWith('..')) : undefined
    if (rest[0] && !target) throw new RpcError('not_found', `No extension or test file ${rest[0]} in ${profile.name} (${profile.dir})`)
    const timeout = values.timeout === undefined ? undefined : Number(values.timeout)
    if (timeout !== undefined && !(timeout > 0)) throw new RpcError('usage', '--timeout is in seconds: a number above 0')
    console.log(sayProfile(profile))
    process.exitCode = await testExtension(profile.dir, target, await authorTypes(dataDir, options.types), { built: options.authorTest, ...(timeout ? { timeout } : {}) })
    return
  }
  if (sub === 'reload') {
    const machine = resolveMachine(values.machine)
    // Here: the profile as `test` picks it, by its own folder. Elsewhere: by name, as a thread in its default folder would.
    const profile = machine.config ? undefined : await profileHere(values, 'reload')
    const params = profile ? { cwd: profile.dir, name: profile.name } : { name: values.profile ?? 'default' }
    const ref = await on(machine, (call) => call('action.run', { id: 'profile.reload', params, exposure: 'cli' })) as ProfileRef
    return print(ref, () => console.log(profile ? `${sayProfile(profile)}\nLoaded it again` : `Loaded ${ref.name} (${ref.dir}) again`))
  }
  throw new RpcError('usage', sub ? `Unknown: ${app.id} extension ${sub}` : `${app.id} extension new|test|reload; the extensions there are: ${app.id} extensions`)
}

/**
 * Let another machine's profile UI run in this computer's window, or stop it: allowed for a hash of exactly the
 * sources fetched here now, as the app does (ui-allowed.json, shared with it). This computer's own run on its daemon's say.
 */
async function profileUiCommand(sub: 'allow-ui' | 'revoke-ui', machine: Machine, which: string | undefined) {
  if (sub === 'allow-ui') userOnly(`Let a profile's UI from ${machine.label} run in this window`)
  if (!machine.config) throw new RpcError('usage', `This computer's profiles run on its daemon's say: ${app.id} profile allow. Name another machine: -m <machine>`)
  if (!which) throw new RpcError('usage', `${app.id} profile ${sub} <name|dir> -m <machine>`)
  const store = new UiAllowStore(dataDir)
  if (sub === 'revoke-ui') {
    const found = store.list().filter((a) => a.machine === machine.id && (a.profile.name === which || a.profile.dir === which))
    if (!found.length) throw new RpcError('not_found', `No UI of a profile ${which} from ${machine.label} is allowed here`)
    for (const a of found) await store.revoke(machine.id, a.profile.dir)
    return print({ revoked: found.map((a) => a.profile) }, () => console.log(`${found.map((a) => a.profile.name).join(', ')}'s UI from ${machine.label} no longer runs here`))
  }
  const allowed = await on(machine, async (call) => {
    // Its profiles: yours there, and any its threads started with (a project's).
    const refs = new Map<string, ProfileRef>()
    for (const p of await call('action.run', { id: 'profile.list', params: {}, exposure: 'cli' }) as ProfileInfo[]) refs.set(p.dir, { scope: p.scope, name: p.name, dir: p.dir })
    for (const t of await call('thread.list', {})) if (t.profile) refs.set(t.profile.dir, t.profile)
    const matches = [...refs.values()].filter((p) => p.name === which || p.dir === which)
    if (matches.length > 1) throw new RpcError('ambiguous', `More than one profile ${which} on ${machine.label}; name its folder:\n${matches.map((p) => `  ${p.dir}`).join('\n')}`)
    const profile = matches[0]
    if (!profile) throw new RpcError('not_found', `No profile ${which} on ${machine.label}`)
    const { entries } = await call('profile.ui', profile)
    if (!entries.length) throw new RpcError('invalid', `${profile.name} on ${machine.label} has no UI`)
    const sources = await collectProfileUi(entries, (path) => call('profile.module', { ...profile, path }))
    return { machine: machine.id, profile, hash: await hashProfileUi(sources), files: filesOf(sources) }
  })
  await store.allow(allowed)
  const size = allowed.files.reduce((sum, f) => sum + f.size, 0)
  print(allowed, () => console.log(`Allowed ${allowed.profile.name}'s UI from ${machine.label} (${allowed.files.length} file${allowed.files.length === 1 ? '' : 's'}, ${size} bytes) as it is now`))
}

// ── Web access ──────────────────────────────────────────────────────────────────────────────────────────────────────

const ago = (time: number) => {
  const minutes = Math.floor((Date.now() - time) / 60_000)
  return minutes < 1 ? 'just now' : minutes < 60 ? `${minutes} min ago` : minutes < 48 * 60 ? `${Math.floor(minutes / 60)} h ago` : `${Math.floor(minutes / 1440)} days ago`
}

async function webCommand(sub: string | undefined, rest: string[], values: { machine?: string }) {
  const machine = resolveMachine(values.machine)
  const run = (id: string, params: Record<string, unknown> = {}) => on(machine, (call) => call('action.run', { id, params, exposure: 'cli' }))
  if (sub === 'pair') {
    const ticket = await run('web.pair') as { link: string; code: string; expires: number }
    return print(ticket, () => {
      if (process.stdout.isTTY) console.log(renderUnicodeCompact(ticket.link, { border: 2 }))
      console.log(`Open ${ticket.link}`)
      console.log(`or enter ${ticket.code} on the device. Works once, for 5 minutes.`)
    })
  }
  if (sub === 'devices') {
    const devices = await run('web.devices') as { id: string; name: string; lastSeen: number; address: string; tailscale?: true; waiting?: true }[]
    return print(devices, () => {
      if (!devices.length) return console.log(`No devices paired. Pair one: ${app.id} web pair`)
      table(devices.map((d) => [d.id, d.waiting ? `${d.name} (Tailscale, waiting: ${app.id} web approve ${d.id})` : d.tailscale ? `${d.name} (Tailscale)` : d.name, ago(d.lastSeen), d.address]))
    })
  }
  if (sub === 'approve') {
    if (!rest[0]) throw new RpcError('usage', `${app.id} web approve <device>`)
    const device = await run('web.approve', { id: rest[0] }) as { name: string }
    return print(device, () => console.log(`Approved ${device.name}`))
  }
  if (sub === 'revoke') {
    if (!rest[0]) throw new RpcError('usage', `${app.id} web revoke <device>`)
    await run('web.revoke', { id: rest[0] })
    return print({ ok: true }, () => console.log(`Unpaired ${rest[0]}`))
  }
  if (sub === 'rename') {
    if (!rest[0] || !rest[1]) throw new RpcError('usage', `${app.id} web rename <device> <name>`)
    const device = await run('web.rename', { id: rest[0], name: rest.slice(1).join(' ') })
    return print(device, () => console.log(`Renamed ${rest[0]}`))
  }
  throw new RpcError('usage', sub ? `Unknown: ${app.id} web ${sub}` : `${app.id} web pair|devices|approve|revoke|rename`)
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

/** `read`: where a thread stands and its last answer (read.ts, as MCP's thread_read), with `--wait` once it's done working. */
async function readCommand(id: string | undefined, values: { machine?: string; wait?: boolean }) {
  if (!id) throw new RpcError('usage', `${app.id} read <thread> [--wait]`)
  const machine = resolveMachine(values.machine)
  const read = await on(machine, (call, hello) => readThread((method, params) => call(method as MethodName, params as never) as never, hello, id, { wait: Boolean(values.wait), label: machine.label }))
  print(read, () => {
    const { thread, answer } = read
    // Its status, but when it's done: that's the start of its answer.
    console.log(`${STATUS_WORDS[statusShape({ state: thread.state, ...(thread.kind ? { kind: thread.kind } : {}) })]}${thread.status && thread.state !== 'done' ? `: ${thread.status}` : ''} · ${thread.title || '(untitled)'}`)
    console.log(answer ? `\n${answer}` : '\n(No answer yet)')
  })
  // It stopped on an error: say so to a script.
  if (read.thread.state === 'error') process.exitCode = 1
}

/** `mcp`: an MCP server on stdio for one machine (mcp.ts), loaded only for this command. */
async function mcpCommand(name: string | undefined) {
  const machine = resolveMachine(name)
  const { serveMcp } = await import('./mcp.ts')
  await serveMcp({ app, label: machine.config ? machine.label : 'this computer', connect: (label) => connect(machine, { client: `${app.id}-outside`, label }) })
  process.exit(0)
}

/**
 * The app's layout as text (`layout.json`, which the desktop app keeps beside its settings): its path, then the file,
 * whose head lists the views the window declared and the places each fits.
 */
function layoutCommand() {
  const file = join(dataDir, 'layout.json')
  if (!existsSync(file)) throw new RpcError('not_found', `No ${file} yet: ${app.name}'s window writes it once it's open`)
  const content = readFileSync(file, 'utf8')
  print({ file, content }, () => console.log(`${file}\n\n${content.trimEnd()}`))
}

/** A renderer profile, as the app's `app.profileRenderer` returns it (the app's profile-renderer.ts). */
type RendererProfile = {
  dir: string; seconds: number; summary: string; trace?: string; traceError?: string
  processes: { pid: number; type: string; name: string; cpu: number; memoryMB: number }[]
  windows: {
    window: string; pid: number; error?: string; cpuprofile?: string
    shown?: { machine: string; thread: string }
    page?: { tabs?: { label: string; pane?: string; state: string }[]; nodes?: number; animations?: Record<string, number> }
    metrics?: Record<string, number>
    profile?: { busyPercent: number; functions: { name: string; where: string; percent: number }[]; components: { name: string; where: string; percent: number; inclusivePercent: number }[] }
  }[]
}

/** `app profile`: profile the running app's windows, through its own socket (the app's app-socket.ts). */
async function appCommand(sub: string | undefined, values: { machine?: string; seconds?: string; window?: string; 'no-trace'?: boolean }) {
  if (sub !== 'profile') throw new RpcError('usage', sub ? `Unknown: ${app.id} app ${sub}` : `${app.id} app profile [--seconds 10]`)
  if (resolveMachine(values.machine).config) throw new RpcError('usage', `${app.id} app profile profiles the app on this computer`)
  const seconds = values.seconds === undefined ? 10 : Number(values.seconds)
  if (!(seconds > 0 && seconds <= 300)) throw new RpcError('usage', '--seconds is a number above 0, at most 300')
  const path = appSocketPath(app, dataDir)
  if (!(await isListening(path))) throw new RpcError('no_app', `${app.name} isn't running here, or runs a build from before \`${app.id} app\`: restart it`)
  const { peer, socket } = await connectSocket(path)
  if (!json) console.error(`Profiling for ${seconds} s…`)
  let result: RendererProfile
  try {
    result = await peer.call<RendererProfile>('app.profileRenderer', { seconds, ...(values.window ? { window: values.window } : {}), trace: !values['no-trace'] })
  } finally { socket.destroy() }
  print(result, () => {
    console.log(`Processes (CPU % of one core over ${result.seconds} s):`)
    table(result.processes.filter((p) => p.cpu >= 0.5 || p.type === 'Tab').map((p) => [String(p.pid), `${p.cpu}%`, `${p.memoryMB} MB`, `${p.type}: ${p.name}`]))
    for (const w of result.windows) {
      console.log(`\nWindow ${w.window} (pid ${w.pid})${w.shown ? `: thread ${w.shown.machine}/${w.shown.thread}` : ''}`)
      if (w.error) { console.log(`  Not profiled: ${w.error}`); continue }
      const tabs = w.page?.tabs ?? []
      if (tabs.length) console.log(`  Tabs: ${tabs.map((t) => `${t.label} (${t.state})`).join(', ')}`)
      const animations = Object.entries(w.page?.animations ?? {})
      if (animations.length) console.log(`  Animations: ${animations.map(([what, n]) => `${n}× ${what}`).join('; ')}`)
      const m = w.metrics
      if (m) console.log(`  Main thread busy ${m.taskPercent}% (script ${m.scriptPercent}%, layout ${m.layoutPercent}%, style ${m.stylePercent}%), ${m.layoutsPerSecond} layouts/s, ${m.nodes} nodes`)
      if (w.profile) {
        console.log(`  JS profile busy ${w.profile.busyPercent}%; top functions:`)
        for (const f of w.profile.functions.slice(0, 10)) console.log(`    ${String(f.percent).padStart(5)}%  ${f.name}  ${f.where}`)
        const components = w.profile.components.slice(0, 8)
        if (components.length) console.log('  Components (own % / inclusive %):')
        for (const c of components) console.log(`    ${String(c.percent).padStart(5)}% ${String(c.inclusivePercent).padStart(5)}%  ${c.name}  ${c.where}`)
      }
    }
    console.log(`\nSummary: ${result.summary}`)
    if (result.trace) console.log(`Trace:   ${result.trace}`)
    if (result.traceError) console.log(`No trace: ${result.traceError}`)
  })
}

// ── Dispatch ────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The commands by name, the app's own with the core's (and `help`): set up by `runCli`. */
let COMMANDS: Set<string>
const added = () => options.commands ?? []

async function main() {
  // `do` takes the action's own --params, which parseArgs would refuse.
  const at = process.argv.indexOf('do', 2)
  if (at >= 0 && process.argv.slice(2, at).every((a, i, all) => a === '--json' || a === '-m' || a === '--machine' || all[i - 1] === '-m' || all[i - 1] === '--machine')) {
    if (process.argv.slice(at + 1).some((a) => a === '--help' || a === '-h')) return void process.stdout.write(commandHelp(app, ['do'], added())!)
    return doCommand([...process.argv.slice(2, at), ...process.argv.slice(at + 1)])
  }
  // The core's options, and the app's commands' own (typed as Record: the core's code reads only its own).
  const core = {
    machine: { type: 'string', short: 'm' }, prompt: { type: 'string', short: 'p' }, json: { type: 'boolean' }, profile: { type: 'string', short: 'P' }, worktree: { type: 'boolean', short: 'w' },
    user: { type: 'boolean' }, archived: { type: 'boolean' }, ui: { type: 'boolean' }, tool: { type: 'boolean' }, badge: { type: 'boolean' }, thread: { type: 'string' },
    all: { type: 'boolean' }, name: { type: 'string' }, command: { type: 'string' }, via: { type: 'string' },
    start: { type: 'boolean' }, update: { type: 'boolean' }, now: { type: 'boolean' }, help: { type: 'boolean', short: 'h' }, skill: { type: 'boolean' },
    wait: { type: 'boolean' }, timeout: { type: 'string' }, count: { type: 'boolean' }, seconds: { type: 'string' }, window: { type: 'string' }, 'no-trace': { type: 'boolean' },
    'base-url': { type: 'string' }, key: { type: 'string' }, model: { type: 'string', multiple: true },
  } as const
  const { values, positionals } = parseArgs({ allowPositionals: true, options: Object.assign({}, ...added().map((command) => command.options ?? {}), core) as typeof core })
  json = Boolean(values.json)
  const [first, ...rest] = positionals
  // `<command> --help` and `help <command>`: that command's usage; else all of it.
  if (values.help || first === 'help') {
    const words = first === 'help' ? rest : positionals
    return void process.stdout.write((words[0] && COMMANDS.has(words[0]) && commandHelp(app, words, added())) || help(app, added()))
  }
  if (values.skill) return void process.stdout.write(skill(first))
  // No command, or a directory: start a thread there and open it.
  if (!first || !COMMANDS.has(first)) return startThread({ dir: first, machine: values.machine, prompt: values.prompt, profile: values.profile, worktree: values.worktree, open: true })
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
    case 'unread': return unreadCommand(values.machine, Boolean(values.count))
    case 'new': case 'start': return startThread({ dir: rest[0], machine: values.machine, prompt: values.prompt, profile: values.profile, worktree: values.worktree, open: false })
    case 'profile': return profileCommand(rest[0], rest.slice(1), values)
    case 'extensions': return extensionsCommand(values)
    case 'extension': return extensionCommand(rest[0], rest.slice(1), values)
    case 'read': return readCommand(rest[0], values)
    case 'send': {
      const [id, ...text] = rest
      if (!id || !text.length) throw new RpcError('usage', `${app.id} send <thread> <text...>`)
      await on(resolveMachine(values.machine), (call) => call('thread.send', { thread: id, text: text.join(' ') }))
      return print({ ok: true }, () => {})
    }
    case 'machines': return machinesCommand(rest[0], rest.slice(1), values)
    case 'settings': return settingsCommand(rest[0], rest.slice(1), values)
    case 'secrets': return secretsCommand(rest[0], rest.slice(1), values.machine)
    case 'providers': return providersCommand(rest[0], rest.slice(1), values.machine, values)
    case 'models': return modelsCommand(rest[0], rest.slice(1), values.machine)
    case 'daemon': return daemonCommand(rest[0], Boolean(values.now))
    case 'connect': return values.update ? updateHere(Boolean(values.now)) : bridge(Boolean(values.start))
    case 'actions': return actionsCommand(rest[0], values)
    case 'web': return webCommand(rest[0], rest.slice(1), values)
    case 'layout': return layoutCommand()
    case 'app': return appCommand(rest[0], values)
    case 'mcp': return mcpCommand(values.machine)
  }
  const command = added().find((c) => c.name === first)
  if (command) return command.run(contextFor(resolveMachine(values.machine)), rest[0], rest.slice(1), values as Record<string, string | boolean | undefined>)
}

/** What an app's own command works with (command.ts): the machine, and the ways the core's commands reach and print. */
function contextFor(machine: Machine): CliContext {
  return {
    app, machine: { id: machine.id, label: machine.label, remote: Boolean(machine.config) },
    on: (work) => on(machine, work), connect: () => connect(machine), print, table, readSecret,
  }
}

/** Run the command line for `config`, with `process.argv`. */
export function runCli(config: AppConfig, cliOptions: CliOptions) {
  app = config
  options = cliOptions
  dataDir = defaultDataDir(app)
  socket = socketPath(app, dataDir)
  machines = new MachineStore(dataDir)
  const core = commandNames([])
  for (const command of added()) if (core.has(command.name) || command.name === 'help') throw new Error(`${command.name} is a command of ${app.id}'s own`)
  COMMANDS = new Set([...commandNames(added()), 'help'])
  main().catch((error: unknown) => {
    // A command used wrong: where its usage is.
    const misused = (error instanceof RpcError && error.kind === 'usage') || String((error as { code?: unknown }).code).startsWith('ERR_PARSE_ARGS')
    const command = process.argv.slice(2).find((arg) => !arg.startsWith('-'))
    const see = misused ? `\nSee: ${app.id}${command && COMMANDS.has(command) && command !== 'help' ? ` ${command}` : ''} --help` : ''
    const hint = (error instanceof RpcError && error.hint ? `\n${error.hint}` : '') + see
    console.error(`${app.id}: ${error instanceof Error ? error.message : String(error)}${hint}`)
    process.exit(1)
  })
}
