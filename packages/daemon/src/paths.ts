import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { closeSync, mkdirSync, openSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { envName, type AppConfig } from '@superego/protocol'

/** The app's environment variables: `env(app)('HOME')` reads `SUPEREGO_HOME` for Superego. */
export const appEnv = (app: AppConfig) => (key: string): string | undefined => process.env[envName(app, key)] || undefined

/** Where the app keeps its data: `<ID>_HOME`, else `~/.<id>`. */
export const defaultDataDir = (app: AppConfig) => appEnv(app)('HOME') ?? join(homedir(), `.${app.id}`)

/** The daemon's socket: inside the data dir when the path fits a socket's ~104 bytes, else in tmp. */
export function socketPath(app: AppConfig, dataDir: string) {
  const override = appEnv(app)('SOCKET')
  if (override) return override
  const inside = join(dataDir, `${app.id}.sock`)
  if (Buffer.byteLength(inside) < 100) return inside
  return join(tmpdir(), `${app.id}-${createHash('sha256').update(dataDir).digest('hex').slice(0, 16)}.sock`)
}

/** The running daemon's pid, beside its data. */
export const pidPath = (dataDir: string) => join(dataDir, 'daemon.pid')

/**
 * Whether a daemon is on its way: one restarting hands over to the successor it started, and a client starts one
 * (`spawnDaemon`), naming it in the pid file as they go. Meanwhile nothing answers on the socket, and a client starting
 * a daemon of its own would win the race with whatever environment the client has (no API keys, say), or two would
 * start, so it waits instead: for as long as that daemon lives, up to 30 seconds from when it was named.
 */
export function daemonStarting(dataDir: string) {
  try {
    const file = pidPath(dataDir)
    if (Date.now() - statSync(file).mtimeMs > 30_000) return false
    process.kill(Number(readFileSync(file, 'utf8')), 0)
    return true
  } catch {
    return false
  }
}

/**
 * Start `command`, a daemon for `dataDir`, in the background (logging beside its data), named in the pid file at once
 * (see `daemonStarting`). Returns whether it's still on its way: until it exits, or `daemonStarting` gives up on it. How
 * long it takes to listen is how long its modules take to load, seconds on a busy machine.
 */
export function spawnDaemon(dataDir: string, [program, ...args]: string[], env: NodeJS.ProcessEnv): () => boolean {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 })
  const log = openSync(join(dataDir, 'daemon.log'), 'a')
  const child = spawn(program!, args, { detached: true, stdio: ['ignore', log, log], env })
  closeSync(log)
  let exited = false
  child.once('exit', () => { exited = true }).once('error', () => { exited = true }).unref()
  if (child.pid) writeFileSync(pidPath(dataDir), String(child.pid))
  return () => !exited && daemonStarting(dataDir)
}
