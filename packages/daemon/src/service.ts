// Keeping the daemon alive: a systemd user unit (Linux) or a launchd agent (macOS) that starts it, restarts it if it dies, and,
// with lingering on Linux, starts it at boot and keeps it through a logout. Without one the daemon is only a detached
// process that the first connection started: it ends with a reboot. Every command that touches the system goes through
// `run`, so tests write into a temp home and record the commands instead of installing anything.
import { execFile, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, userInfo } from 'node:os'
import { dirname, join } from 'node:path'
import { envName, type AppConfig, type KeepsRunning } from '@superego/protocol'
import { writeAtomic } from './write-atomic.ts'

export type RunResult = { code: number; stdout: string; stderr: string }
export type Run = (command: string, args: string[]) => RunResult

export const realRun: Run = (command, args) => {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 15_000 })
  return { code: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? result.error?.message ?? '' }
}

/** The same, without blocking: for what a running daemon asks. */
const realRunAsync = (command: string, args: string[]) => new Promise<RunResult>((resolve) => {
  execFile(command, args, { encoding: 'utf8', timeout: 15_000 }, (error, stdout, stderr) =>
    resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout: stdout ?? '', stderr: stderr || (error?.message ?? '') }))
})

/** `<ID>_SERVICE_RUNNER`: a program that is run in place of systemctl, loginctl and launchctl (`runner systemctl --user …`), for tests. */
function runnerFor<R>(app: AppConfig, run: (command: string, args: string[]) => R): (command: string, args: string[]) => R {
  const runner = process.env[envName(app, 'SERVICE_RUNNER')]
  return runner ? (command, args) => run(runner, [command, ...args]) : run
}

export type ServiceContext = {
  app: AppConfig
  platform?: NodeJS.Platform
  home?: string
  user?: string
  uid?: number
  run?: Run
}

type Resolved = Required<ServiceContext> & { kind: 'systemd' | 'launchd' }

export const serviceKind = (platform: NodeJS.Platform = process.platform) => platform === 'darwin' ? 'launchd' : platform === 'linux' ? 'systemd' : undefined

function resolve(context: ServiceContext): Resolved {
  const platform = context.platform ?? process.platform
  const kind = serviceKind(platform)
  if (!kind) throw new Error(`No service manager known for ${platform}: run the daemon yourself, or leave it to be started on demand`)
  return {
    app: context.app, platform, kind, home: context.home ?? homedir(), user: context.user ?? userInfo().username,
    uid: context.uid ?? process.getuid?.() ?? 0, run: context.run ?? runnerFor(context.app, realRun),
  }
}

export const unitName = (app: AppConfig) => `${app.id}.service`
export const launchdLabel = (app: AppConfig) => `${app.bundleId ?? `dev.superego.${app.id}`}.daemon`

/** Where the unit or plist lives. */
export function servicePath(context: ServiceContext): string {
  const { app, kind, home } = resolve(context)
  return kind === 'systemd' ? join(home, '.config/systemd/user', unitName(app)) : join(home, 'Library/LaunchAgents', `${launchdLabel(app)}.plist`)
}

/**
 * A service runs the default instance: the one in `~/.<id>`. A copy with its own data dir or socket (tests, a second
 * instance) is never started or restarted by it.
 */
const isDefaultInstance = (app: AppConfig) => !process.env[envName(app, 'HOME')] && !process.env[envName(app, 'SOCKET')]

/** Whether a service is installed for this app on this computer. False where there is no service manager. */
export function serviceInstalled(context: ServiceContext): boolean {
  if (!serviceKind(context.platform) || !isDefaultInstance(context.app)) return false
  return existsSync(servicePath(context))
}

// A word of an ExecStart line: systemd expands % and $ there. Environment= expands only %: a $ in it is itself.
const systemdWord = (word: string, dollars = true) => /^[\w@+=:,./-]+$/.test(word) ? word
  : `"${word.replace(/[\\"]/g, '\\$&').replace(/%/g, '%%').replace(/\$/g, dollars ? '$$$$' : '$')}"`

/**
 * The exit code of a daemon that restarts itself under a service: the service starts it again. Any other clean exit
 * (`daemon stop`, a SIGTERM) leaves it stopped, and a crash brings it back.
 */
export const RESTART_EXIT = 75

export function systemdUnit(app: AppConfig, { command, env }: { command: string[]; env: Record<string, string> }): string {
  return [
    '[Unit]',
    `Description=${app.name} daemon`,
    '',
    '[Service]',
    `ExecStart=${command.map((word) => systemdWord(word)).join(' ')}`,
    ...Object.entries(env).map(([key, value]) => `Environment=${systemdWord(`${key}=${value}`, false)}`),
    // Back after a crash, and after a restart (an update, `daemon restart`), which exits RESTART_EXIT; a stop stays one.
    'Restart=on-failure',
    `RestartForceExitStatus=${RESTART_EXIT}`,
    `SuccessExitStatus=${RESTART_EXIT}`,
    'RestartSec=1',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n')
}

const xml = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

export function launchdPlist(app: AppConfig, { command, env, log }: { command: string[]; env: Record<string, string>; log: string }): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${xml(launchdLabel(app))}</string>
  <key>ProgramArguments</key>
  <array>
${command.map((word) => `    <string>${xml(word)}</string>`).join('\n')}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${Object.entries(env).map(([key, value]) => `    <key>${xml(key)}</key><string>${xml(value)}</string>`).join('\n')}
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key><false/>
  </dict>
  <key>ThrottleInterval</key><integer>2</integer>
  <key>StandardOutPath</key><string>${xml(log)}</string>
  <key>StandardErrorPath</key><string>${xml(log)}</string>
</dict>
</plist>
`
}

export type ServiceInstall = {
  kind: 'systemd' | 'launchd'; file: string
  /** Linux: whether lingering is on now, so the service starts at boot and survives a logout. Null: not applicable or unknown. */
  lingering: boolean | null
  /** Things that did not work and what to do about them. */
  notes: string[]
}

/**
 * Write the unit or plist and enable it (it starts at login, and at boot when lingering). It does not start it: the
 * caller hands over from a running daemon with `startService`. `command` runs the daemon; the service's environment is
 * this one's PATH (a service gets almost none) and which service it is, so the daemon can say so in `hello`.
 */
export function installService(context: ServiceContext, options: { command: string[]; env?: Record<string, string>; log: string }): ServiceInstall {
  const c = resolve(context)
  if (!isDefaultInstance(c.app)) throw new Error(`A service runs the default instance; unset ${envName(c.app, 'HOME')} and ${envName(c.app, 'SOCKET')} to install it`)
  const file = servicePath(context)
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    ...options.env, [envName(c.app, 'SERVICE')]: c.kind,
  }
  mkdirSync(dirname(file), { recursive: true })
  const notes: string[] = []
  if (c.kind === 'systemd') {
    writeFileSync(file, systemdUnit(c.app, { command: options.command, env }))
    const reload = c.run('systemctl', ['--user', 'daemon-reload'])
    if (reload.code !== 0) throw new Error(`systemctl --user is not available here: ${reload.stderr.trim() || 'no user service manager'}`)
    const enable = c.run('systemctl', ['--user', 'enable', unitName(c.app)])
    if (enable.code !== 0) notes.push(`Could not enable the service: ${enable.stderr.trim()}`)
    const linger = c.run('loginctl', ['enable-linger', c.user])
    const lingering = linger.code === 0 ? true : isLingering(c)
    if (lingering !== true) notes.push(`Lingering is off, so the daemon stops when ${c.user} logs out and does not start at boot. Ask an admin to run: loginctl enable-linger ${c.user}`)
    return { kind: c.kind, file, lingering, notes }
  }
  writeFileSync(file, launchdPlist(c.app, { command: options.command, env, log: options.log }))
  return { kind: c.kind, file, lingering: null, notes }
}

/** Remove the service, stopping its daemon. */
export function uninstallService(context: ServiceContext): boolean {
  const c = resolve(context)
  const file = servicePath(context)
  if (!existsSync(file)) return false
  if (c.kind === 'systemd') {
    c.run('systemctl', ['--user', 'disable', '--now', unitName(c.app)])
    rmSync(file)
    c.run('systemctl', ['--user', 'daemon-reload'])
  } else {
    c.run('launchctl', ['bootout', `gui/${c.uid}/${launchdLabel(c.app)}`])
    rmSync(file)
  }
  return true
}

/** Start the daemon through its service (a no-op when it is running). False when that did not work: start it yourself. */
export function startService(context: ServiceContext): boolean {
  if (!serviceInstalled(context)) return false
  const c = resolve(context)
  if (c.kind === 'systemd') return c.run('systemctl', ['--user', 'start', unitName(c.app)]).code === 0
  const target = `gui/${c.uid}/${launchdLabel(c.app)}`
  if (c.run('launchctl', ['print', target]).code === 0) return c.run('launchctl', ['kickstart', target]).code === 0
  return c.run('launchctl', ['bootstrap', `gui/${c.uid}`, servicePath(context)]).code === 0
}

function isLingering(c: Resolved): boolean | null {
  const result = c.run('loginctl', ['show-user', c.user, '--property=Linger'])
  if (result.code !== 0) return null
  return /^Linger=yes/m.test(result.stdout)
}

/**
 * How a restarting daemon hands over to its successor. Under a service it exits RESTART_EXIT and the service starts it
 * again (`manager`). Not under one but with one installed (`daemon install` handing over a daemon started on demand),
 * it starts the service and exits (`service`). Else, or when starting the service failed, it spawns the successor
 * itself (`self`).
 */
export function restartVia(context: ServiceContext, env: NodeJS.ProcessEnv = process.env): 'manager' | 'service' | 'self' {
  if (runningUnder(context.app, env)) return 'manager'
  return startService(context) ? 'service' : 'self'
}

const restartEnvPath = (dataDir: string) => join(dataDir, 'restart-env.json')

/**
 * What a restart adds to the environment, for a successor the service starts: the service gives it only the unit's
 * own, so the daemon leaves the rest here (0600) and the successor takes it when it starts (see `takeRestartEnv`).
 */
export const saveRestartEnv = (dataDir: string, env: Record<string, string>) => writeAtomic(restartEnvPath(dataDir), JSON.stringify(env))

/** What a restart left for this daemon, read once and removed. */
export function takeRestartEnv(dataDir: string): Record<string, string> {
  const path = restartEnvPath(dataDir)
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    return Object.fromEntries(Object.entries(parsed).filter((e): e is [string, string] => typeof e[1] === 'string'))
  } catch { return {} } finally { rmSync(path, { force: true }) }
}

/** The service the running daemon was started by (from its environment), if any. */
export const runningUnder = (app: AppConfig, env: NodeJS.ProcessEnv = process.env): 'systemd' | 'launchd' | null => {
  const value = env[envName(app, 'SERVICE')]
  return value === 'systemd' || value === 'launchd' ? value : null
}

/**
 * Whether this daemon will outlive a logout and a reboot. Under a systemd unit that depends on lingering; under a launchd
 * agent on the login session (a Mac that stays logged in keeps it), so that is not known; with no service nothing
 * brings it back. Asking systemd takes a moment, so this doesn't block: the daemon asks once a minute at most.
 */
export async function keepsRunning(app: AppConfig, options: { env?: NodeJS.ProcessEnv; run?: (command: string, args: string[]) => RunResult | Promise<RunResult>; user?: string } = {}): Promise<KeepsRunning> {
  const service = runningUnder(app, options.env)
  if (service !== 'systemd') return { service, afterLogout: service === 'launchd' ? null : false }
  const run = options.run ?? runnerFor(app, realRunAsync)
  const result = await run('loginctl', ['show-user', options.user ?? userInfo().username, '--property=Linger'])
  return { service, afterLogout: result.code !== 0 ? null : /^Linger=yes/m.test(result.stdout) }
}
