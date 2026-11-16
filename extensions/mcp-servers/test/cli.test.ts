// `superego mcp-servers` (cli.ts, a command of the app's own), against a daemon started from this checkout (with the
// bundled mcp-servers): a server added (through `do`, as Ego's tool or a script would), listed, its secret set from
// stdin, its log read, and restarted; a thread's servers (`--thread`); and an OAuth sign-in (`sign-in`, the address
// pasted), and `sign-out`.
import { execFile, spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { serveOAuth } from './auth-server.ts'

const CLI = fileURLToPath(new URL('../../../app/bin/superego.ts', import.meta.url))
const FIXTURE = fileURLToPath(new URL('./fixture.ts', import.meta.url))
let home: string
const env = () => ({ ...process.env, SUPEREGO_HOME: home, SUPEREGO_APP: home, SUPEREGO_HEADLESS: '1', SUPEREGO_MODEL: 'faux', ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '' })

function superego(args: string[], input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(process.execPath, [CLI, ...args], { env: env(), timeout: 60_000 }, (error, stdout, stderr) => {
      if (error) reject(new Error(stderr || error.message))
      else resolve(stdout)
    })
    if (input !== undefined) child.stdin!.end(input)
  })
}
const json = async <T = any>(args: string[], input?: string): Promise<T> => JSON.parse(await superego([...args, '--json'], input))
const until = async (check: () => Promise<boolean>) => {
  for (let i = 0; i < 100; i++) { if (await check()) return; await new Promise((r) => setTimeout(r, 100)) }
  throw new Error('timed out')
}

beforeAll(async () => { home = await mkdtemp(join(tmpdir(), 'superego-cli-mcp-')) })
afterAll(async () => {
  const pid = Number(await readFile(join(home, 'daemon.pid'), 'utf8').catch(() => '0'))
  if (pid) {
    try { process.kill(pid) } catch { /* gone */ }
    for (let i = 0; i < 100; i++) {
      try { process.kill(pid, 0) } catch { break }
      await new Promise((r) => setTimeout(r, 50))
    }
  }
  await rm(home, { recursive: true, force: true })
})

it('lists, keys, logs and restarts MCP servers, and says which a thread has', { timeout: 120_000 }, async () => {
  expect(await superego(['mcp-servers'])).toMatch(/No MCP servers on This computer yet/)
  const server = { command: process.execPath, args: [FIXTURE], auth: { type: 'env', names: ['FIXTURE_SECRET'] }, unprofiled: true }
  await superego(['do', 'mcp-servers.add', '--params', JSON.stringify({ name: 'fx', server })])
  expect(await json(['mcp-servers'])).toMatchObject({ servers: [{ name: 'fx', state: 'needs-sign-in', secrets: [{ name: 'FIXTURE_SECRET', set: false }] }] })
  expect(await superego(['mcp-servers'])).toMatch(/fx: fx needs its secret FIXTURE_SECRET set first/)

  const keyed = await json(['mcp-servers', 'set-secret', 'fx'], 'quiet-value-123\n')
  expect(keyed).toMatchObject({ name: 'fx', tools: 6, secrets: [{ name: 'FIXTURE_SECRET', set: true }] })
  expect(await superego(['mcp-servers'])).toMatch(/^fx\s+.*fixture\.ts\s+(stopped|running) · 6 tools · without a profile too$/m)
  const log = await superego(['mcp-servers', 'logs', 'fx', '--lines', '50'])
  expect(log).toContain('FIXTURE_SECRET=***')
  expect(log).not.toContain('quiet-value-123')
  expect(await json(['mcp-servers', 'restart', 'fx'])).toMatchObject({ name: 'fx', tools: 6 })
  await expect(superego(['mcp-servers', 'restart', 'nope'])).rejects.toThrow(/No MCP server nope/)

  const thread = await json(['start', home, '-p', 'hi'])
  await until(async () => (await json(['threads']))[0]?.status.state === 'done')
  expect(await superego(['mcp-servers', '--thread', thread.id])).toMatch(/^fx: this machine's, \w+, 6 tools$/m)
  expect(await superego(['--help'])).toContain('superego mcp-servers logs <name> [--lines N]')
})

it('signs in to an OAuth server, the address pasted, and signs out', { timeout: 120_000 }, async () => {
  const as = await serveOAuth()
  try {
    await superego(['do', 'mcp-servers.add', '--params', JSON.stringify({ name: 'remote', server: { url: as.url, auth: { type: 'oauth' } } })])
    expect(await superego(['mcp-servers'])).toMatch(/remote: remote needs you to sign in/)
    const child = spawn(process.execPath, [CLI, 'mcp-servers', 'sign-in', 'remote'], { env: env(), stdio: ['pipe', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    child.stdout.on('data', (chunk) => { out += chunk })
    child.stderr.on('data', (chunk) => { err += chunk })
    const exited = new Promise<number | null>((resolve) => child.on('exit', resolve))
    await until(async () => /paste its whole address here/.test(err))
    const page = /Open this page to sign in to remote:\n\n {2}(\S+)/.exec(err)![1]!
    child.stdin.write(`${await as.approve(page)}\n`)
    expect(await exited).toBe(0)
    expect(out).toMatch(/Signed in to remote on This computer\.\n^remote\s+127\.0\.0\.1:\d+\/mcp\s+(stopped|running) · 6 tools$/m)
    expect(as.seen.grants).toEqual([expect.objectContaining({ grant: 'code', resource: as.url })])
    expect(await superego(['mcp-servers', 'sign-out', 'remote'])).toMatch(/Signed out of remote on This computer/)
    expect(await json(['mcp-servers'])).toMatchObject({ servers: expect.arrayContaining([expect.objectContaining({ name: 'remote', state: 'needs-sign-in', oauth: { signedIn: false } })]) })
  } finally {
    await as.close()
  }
})
