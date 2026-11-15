import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { withLock } from '../src/lock.ts'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'superego-lock-')) })
afterEach(() => rmSync(dir, { recursive: true, force: true }))

/** Node running `script` (an ES module that may import ../src/*.ts) in `count` processes at once; their outputs. */
function inProcesses(count: number, script: string): Promise<string[]> {
  const file = join(dir, 'script.ts')
  writeFileSync(file, script.replaceAll('../src/', new URL('../src/', import.meta.url).href))
  return Promise.all(Array.from({ length: count }, () => new Promise<string>((resolve, reject) => {
    const child = spawn(process.execPath, [file], { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    child.stdout.on('data', (chunk) => { out += chunk })
    child.stderr.on('data', (chunk) => { err += chunk })
    child.on('exit', (code) => code === 0 ? resolve(out) : reject(new Error(err)))
  })))
}

it('lets one process at a time in', async () => {
  const log = join(dir, 'log')
  await inProcesses(4, `
    import { appendFileSync } from 'node:fs'
    import { withLock } from '../src/lock.ts'
    await withLock(${JSON.stringify(join(dir, 'lock'))}, async () => {
      appendFileSync(${JSON.stringify(log)}, 'in\\n')
      await new Promise((resolve) => setTimeout(resolve, 50))
      appendFileSync(${JSON.stringify(log)}, 'out\\n')
    })
  `)
  expect(readFileSync(log, 'utf8')).toBe('in\nout\n'.repeat(4))
  expect(readdirSync(dir).filter((entry) => entry.startsWith('lock'))).toEqual([])
})

it("passes over a lock whose holder died, and lets go when what it ran throws", async () => {
  const gone = spawnSync(process.execPath, ['-e', '']).pid!
  writeFileSync(join(dir, 'lock'), String(gone))
  expect(await withLock(join(dir, 'lock'), () => 'mine')).toBe('mine')
  await expect(withLock(join(dir, 'lock'), () => { throw new Error('boom') })).rejects.toThrow('boom')
  expect(await withLock(join(dir, 'lock'), async () => 'again')).toBe('again')
})

it('installs author types from processes at once: each finds them whole', async () => {
  const from = join(dir, 'built')
  for (let i = 0; i < 60; i++) {
    mkdirSync(join(from, 'node_modules', `p${i % 30}`), { recursive: true })
    writeFileSync(join(from, 'node_modules', `p${i % 30}`, `f${i}.d.ts`), `export declare const x${i}: number\n`)
  }
  writeFileSync(join(from, 'stamp.json'), JSON.stringify({ hash: 'one' }))
  const data = join(dir, 'data')
  mkdirSync(data)
  // All at once: the lock held here until each of them waits for it (each names itself beside it as it does).
  let outs: Promise<string[]> | undefined
  let ended = false
  await withLock(join(data, 'types.lock'), async () => {
    outs = inProcesses(4, `
      import { installTypes } from '../src/author-types.ts'
      console.log(await installTypes(${JSON.stringify(from)}, ${JSON.stringify(data)}))
    `)
    outs.finally(() => { ended = true }).catch(() => {})
    while (!ended && readdirSync(data).filter((entry) => entry.startsWith('types.lock.')).length < 4) await new Promise((resolve) => setTimeout(resolve, 20))
  })
  expect((await outs!).map((out) => out.trim())).toEqual(Array(4).fill(join(data, 'types')))
  expect(JSON.parse(readFileSync(join(data, 'types', 'stamp.json'), 'utf8'))).toEqual({ hash: 'one' })
  expect(readdirSync(join(data, 'types', 'node_modules'))).toHaveLength(30)
  expect(readdirSync(data)).toEqual(['types'])
})
