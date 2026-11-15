// Starting this computer's daemon on demand: it's named in the pid file at once, so another client waits for it rather
// than starting a second, and it's waited for as long as it's starting (seconds on a busy machine), no longer.
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { daemonStarting, spawnDaemon } from '@superego/daemon/client'
import { openLocal } from '../src/index.ts'

let dir: string
const pids: number[] = []
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'superego-open-local-')) })
afterEach(async () => {
  for (const pid of pids.splice(0)) try { process.kill(pid) } catch {}
  await rm(dir, { recursive: true, force: true })
})

/** A stand-in daemon: listens on `socket` after `ms`, or with `ms` negative, exits at once. */
async function daemon(ms: number) {
  const script = join(dir, 'daemon.cjs')
  await writeFile(script, ms < 0 ? 'process.exit(1)\n' : `setTimeout(() => require('net').createServer(() => {}).listen(${JSON.stringify(join(dir, 's.sock'))}), ${ms})\n`)
  return [process.execPath, script]
}

it('names a daemon it starts at once, and waits for it until it listens', async () => {
  const command = await daemon(1000)
  const transport = await openLocal(join(dir, 's.sock'), () => {
    const coming = spawnDaemon(dir, command, process.env)
    return () => {
      // Another client meanwhile finds it on its way.
      expect(daemonStarting(dir)).toBe(true)
      return coming()
    }
  })
  pids.push(Number(await readFile(join(dir, 'daemon.pid'), 'utf8')))
  transport.close()
})

it("gives up on a daemon that exits as it starts, and doesn't take it for one on its way", async () => {
  const command = await daemon(-1)
  await expect(openLocal(join(dir, 's.sock'), () => spawnDaemon(dir, command, process.env))).rejects.toThrow(/ENOENT/)
  expect(daemonStarting(dir)).toBe(false)
})
