// Writes what test/mcp.mjs looks at, before the app starts: `node mcp-setup.mjs <data dir> <turns.jsonl>`. This machine's
// MCP servers (mcp-servers.json) in each state Settings draws, one of them a real one (mcp-server.mjs), one signed in
// with OAuth (mcp-auth.json), and the turns
// of a thread that calls its tools.
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

const [home, out] = process.argv.slice(2)
const tracker = join(import.meta.dirname, 'mcp-server.mjs')
writeFileSync(join(home, 'mcp-servers.json'), JSON.stringify({
  servers: {
    linear: { title: 'Linear', command: 'node', args: [tracker], unprofiled: true },
    github: { title: 'GitHub', url: 'https://api.githubcopilot.com/mcp/', auth: { type: 'api-key' } },
    notion: { title: 'Notion', url: 'https://mcp.notion.com/mcp', auth: { type: 'oauth' } },
    atlassian: { title: 'Atlassian', url: 'https://mcp.atlassian.com/v1/mcp', auth: { type: 'oauth', clientId: 'superego-desktop' } },
    sentry: { title: 'Sentry', command: 'npx', args: ['-y', '@sentry/mcp-server'], env: { SENTRY_HOST: 'sentry.io' }, auth: { type: 'env', names: ['SENTRY_ACCESS_TOKEN'] }, enabled: false },
    docs: { command: 'npx', args: ['-y', '@acme/docs-mcp', '--root', '/srv/docs'], allowed: false },
  },
}, null, 2))

// Atlassian signed in three days ago, its token renewed on its own (never used: the server isn't reached).
const day = 86_400_000
writeFileSync(join(home, 'mcp-auth.json'), JSON.stringify({
  'oauth:https://mcp.atlassian.com/v1/mcp': {
    at: Date.now() - 3 * day, expiresAt: Date.now() + 40 * 60_000,
    tokens: { access_token: 'showcase', token_type: 'Bearer', refresh_token: 'showcase', scope: 'read:jira-work write:jira-work' },
    discovery: { authorizationServerUrl: 'https://auth.atlassian.com' }, client: { client_id: 'superego-desktop' },
  },
}, null, 2), { mode: 0o600 })

let ids = 0
const call = (name, args) => ({ type: 'toolCall', id: `mcp-${++ids}`, name, arguments: args })
const turns = [
  { content: [{ type: 'text', text: "I'll check what's open first." }, call('mcp__linear__list_issues', { team: 'ENG', state: 'Todo' })], stopReason: 'toolUse' },
  { content: [call('mcp__linear__create_issue', { team: 'ENG', title: 'CSV import skips rows with quoted commas', description: 'Rows like `"Smith, J",12.00` are dropped: the parser splits on every comma.' })], stopReason: 'toolUse' },
  { content: [call('mcp__linear__chart', { team: 'ENG' })], stopReason: 'toolUse' },
  { content: [{ type: 'text', text: 'Filed **ENG-413**, *CSV import skips rows with quoted commas*, in ENG. The team has 14 open issues; the chart shows them coming down this week.' }], stopReason: 'stop' },
]
writeFileSync(out, turns.map((message) => JSON.stringify({ at: 0, provider: 'showcase', model: 'showcase', message: { role: 'assistant', ...message } })).join('\n') + '\n')
