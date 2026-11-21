// `superego extension test`'s runner, as the command line runs it: each test named as it starts, and a test file that
// never ends (a synchronous loop, which no test's own timeout can stop) stopped after the time limit, naming the test,
// with the files after it still run.
import { execFile, spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, expect, it } from 'vitest'

const MAIN = fileURLToPath(new URL('../src/runner/main.ts', import.meta.url))
let dir: string
beforeAll(async () => { dir = await mkdtemp(join(tmpdir(), 'superego-runner-')) })
afterAll(async () => { await rm(dir, { recursive: true, force: true }) })

/**
 * Run the runner on `files` (written to a profile folder of their own, with no tsconfig: no type check). Stopped short
 * of the test's own timeout, so a runner that never ends fails with what it printed.
 */
async function run(name: string, files: Record<string, string>, args: string[] = []): Promise<{ code: number; out: string }> {
  const profile = join(dir, name)
  await mkdir(profile, { recursive: true })
  for (const [file, source] of Object.entries(files)) await writeFile(join(profile, file), source)
  return new Promise((resolve) => {
    execFile(process.execPath, [MAIN, ...args, profile], { timeout: 50_000, env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '' } }, (error, stdout, stderr) => {
      resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, out: stdout + stderr })
    })
  })
}

it('names each test as it starts, and finishes its line when it ends', async () => {
  const { code, out } = await run('names', {
    'a.test.ts': `import { describe, expect, it } from 'vitest'
describe('sums', () => {
  it('adds', () => { expect(1 + 1).toBe(2) })
  it('says something', () => { console.log('hello from a test') })
})
`,
  })
  expect(code).toBe(0)
  expect(out).toContain('    adds … ✓')
  // Output in the middle of a test goes on a line of its own, and the test's result after it.
  expect(out).toMatch(/ {4}says something …\nhello from a test\n {4}✓ says something/)
  expect(out).toContain('2 passed')
}, 60_000)

it('stops a file that runs past the limit, names the test it was in, and goes on with the next', async () => {
  const { code, out } = await run('loops', {
    'a.test.ts': `import { describe, it } from 'vitest'
describe('matcher', () => {
  it('finishes', () => {})
  it('never ends', () => { for (;;) {} })
  it('after it', () => {})
})
`,
    'b.test.ts': `import { it } from 'vitest'\nit('still runs', () => {})\n`,
    'c.test.ts': `import { it } from 'vitest'\nit('ends the process', () => { process.exit(3) })\n`,
    'd.test.ts': `import { it } from 'vitest'\nit('runs too', () => {})\n`,
  }, ['--timeout', '2'])
  expect(code).toBe(1)
  expect(out).toMatch(/✗ never ends: still running after 2s, so its file was stopped\./)
  expect(out).toContain('It ran in matcher › never ends')
  expect(out).toContain('still runs … ✓')
  expect(out).toMatch(/✗ ends the process: its process ended \(exit code 3\) before the test did/)
  expect(out).toContain('runs too … ✓')
  expect(out).toMatch(/2 failed, 3 passed/)
}, 60_000)

it('stops a file that never finishes loading', async () => {
  const { code, out } = await run('loading', { 'a.test.ts': `for (;;) {}\n` }, ['--timeout', '1'])
  expect(code).toBe(1)
  expect(out).toContain('✗ a.test.ts: still running after 1s, so it was stopped while loading.')
  expect(out).toContain('1 error')
}, 60_000)

it('stops its worker when it is stopped itself, even in a loop that never ends', async () => {
  const profile = join(dir, 'stopped')
  const pidFile = join(profile, 'worker.pid')
  await mkdir(profile, { recursive: true })
  await writeFile(join(profile, 'a.test.ts'), `import { writeFileSync } from 'node:fs'
import { it } from 'vitest'
it('spins', () => { writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); for (;;) {} })
`)
  const runner = spawn(process.execPath, [MAIN, profile], { stdio: 'ignore' })
  const exited = new Promise((done) => runner.on('exit', done))
  // The worker's pid, once its test has started.
  let pid = 0
  while (!pid) {
    pid = Number(await readFile(pidFile, 'utf8').catch(() => '0'))
    if (!pid) await new Promise((done) => setTimeout(done, 50))
  }
  runner.kill('SIGTERM')
  await exited
  // Killed with the runner, and gone once reaped, a moment after.
  const alive = () => { try { process.kill(pid, 0); return true } catch { return false } }
  await expect.poll(alive, { timeout: 5_000 }).toBe(false)
}, 60_000)
