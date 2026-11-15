// A small MCP server on stdio for test/mcp.mjs, with no dependencies: newline-delimited JSON-RPC, as the stdio transport
// speaks it. A tracker's tools, answering with made-up issues, and one that answers with an image.
import { createInterface } from 'node:readline'

const issues = [
  { id: 'ENG-412', title: 'Totals drift by a day around midnight', state: 'In Progress' },
  { id: 'ENG-398', title: 'Group spending by category', state: 'Todo' },
]
const tools = [
  {
    name: 'list_issues', title: 'List issues', description: 'Issues in a team, newest first.',
    inputSchema: { type: 'object', properties: { team: { type: 'string' }, state: { type: 'string' } } },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'create_issue', title: 'Create issue', description: 'File an issue in a team.',
    inputSchema: { type: 'object', properties: { team: { type: 'string' }, title: { type: 'string' }, description: { type: 'string' } }, required: ['team', 'title'] },
  },
  {
    name: 'chart', title: 'Chart', description: 'A burn-down chart of a team, as an image.',
    inputSchema: { type: 'object', properties: { team: { type: 'string' } } },
  },
]
// A burn-down chart, as a PNG (made once, kept here).
const chart = 'iVBORw0KGgoAAAANSUhEUgAAAPAAAABuCAIAAACWWwn2AAAB30lEQVR42u3dS2oCQRRAUcdZt2vMCkIQ3IEEzEwyEr/pqlsH7tiBfSzsrnq6O51+pEw7b4GAloCWgJaAFtAS0BLQEtDSS0B/fR+lobJCywothUF/7M+XvGVKgSZbTdBwa1bQn4fzJbKVAk22mqBvx/1wLo+2Af1W2S6SNgP9JtmukzYG/ZKwVgo01gqCZlo10P/G2gcG6AJrt6FAT2/a0xWgC6yvC/aVHeg5WN/i2G0o0EObvhcx1qvMFA4O+q69yedf2VTf9DOFU4C+ztqDcCv0lKD/4rO/A3QBtG1LoIFmGmissQY6z5psoIOmyQY6y5psoLOy4QaabAFNNtBAD3XmxFQ80KvLphnooGyggbZnCbSwBlpYAy2mgdaqrDszhVpkINIKzfRCSzXQWAMtrIHWyBuTQMuUDdByrhVokQ20FpUNtFK4gVZKNtBKyQZaKdxAKyUbaKVkA63UD6MBrdQeO9BKHYoCWqkjrEArxdpMoSYbebRCa6GlGmilWAOtFGuglTINtFKsgVaKNdCaxjTQSrEGWqmAFtBAC2gJaAloAQ20gAZaQEtAS0ALaDOFmjwzhbJCAy2gJaAloAU00AIaaHVBS6k/3pSAloCWgJaAFtAS0BLQEtAS0AJaGrdf4G+4GmUEGoAAAAAASUVORK5CYII='

const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
const text = (value) => ({ content: [{ type: 'text', text: value }] })

function call(name, args) {
  switch (name) {
    case 'list_issues': return text(issues.filter((i) => !args.state || i.state === args.state).map((i) => `${i.id}  ${i.state.padEnd(12)}  ${i.title}`).join('\n'))
    case 'create_issue': {
      const issue = { id: `ENG-${413 + issues.length - 2}`, title: args.title, state: 'Todo' }
      issues.unshift(issue)
      return text(`Created ${issue.id}: ${issue.title}\nhttps://linear.app/acme/issue/${issue.id.toLowerCase()}`)
    }
    case 'chart': return { content: [{ type: 'text', text: `${args.team ?? 'ENG'}: 14 open, 3 closed this week.` }, { type: 'image', data: chart, mimeType: 'image/png' }] }
    default: return { content: [{ type: 'text', text: `No tool ${name}` }], isError: true }
  }
}

createInterface({ input: process.stdin }).on('line', (line) => {
  let message
  try { message = JSON.parse(line) } catch { return }
  if (message.id === undefined) return
  switch (message.method) {
    case 'initialize': return send({ id: message.id, result: { protocolVersion: message.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'tracker', version: '1.0.0' }, instructions: 'The team is ENG.' } })
    case 'ping': return send({ id: message.id, result: {} })
    case 'tools/list': return send({ id: message.id, result: { tools } })
    case 'tools/call': return send({ id: message.id, result: call(message.params.name, message.params.arguments ?? {}) })
    default: return send({ id: message.id, error: { code: -32601, message: `No method ${message.method}` } })
  }
})
