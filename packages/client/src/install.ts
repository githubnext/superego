// Putting Superego on another machine over ssh: check it has Node, copy the bundle (one tarball, through stdin, so only
// ssh, sh and tar are needed there), unpack it under the app's data dir and write a small `superego` shim that names the
// Node it was installed with. The machine then runs `~/.superego/bin/superego connect --start`, so nothing on its PATH
// changes. Running it again updates. Everything on the far side goes through a `RemoteRun`, which tests point at a
// temp HOME on this computer.
import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { RpcError, type AppConfig } from '@superego/protocol'
import type { MachineConfig } from './shared.ts'
import { classifySsh, controlPath, linkArgs, shellQuote } from './ssh.ts'

/** The Node the bundle needs there: `node:sqlite` unflagged, and TypeScript profiles loaded as they are. */
export const MIN_NODE = [22, 18] as const

export type RemoteResult = { code: number; stdout: string; stderr: string }
/** Run a shell script on the machine, with `input` on its stdin. */
export type RemoteRun = (script: string, input?: Buffer) => Promise<RemoteResult>

/** The remote's own bin dir, as a shell expression. */
export const remoteBinDir = (app: AppConfig) => `$HOME/.${app.id}/bin`
/** What the machine runs to reach its daemon once installed (the remote shell expands `~`). */
export const installedCommand = (app: AppConfig) => `~/.${app.id}/bin/${app.id} connect --start`

/** Run scripts over ssh, riding the shared master when there is one. */
export function sshRun(config: MachineConfig, dataDir?: string): RemoteRun {
  if (config.via) throw new RpcError('invalid', `${config.label} is reached with a command, not ssh, so Superego can't install itself there`)
  const control = dataDir ? controlPath(dataDir, config.target) : undefined
  return (script, input) => new Promise((resolve, reject) => {
    const child = spawn('ssh', ['-T', ...linkArgs(control), '--', config.target, `sh -c ${shellQuote(script)}`], { stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk })
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk })
    child.stdin.on('error', () => {})
    child.once('error', (error) => reject(new RpcError('ssh', `Could not run ssh: ${error.message}`)))
    child.once('close', (code) => {
      // 255 is ssh itself failing; any other code is the script's.
      const failure = code === 255 ? classifySsh(stderr, code) : undefined
      if (failure) reject(new RpcError(failure.kind, failure.message))
      else resolve({ code: code ?? 1, stdout, stderr })
    })
    child.stdin.end(input)
  })
}

/** Whether `version` (`v22.18.0`) is new enough. */
export function nodeIsNewEnough(version: string): boolean {
  const [major = 0, minor = 0] = version.trim().replace(/^v/, '').split('.').map(Number)
  return major > MIN_NODE[0] || (major === MIN_NODE[0] && minor >= MIN_NODE[1])
}

export type Installed = {
  command: string
  node: string
  nodeVersion: string
  /** What the daemon there is doing now: absent when none was running. */
  daemon?: 'restarted' | 'current' | 'busy'
  /** With `service`: what setting it up said. */
  service?: string
}

export type InstallOptions = {
  app: AppConfig
  label: string
  /** The tarball to copy (see `pnpm build`). */
  bundle: string
  /** Also set the daemon up as a service there, so it outlives logouts and reboots. */
  service?: boolean
  onStep?(message: string): void
}

const fail = (message: string, hint?: string) => new RpcError('install_failed', message, hint ? { hint } : undefined)

export async function installMachine(run: RemoteRun, options: InstallOptions): Promise<Installed> {
  const { app, label } = options
  const step = options.onStep ?? (() => {})
  const bin = remoteBinDir(app)
  const shim = `${bin}/${app.id}`
  const tarball = await readFile(options.bundle).catch(() => { throw fail(`No bundle at ${options.bundle}`, 'Build it with: pnpm build (in app/)') })

  step(`Checking Node on ${label}`)
  const probe = await run('command -v node 2>/dev/null && node --version')
  const [node, nodeVersion] = probe.stdout.trim().split('\n')
  if (probe.code !== 0 || !node || !nodeVersion) {
    throw fail(`Node.js is not installed on ${label}, or is not on the PATH ssh gives a command (a non-login shell).`,
      `Superego needs Node ${MIN_NODE.join('.')} or newer there. Install it where ssh finds it, such as /usr/local/bin.`)
  }
  if (!nodeIsNewEnough(nodeVersion)) {
    throw fail(`${label} has Node ${nodeVersion.replace(/^v/, '')}; Superego needs ${MIN_NODE.join('.')} or newer.`, 'Upgrade Node there and run this again.')
  }

  step(`Copying Superego to ${label} (${Math.round(tarball.length / 1024 / 1024 * 10) / 10} MB)`)
  const unpack = await run([
    `D="${bin}"`, 'mkdir -p "$D" && rm -rf "$D/app.new" && mkdir "$D/app.new" && tar -xzf - -C "$D/app.new"',
    'rm -rf "$D/app.old"', '{ [ ! -d "$D/app" ] || mv "$D/app" "$D/app.old"; }', 'mv "$D/app.new" "$D/app"', 'rm -rf "$D/app.old"',
  ].join(' && '), tarball)
  if (unpack.code !== 0) throw fail(`Unpacking on ${label} failed: ${unpack.stderr.trim() || `exit ${unpack.code}`}`, 'It needs tar and a writable home directory.')

  // The shim names this Node outright: ssh's PATH may not have it (mise, nvm), and a service has less still.
  const written = await run(`D="${bin}"; N=${shellQuote(node)}; printf '#!/bin/sh\\nexec "%s" "%s/app/main/cli.js" "$@"\\n' "$N" "$D" > "$D/${app.id}" && chmod +x "$D/${app.id}"`)
  if (written.code !== 0) throw fail(`Could not write ${shim} on ${label}: ${written.stderr.trim()}`)

  step('Checking it runs')
  const status = await run(`"${shim}" daemon status --json`)
  if (status.code !== 0) throw fail(`The copy on ${label} does not run: ${status.stderr.trim().split('\n').at(-1) || `exit ${status.code}`}`)
  const state = parseJson<{ running?: boolean; current?: boolean }>(status.stdout) ?? {}

  const result: Installed = { command: installedCommand(app), node, nodeVersion }
  if (options.service) {
    step(`Setting up the service on ${label}`)
    const service = await run(`"${shim}" daemon install`)
    result.service = (service.stdout.trim() || service.stderr.trim())
    if (service.code !== 0) throw fail(`Setting up the service on ${label} failed: ${result.service}`)
  } else if (state.running && !state.current) {
    // A daemon from before the update goes on running the old code until restarted.
    step('Restarting the daemon onto the new code')
    result.daemon = (await run(`"${shim}" daemon restart`)).code === 0 ? 'restarted' : 'busy'
  } else if (state.running) result.daemon = 'current'
  return result
}

function parseJson<T>(text: string): T | undefined {
  try { return JSON.parse(text.trim().split('\n').at(-1) ?? '') as T } catch { return undefined }
}
