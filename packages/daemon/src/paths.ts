import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
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
 * Whether a daemon is on its way: one restarting hands over to the successor it started, naming it in the pid file
 * as it goes. Meanwhile nothing answers on the socket, and a client starting a daemon of its own would win the race
 * with whatever environment the client has (no API keys, say), so it waits instead.
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
