// spawnGroup: a command and everything it starts, stopped as one, and `exited` only once none of it is left.
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { spawnGroup } from '../src/process-group.ts'

/** Whether a process is still there (as superego/testing's `isRunning`). */
const isRunning = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }

let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'superego-group-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

/** The pid a command wrote to `name` in the folder, once it has. */
async function pidIn(name: string) {
  for (let i = 0; i < 400; i++) {
    const text = await readFile(join(dir, name), 'utf8').catch(() => '')
    if (text.endsWith('\n')) return Number(text)
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`No ${name}`)
}

describe.skipIf(process.platform === 'win32')('spawnGroup', () => {
  it('stops the command and what it started, and resolves once all of it is gone', async () => {
    const run = spawnGroup('bash', ['-c', "bash -c 'sleep 30 & echo $! > sleeper.pid; wait'"], { cwd: dir, stdio: 'ignore' })
    const sleeper = await pidIn('sleeper.pid')
    expect((await run.stop()).stopped).toBe(true)
    expect(isRunning(sleeper)).toBe(false)
  })

  it('stops it when its signal aborts', async () => {
    const abort = new AbortController()
    const run = spawnGroup('bash', ['-c', 'sleep 30 & echo $! > sleeper.pid; wait'], { cwd: dir, stdio: 'ignore', signal: abort.signal })
    const sleeper = await pidIn('sleeper.pid')
    abort.abort()
    expect((await run.exited).stopped).toBe(true)
    expect(isRunning(sleeper)).toBe(false)
  })

  it('kills what ignores SIGTERM, after the grace', async () => {
    const script = "trap '' TERM; sh -c \"trap '' TERM; sleep 30\" & echo $! > stubborn.pid; echo $$ > shell.pid; wait"
    const run = spawnGroup('bash', ['-c', script], { cwd: dir, stdio: 'ignore', grace: 200 })
    const stubborn = await pidIn('stubborn.pid')
    await pidIn('shell.pid')
    const started = Date.now()
    expect((await run.stop()).stopped).toBe(true)
    expect(Date.now() - started).toBeGreaterThanOrEqual(150)
    expect(isRunning(stubborn)).toBe(false)
  })

  it('takes what a finished command left running with it', async () => {
    const run = spawnGroup('bash', ['-c', 'sleep 30 & echo $! > sleeper.pid'], { cwd: dir, stdio: 'ignore' })
    expect(await run.exited).toEqual({ code: 0, signal: null, stopped: false })
    expect(isRunning(await pidIn('sleeper.pid'))).toBe(false)
  })

  it("says how a command ended, and why one couldn't start", async () => {
    expect(await spawnGroup('bash', ['-c', 'exit 3'], { stdio: 'ignore' }).exited).toEqual({ code: 3, signal: null, stopped: false })
    const missing = await spawnGroup(join(dir, 'nothing-here'), [], { stdio: 'ignore' }).exited
    expect(missing).toMatchObject({ code: null, stopped: false, error: expect.objectContaining({ code: 'ENOENT' }) })
  })

  it("doesn't let a signal aborted already run anything for long", async () => {
    const run = spawnGroup('bash', ['-c', 'sleep 30'], { stdio: 'ignore', signal: AbortSignal.abort() })
    expect((await run.exited).stopped).toBe(true)
  })
})
