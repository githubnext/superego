// One process at a time, across processes: `withLock(path, fn)` runs `fn` once it holds the lock at `path`, a file
// naming its holder's pid. It's made whole beside it and hard-linked into place, which fails while one is there, so
// taking it is atomic; one whose holder has died is passed over. Two waiters passing over the same dead holder at the same
// instant could both take it, so what's done under it must stay correct without it: it saves doing the same work twice
// at once, it doesn't keep anything consistent.
import { randomUUID } from 'node:crypto'
import { linkSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

const alive = (pid: number) => {
  try { process.kill(pid, 0); return true } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM' }
}

/** The pid holding the lock at `path`, if there's one. */
function holder(path: string): number | undefined {
  try { return Number(readFileSync(path, 'utf8')) || undefined } catch { return undefined }
}

export async function withLock<T>(path: string, fn: () => T | Promise<T>): Promise<T> {
  mkdirSync(dirname(path), { recursive: true })
  const mine = `${path}.${process.pid}-${randomUUID()}`
  writeFileSync(mine, String(process.pid))
  try {
    for (;;) {
      try { linkSync(mine, path); break } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
      const pid = holder(path)
      if (pid !== undefined && !alive(pid)) rmSync(path, { force: true })
      else await new Promise((resolve) => setTimeout(resolve, 100))
    }
  } finally {
    rmSync(mine, { force: true })
  }
  try { return await fn() } finally { rmSync(path, { force: true }) }
}
