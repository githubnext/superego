import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { closeSync, linkSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
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
export const daemonStarting = (dataDir: string) => names(pidPath(dataDir))

/** Whether the pid file `file` names a process still on its way: alive, and named in the last 30 seconds. */
function names(file: string) {
  try {
    if (Date.now() - statSync(file).mtimeMs > 30_000) return false
    process.kill(Number(readFileSync(file, 'utf8')), 0)
    return true
  } catch {
    // No pid file, or the process it names is gone: nothing is on its way.
    return false
  }
}

/**
 * Claim the start of `dataDir`'s daemon: the pid file made anew, naming this process until the daemon it starts takes
 * over. Clients start daemons on their own (the app, the CLI, and a daemon's links to the other machines, which all
 * follow machines.json and so connect to a machine just added at once): checking `daemonStarting` and then spawning, two
 * would both start one, and the two race for the socket and the database. Making the file is the one step only one can
 * win; the rest wait for the winner's daemon. A pid file that names nothing on its way (a daemon that died, a start long
 * ago) is put aside first, and put back when another client's claim took its place meanwhile.
 */
function claimStart(dataDir: string): boolean {
  const file = pidPath(dataDir)
  for (let tries = 0; tries < 3; tries++) {
    try {
      writeFileSync(file, String(process.pid), { flag: 'wx' })
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    if (names(file)) return false
    const aside = `${file}.${process.pid}.stale`
    try {
      renameSync(file, aside)
    } catch (error) {
      // Put aside by another client already: try the claim again.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw error
    }
    if (names(aside)) {
      // Another client's claim, made since this one looked: back where it was, and that client's daemon is waited for.
      try { linkSync(aside, file) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
      rmSync(aside, { force: true })
      return false
    }
    rmSync(aside, { force: true })
  }
  return false
}

/**
 * Start `command`, a daemon for `dataDir`, in the background (logging beside its data), named in the pid file at once
 * (see `daemonStarting`), unless another client is starting one already (see `claimStart`). Returns whether a daemon is
 * still on its way: this one until it exits, or `daemonStarting` gives up on it; the other client's while it is. How long
 * it takes to listen is how long its modules take to load, seconds on a busy machine.
 */
export function spawnDaemon(dataDir: string, [program, ...args]: string[], env: NodeJS.ProcessEnv): () => boolean {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 })
  if (!claimStart(dataDir)) return () => daemonStarting(dataDir)
  const log = openSync(join(dataDir, 'daemon.log'), 'a')
  const child = spawn(program!, args, { detached: true, stdio: ['ignore', log, log], env })
  closeSync(log)
  let exited = false
  child.once('exit', () => { exited = true }).once('error', () => { exited = true }).unref()
  // Not started: the claim goes, so no client waits on it.
  if (!child.pid) rmSync(pidPath(dataDir), { force: true })
  else writeFileSync(pidPath(dataDir), String(child.pid))
  return () => !exited && daemonStarting(dataDir)
}
