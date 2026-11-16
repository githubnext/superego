// An MCP server for the tests, on the SDK's McpServer: run as a command (`node fixture.ts`, stdio), or served over
// Streamable HTTP in the test's own process (`serveHttp`). Its tools:
// - echo: says back its text, and the env variable FIXTURE_SECRET when asked
// - hang: never answers, until the call is cancelled (and says so in the calls file)
// - crash: writes to stderr (FIXTURE_LAST_WORDS, when it's set) and exits with code 3
// - change: adds a tool `added` and takes itself away, so its list changes
// - progress: reports progress twice, then answers
// - picture: an image, a text resource and a blob
// Each call (and each start) is appended to FIXTURE_CALLS, when it's set, so a test sees what ran.
import { appendFileSync } from 'node:fs'
import { createServer, type Server as HttpServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

export function fixtureServer(note: (line: string) => void = () => {}) {
  const server = new McpServer({ name: 'fixture', version: '1.2.3' }, { capabilities: { logging: {} }, instructions: 'The fixture server: echo things back.' })
  server.registerTool('echo', { title: 'Echo', description: 'Say the text back.', inputSchema: { text: z.string(), secret: z.boolean().optional() } }, async ({ text, secret }) => {
    note(`echo ${text}`)
    return { content: [{ type: 'text', text: secret ? `${text} ${process.env.FIXTURE_SECRET ?? '(no secret)'}` : text }] }
  })
  server.registerTool('hang', { description: 'Never answers.', inputSchema: {} }, async (_args, extra) => {
    note('hang')
    await new Promise<void>((resolve) => extra.signal.addEventListener('abort', () => { note('hang cancelled'); resolve() }, { once: true }))
    return { content: [{ type: 'text', text: 'cancelled' }] }
  })
  server.registerTool('crash', { description: 'Exits.', inputSchema: {} }, async () => {
    note('crash')
    process.stderr.write(`${process.env.FIXTURE_LAST_WORDS ?? 'boom: the fixture fell over'}\n`)
    setTimeout(() => process.exit(3), 10)
    return new Promise(() => {})
  })
  const change = server.registerTool('change', { description: 'Changes the tool list.', inputSchema: {} }, async () => {
    note('change')
    server.registerTool('added', { description: 'Added by change.', inputSchema: {} }, async () => {
      note('added')
      return { content: [{ type: 'text', text: 'added ran' }] }
    })
    change.remove()
    return { content: [{ type: 'text', text: 'changed' }] }
  })
  server.registerTool('progress', { description: 'Reports progress.', inputSchema: {} }, async (_args, extra) => {
    note('progress')
    const token = extra._meta?.progressToken
    if (token !== undefined) {
      for (const progress of [1, 2]) {
        await extra.sendNotification({ method: 'notifications/progress', params: { progressToken: token, progress, total: 2, message: `step ${progress}` } })
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
    }
    return { content: [{ type: 'text', text: 'progressed' }] }
  })
  server.registerTool('picture', { description: 'Shows things.', inputSchema: {} }, async () => {
    note('picture')
    return {
      content: [
        { type: 'image', data: PNG, mimeType: 'image/png' },
        { type: 'resource', resource: { uri: 'file:///notes.txt', mimeType: 'text/plain', text: 'some notes' } },
        { type: 'resource', resource: { uri: 'file:///data.bin', mimeType: 'application/octet-stream', blob: Buffer.from('bytes!').toString('base64') } },
        { type: 'resource_link', uri: 'https://example.com/doc', name: 'doc' },
      ],
    }
  })
  return server
}

/** Serve fresh fixtures over Streamable HTTP on a loopback port; `seen` gets each request's Authorization header. */
export async function serveHttp(seen: (authorization: string | undefined) => void = () => {}, note?: (line: string) => void) {
  const sessions = new Map<string, StreamableHTTPServerTransport>()
  const http: HttpServer = createServer(async (req, res) => {
    seen(req.headers.authorization)
    if (req.headers.authorization !== undefined && req.headers.authorization !== 'Bearer good-key') {
      res.writeHead(401).end('no')
      return
    }
    const id = req.headers['mcp-session-id'] as string | undefined
    let transport = id ? sessions.get(id) : undefined
    if (id && !transport) { res.writeHead(404).end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message: 'Session not found' }, id: null })); return }
    if (!transport) {
      transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID(), onsessioninitialized: (sid) => { sessions.set(sid, transport!) } })
      await fixtureServer(note).connect(transport)
    }
    await transport.handleRequest(req, res)
  })
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve))
  const { port } = http.address() as { port: number }
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    /** Forget every session, as a server that restarted would. */
    forget: () => sessions.clear(),
    close: () => new Promise<void>((resolve) => { http.closeAllConnections(); http.close(() => resolve()) }),
  }
}

// Run as a command: stdio.
if (import.meta.url === `file://${process.argv[1]}`) {
  const calls = process.env.FIXTURE_CALLS
  const note = (line: string) => { if (calls) appendFileSync(calls, `${line}\n`) }
  note(`start ${process.cwd()}`)
  process.stderr.write(`fixture starting with FIXTURE_SECRET=${process.env.FIXTURE_SECRET ?? ''}\n`)
  const server = fixtureServer(note)
  await server.connect(new StdioServerTransport())
  if (process.env.LEAKED_KEY) note('leaked')
}
