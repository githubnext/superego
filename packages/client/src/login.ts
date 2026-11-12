// The login step, for a client with no terminal of its own (the app): open one that runs ssh interactively and leaves a
// master behind, then say when the master is there so links can reconnect through it.
import { spawn } from 'node:child_process'
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { RpcError } from '@superego/protocol'
import type { MachineConfig } from './shared.ts'
import { controlPath, loginScript, masterAlive, terminalLaunch } from './ssh.ts'

export type LoginOptions = {
  dataDir: string
  platform?: NodeJS.Platform
  /** Open the terminal; the real one detaches `open` or the emulator. Tests record instead of showing anything. */
  launch?(program: string, args: string[]): void
  hasProgram?(name: string): boolean
  alive?(control: string, target: string): boolean | Promise<boolean>
  /** How often to look for the master, and how long to wait for it. */
  pollMs?: number
  timeoutMs?: number
}

const detached = (program: string, args: string[]) => { spawn(program, args, { detached: true, stdio: 'ignore' }).unref() }

/**
 * Open a terminal that logs in to `config`'s target and holds the connection open for links to ride. Returns once the
 * terminal is open; `done` settles with whether the master came up before the timeout.
 */
export function loginInTerminal(config: MachineConfig, options: LoginOptions): { script: string; done: Promise<boolean> } {
  if (config.via) throw new RpcError('invalid', `${config.label} is reached with a command, not ssh: there is no login`)
  const control = controlPath(options.dataDir, config.target)
  const script = join(options.dataDir, 'ssh', `login-${config.id.slice(0, 8)}.command`)
  const launch = terminalLaunch(script, options.platform, options.hasProgram)
  if (!launch) throw new RpcError('no_terminal', `No terminal to open here. Log in from one: superego machines login ${config.label}`)
  mkdirSync(dirname(script), { recursive: true, mode: 0o700 })
  writeFileSync(script, loginScript(config.target, control), { mode: 0o700 })
  chmodSync(script, 0o700)
  ;(options.launch ?? detached)(launch.program, launch.args)

  const alive = options.alive ?? masterAlive
  const poll = options.pollMs ?? 1000
  const deadline = Date.now() + (options.timeoutMs ?? 5 * 60_000)
  // One check at a time, `poll` apart: each asks ssh, which may take a moment.
  const done = new Promise<boolean>((resolve) => {
    const check = async () => {
      const up = await Promise.resolve(alive(control, config.target)).catch(() => false)
      if (!up && Date.now() < deadline) { setTimeout(check, poll); return }
      rmSync(script, { force: true })
      resolve(up)
    }
    setTimeout(check, poll)
  })
  return { script, done }
}
