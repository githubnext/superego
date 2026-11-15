// `superego mcp-servers`, against a daemon started from this checkout (with the bundled mcp-servers): a server added
// (through `do`, as Ego's tool or a script would), listed, its secret set from stdin, its log read, and restarted; and
// a thread's servers in `superego extensions --thread`.
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, expect, it } from 'vitest'

const CLI = fileURLToPath(new URL('../../../app/bin/superego.ts', import.meta.url))
const FIXTURE = fileURLToPath(new URL('../../../extensions/mcp-servers/test/fixture.ts', import.meta.url))
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

  const thread = await json(['create', home, '-p', 'hi'])
  await until(async () => (await json(['threads']))[0]?.status.state === 'done')
  expect(await superego(['extensions', '--thread', thread.id])).toMatch(/MCP servers \(as of its last turn\):\n\s+fx: this machine's, \w+, 6 tools/)
})
