// A file written whole or not at all: to a temporary file beside it, then renamed over it, so a reader (or a crash)
// never sees half of it.
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

let temps = 0

/** Write `text` to `path` atomically (its folder made first), readable by its owner only unless `mode` says otherwise. */
export async function writeAtomic(path: string, text: string, mode = 0o600): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temp = `${path}.${process.pid}.${++temps}.tmp`
  try {
    await writeFile(temp, text, { mode })
    await rename(temp, path)
  } catch (error) {
    await rm(temp, { force: true })
    throw error
  }
}

/**
 * Writes to `path`, each atomic, one after another: the file ends with what was given last. Each write's promise
 * settles with its own outcome; a failed one doesn't stop those after it.
 */
export function writeQueue(path: string, mode = 0o600): (text: string) => Promise<void> {
  let queue: Promise<unknown> = Promise.resolve()
  return (text) => {
    const write = queue.then(() => writeAtomic(path, text, mode))
    queue = write.catch(() => {})
    return write
  }
}
