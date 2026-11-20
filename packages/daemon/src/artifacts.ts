// Artifacts: HTML pages of a thread's, served sandboxed (the desktop's superego-artifact://, Web access's /artifact/),
// with the files they link to beside them. Every one is read here, on the machine that holds it (`artifact.read`, and
// Web access's own for this machine's threads), so the fence below is the files' machine's, whoever shows the page.
//
// Unlike a file the user or the agent opens (`file.read` reads any), what an artifact is served is asked for by the
// page itself: a script in HTML the agent wrote (from whatever it read on the web, or a repo it cloned) can ask for any
// address beside it. So an artifact gets the thread's folder, and nothing past it: no `..` out of it, no absolute or `~`
// path, and no symlink (of the file or of a folder on the way) that leads out of it, however it's swapped meanwhile.
import { constants } from 'node:fs'
import { open, readlink, realpath, stat } from 'node:fs/promises'
import { join, sep } from 'node:path'
import { RpcError } from '@superego/protocol'

/** How large a file an artifact is served: as `file.read` reads whole. */
export const ARTIFACT_LIMIT = 16 * 1024 * 1024

/**
 * The file an artifact's address asks for, as a path in the thread's folder; undefined for one that leaves it as
 * written. Only the first of the two checks: `readArtifact` checks where it really is.
 */
export function artifactFile(path: string): string | undefined {
  if (path.startsWith('/') || path === '~' || path.startsWith('~/')) return undefined
  const parts: string[] = []
  for (const part of path.split('/')) {
    if (part === '..') { if (!parts.pop()) return undefined }
    else if (part && part !== '.') parts.push(part)
  }
  return parts.length ? parts.join('/') : undefined
}

/** Where an open file really is. Linux says, of the file itself; elsewhere its path is resolved again, and must be it. */
async function whereIs(fd: number, path: string, ino: number, dev: number): Promise<string | undefined> {
  const proc = await readlink(`/proc/self/fd/${fd}`).catch(() => undefined)
  if (proc !== undefined) return proc
  // No /proc (macOS): the path as it resolves now, if it's still the file that was opened. A swap after the open would
  // have to put that same file back inside the folder, where it then is.
  const real = await realpath(path).catch(() => undefined)
  if (!real) return undefined
  const now = await stat(real).catch(() => undefined)
  return now && now.ino === ino && now.dev === dev ? real : undefined
}

/** An artifact's file in `folder` (a thread's), as `asked` by its page: refused unless it really is in the folder. */
export async function readArtifact(folder: string, asked: string): Promise<Buffer> {
  const path = artifactFile(asked)
  if (!path) throw new RpcError('forbidden', `${asked} is outside the thread's folder`)
  const root = await realpath(folder).catch(() => { throw new RpcError('not_found', `The thread's folder ${folder} isn't there`) })
  const file = join(root, path)
  // Non-blocking: a FIFO in the folder opens at once instead of waiting for a writer (and is then refused, not a file).
  const handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR' || error.code === 'ELOOP') throw new RpcError('not_found', `${path} isn't there`)
    if (error.code === 'EACCES' || error.code === 'EPERM') throw new RpcError('forbidden', `No permission to read ${path}`)
    throw error
  })
  try {
    const info = await handle.stat()
    const real = await whereIs(handle.fd, file, info.ino, info.dev)
    if (!real?.startsWith(root === sep ? root : root + sep)) throw new RpcError('forbidden', `${path} leads outside the thread's folder`)
    if (!info.isFile()) throw new RpcError('invalid', `${path} isn't a file`)
    if (info.size > ARTIFACT_LIMIT) throw new RpcError('too_large', `${path} is larger than ${ARTIFACT_LIMIT / 1024 / 1024} MB`)
    return await handle.readFile()
  } finally {
    await handle.close()
  }
}
