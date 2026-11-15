// A session with a server, without a daemon: the fixture as a command (a process group, a clean environment, its
// stderr in the log with secrets hidden) and over HTTP (an API key in its header), its tools listed and called.
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { Connection, envOf, headersOf, ServerLog, type Exit } from '../src/connections.ts'
import { serveHttp } from './fixture.ts'

const FIXTURE = join(import.meta.dirname, 'fixture.ts')
let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'superego-mcp-conn-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

const until = async (check: () => boolean | Promise<boolean>) => {
  for (let i = 0; i < 200; i++) { if (await check()) return; await new Promise((r) => setTimeout(r, 25)) }
  throw new Error('timed out')
}

it('runs a command in a clean environment, lists and calls its tools, logs its stderr with secrets hidden', async () => {
  process.env.LEAKED_KEY = 'sk-should-not-pass'
  const log = new ServerLog(join(dir, 'fx.log'), () => ['s3cret-value'])
  const closes: (Exit | undefined)[] = []
  const calls = join(dir, 'calls')
  const connection = await Connection.open({
    name: 'fx', config: { command: process.execPath, args: [FIXTURE], env: { FIXTURE_CALLS: calls }, auth: { type: 'env', names: ['FIXTURE_SECRET'] } },
    cwd: dir, secrets: { FIXTURE_SECRET: 's3cret-value' }, log, onClose: (exit) => closes.push(exit),
  })
  delete process.env.LEAKED_KEY
  const listing = await connection.list()
  expect(listing.tools.map((t) => t.name)).toEqual(['echo', 'hang', 'crash', 'change', 'progress', 'picture'])
  expect(listing).toMatchObject({ instructions: 'The fixture server: echo things back.', server: { name: 'fixture', version: '1.2.3' } })
  expect(await connection.call('echo', { text: 'hi', secret: true }, { timeout: 5000 })).toMatchObject({ content: [{ type: 'text', text: 'hi s3cret-value' }] })
  // Not the daemon's environment: only the safe few, its own, and its secrets.
  expect(await readFile(calls, 'utf8')).not.toContain('leaked')
  expect(await readFile(calls, 'utf8')).toContain(`start ${await import('node:fs/promises').then((fs) => fs.realpath(dir))}`)
  await until(async () => (await log.tail(50)).includes('fixture starting'))
  expect(await log.tail(50)).toContain('FIXTURE_SECRET=***')
  expect(await log.tail(50)).not.toContain('s3cret-value')
  // Its exit, unasked, is a close with its code and last words; a call in flight fails with them.
  await expect(connection.call('crash', {}, { timeout: 5000 })).rejects.toThrow(/fx exited with code 3\. Its last words on stderr:\n[\s\S]*boom: the fixture fell over/)
  await until(() => closes.length === 1)
  expect(closes[0]).toMatchObject({ code: 3, stopped: false, stderr: expect.arrayContaining(['boom: the fixture fell over']) })
})

it('reaches a URL with its API key, and closing it is no crash', async () => {
  const seen: (string | undefined)[] = []
  const http = await serveHttp((auth) => seen.push(auth))
  const closes: unknown[] = []
  const config = { url: http.url, auth: { type: 'api-key' as const } }
  const connection = await Connection.open({ name: 'web', config, cwd: dir, secrets: { key: 'good-key' }, log: new ServerLog(join(dir, 'web.log'), () => []), onClose: (exit) => closes.push(exit) })
  expect((await connection.list()).tools).toHaveLength(6)
  expect(await connection.call('echo', { text: 'over http' }, { timeout: 5000 })).toMatchObject({ content: [{ text: 'over http' }] })
  expect(seen.every((auth) => auth === 'Bearer good-key')).toBe(true)
  await connection.close()
  expect(closes).toEqual([])
  // A refused key fails to start.
  await expect(Connection.open({ name: 'web', config, cwd: dir, secrets: { key: 'bad' }, log: new ServerLog(join(dir, 'web.log'), () => []) })).rejects.toThrow()
  await http.close()
})

it('sends a key in the header its auth names, and secret env only by name', () => {
  expect(headersOf({ url: 'https://x', auth: { type: 'api-key' } }, { key: 'k' })).toEqual({ Authorization: 'Bearer k' })
  expect(headersOf({ url: 'https://x', headers: { A: 'b' }, auth: { type: 'api-key', header: 'X-Api-Key' } }, { key: 'k' })).toEqual({ A: 'b', 'X-Api-Key': 'k' })
  expect(headersOf({ url: 'https://x', auth: { type: 'api-key', scheme: 'Token' } }, { key: 'k' })).toEqual({ Authorization: 'Token k' })
  const env = envOf({ command: 'x', env: { PLAIN: '1' }, auth: { type: 'env', names: ['A'] } }, { A: 'secret', B: 'not asked for' })
  expect(env).toMatchObject({ PLAIN: '1', A: 'secret' })
  expect(env.B).toBeUndefined()
})
