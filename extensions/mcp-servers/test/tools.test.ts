// A server's tools as the agent gets them (names, schemas, deferral), and its results as the model reads them.
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { configProblem, runsOf } from '../src/config.ts'
import { contentOf, MAX_BYTES, mayHaveRun } from '../src/results.ts'
import { normalizeSchema, offerTools, toolName } from '../src/tools.ts'

let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'superego-mcp-tools-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

it('names tools mcp__<server>__<tool>, within 64 characters and the characters providers take', () => {
  expect(toolName('linear', 'create_issue')).toBe('mcp__linear__create_issue')
  expect(toolName('fs', 'read.file/v2')).toBe('mcp__fs__read_file_v2')
  const long = toolName('github', 'x'.repeat(80))
  const other = toolName('github', `${'x'.repeat(79)}y`)
  expect(long).toHaveLength(64)
  expect(long).toMatch(/^mcp__github__x+_[0-9a-f]{6}$/)
  expect(other).not.toBe(long)
})

it('makes schemas into what pi-durable takes: an object root, $refs inlined, $schema dropped; refuses the rest', () => {
  expect(normalizeSchema({
    $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object',
    properties: { issue: { $ref: '#/$defs/Issue' } }, $defs: { Issue: { type: 'object', properties: { title: { type: 'string' } } } },
  })).toEqual({ schema: { type: 'object', properties: { issue: { type: 'object', properties: { title: { type: 'string' } } } } } })
  expect(normalizeSchema({})).toEqual({ schema: { type: 'object', properties: {} } })
  expect(normalizeSchema({ type: 'array' })).toEqual({ problem: 'its input schema is a "array", not an object' })
  expect(normalizeSchema({ type: 'object', properties: { x: { $ref: 'https://elsewhere/schema' } } })).toMatchObject({ problem: expect.stringMatching(/refers to https:\/\/elsewhere/) })
  // Recursive: inlined a few levels, then refused.
  expect(normalizeSchema({ type: 'object', properties: { node: { $ref: '#/$defs/Node' } }, $defs: { Node: { type: 'object', properties: { next: { $ref: '#/$defs/Node' } } } } })).toHaveProperty('problem')
})

it('defers a server with many tools (auto), always (search) or never (all), and skips tools that will not go', () => {
  const tool = (name: string) => ({ name, inputSchema: { type: 'object' as const } })
  const few = Array.from({ length: 3 }, (_, i) => tool(`t${i}`))
  const many = Array.from({ length: 16 }, (_, i) => tool(`t${i}`))
  expect(offerTools('a', few, {}).deferred).toBe(false)
  expect(offerTools('a', many, {}).deferred).toBe(true)
  expect(offerTools('a', many, { tools: 'all' }).deferred).toBe(false)
  expect(offerTools('a', few, { tools: 'search' }).deferred).toBe(true)
  const { offered, skipped } = offerTools('a', [...few, { name: 'bad', inputSchema: { type: 'string' } as never }, { name: 't0', inputSchema: { type: 'object' as const } }], {})
  expect(offered.map((t) => t.name)).toEqual(['mcp__a__t0', 'mcp__a__t1', 'mcp__a__t2'])
  expect(skipped.map((s) => s.tool)).toEqual(['bad', 't0'])
})

it('turns results into text and images, says what it leaves out, and cuts long text, keeping the whole', async () => {
  const files = { dir, call: 'call-1' }
  expect((await contentOf({ content: [{ type: 'audio', data: 'x', mimeType: 'audio/wav' }] }, files)).content).toEqual([{ type: 'text', text: "[Audio (audio/wav) left out: it can't be shown here.]" }])
  expect((await contentOf({ content: [], structuredContent: { a: 1 } }, files)).content).toEqual([{ type: 'text', text: '{\n  "a": 1\n}' }])
  const big = 'line of text\n'.repeat(10_000)
  const { content, saved } = await contentOf({ content: [{ type: 'text', text: big }] }, files)
  const text = (content[0] as { text: string }).text
  expect(Buffer.byteLength(text)).toBeLessThan(MAX_BYTES + 500)
  expect(text).toMatch(/\[Cut at 2000 of 10001 lines \(127 KB\)\. The whole output is in .*output\.txt\.\]$/)
  expect(await readFile(saved[0]!, 'utf8')).toBe(big)
})

it('tells the model a call cut off or interrupted may have run', () => {
  expect(mayHaveRun('linear', 'create_issue', 'was running when Superego stopped.', false)).toBe('linear.create_issue was running when Superego stopped.\nIt may or may not have taken effect on the server. Check (for example, list or read what it would have changed) before calling it again.')
  expect(mayHaveRun('browser', 'open', 'was cut off before it answered: browser was restarted', true)).toMatch(/browser ran for this thread only, so its session .* is gone too\.$/)
})

it('checks configs: a name, a command or a URL, https off this computer, auth that fits', () => {
  expect(configProblem('fx', { command: 'node' })).toBeUndefined()
  expect(configProblem('fx', { url: 'http://localhost:3000/mcp' })).toBeUndefined()
  expect(configProblem('Fx', { command: 'node' })).toMatch(/isn't a server name/)
  expect(configProblem('fx', {})).toMatch(/needs one of a command or a URL$/)
  expect(configProblem('fx', { command: 'node', url: 'https://x' })).toMatch(/not both/)
  expect(configProblem('fx', { url: 'http://example.com' })).toMatch(/must use https/)
  expect(configProblem('fx', { url: 'https://x', auth: { type: 'env', names: ['A'] } })).toMatch(/secret env vars are for a command/)
  expect(configProblem('fx', { command: 'x', auth: { type: 'oauth' } })).toMatch(/OAuth is for a URL server/)
  expect(runsOf({ command: 'npx', args: ['-y', '@sentry/mcp-server'] })).toBe('npx -y @sentry/mcp-server')
  expect(runsOf({ url: 'https://mcp.linear.app/mcp' })).toBe('mcp.linear.app/mcp')
  expect(runsOf({ url: 'https://api.githubcopilot.com/mcp/' })).toBe('api.githubcopilot.com/mcp')
})
