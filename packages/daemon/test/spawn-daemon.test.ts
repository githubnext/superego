// Starting a daemon on demand: of clients starting one for the same data folder at once (the app, and a daemon's links
// to the other machines, both following machines.json), only one does; the rest wait for its daemon. A pid file that
// names nothing on its way any more doesn't stop a start.
import { mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { daemonStarting, pidPath, spawnDaemon } from '../src/paths.ts'

let dir: string
const started: number[] = []
/** A stand-in daemon: lives a while, and says it started. */
const daemon = () => [process.execPath, '-e', `require('fs').appendFileSync(${JSON.stringify(join('%DIR%', 'started'))}, process.pid + '\\n'); setTimeout(() => {}, 20000)`]
const command = () => daemon().map((part) => part.replace('%DIR%', dir))
const startedPids = async () => (await readFile(join(dir, 'started'), 'utf8').catch(() => '')).split('\n').filter(Boolean).map(Number)

beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'superego-spawn-')) })
afterEach(async () => {
  for (const pid of [...started, ...await startedPids()]) try { process.kill(pid) } catch { /* gone already */ }
  started.length = 0
  await rm(dir, { recursive: true, force: true })
})

it('starts one daemon for clients starting at once, and the others wait on it', async () => {
  const first = spawnDaemon(dir, command(), process.env)
  const second = spawnDaemon(dir, command(), process.env)
  started.push(Number(await readFile(pidPath(dir), 'utf8')))
  expect(first()).toBe(true)
  expect(second()).toBe(true)
  await new Promise((resolve) => setTimeout(resolve, 1500))
  expect(await startedPids()).toHaveLength(1)
  expect(await startedPids()).toEqual([Number(await readFile(pidPath(dir), 'utf8'))])
})

it('starts one over a pid file naming a process that is gone, or one named too long ago', async () => {
  await writeFile(pidPath(dir), '999999')
  expect(daemonStarting(dir)).toBe(false)
  expect(spawnDaemon(dir, command(), process.env)()).toBe(true)
  const pid = Number(await readFile(pidPath(dir), 'utf8'))
  started.push(pid)
  expect(pid).not.toBe(999999)

  // Named a minute ago, though alive: not on its way any more.
  await utimes(pidPath(dir), new Date(Date.now() - 60_000), new Date(Date.now() - 60_000))
  expect(daemonStarting(dir)).toBe(false)
  spawnDaemon(dir, command(), process.env)
  started.push(Number(await readFile(pidPath(dir), 'utf8')))
  await new Promise((resolve) => setTimeout(resolve, 1500))
  expect(await startedPids()).toHaveLength(2)
})
