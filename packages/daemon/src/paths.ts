import { createHash } from 'node:crypto'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

export const defaultDataDir = () => process.env.MU_HOME ?? join(homedir(), '.mu')

/** The daemon's socket: inside the data dir when the path fits a socket's ~104 bytes, else in tmp. */
export function socketPath(dataDir: string) {
  if (process.env.MU_SOCKET) return process.env.MU_SOCKET
  const inside = join(dataDir, 'mu.sock')
  if (Buffer.byteLength(inside) < 100) return inside
  return join(tmpdir(), `mu-${createHash('sha256').update(dataDir).digest('hex').slice(0, 16)}.sock`)
}
