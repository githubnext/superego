// Well-known MCP servers: what Settings → MCP servers → Add server offers to fill in, and what Ego adds by name ("connect
// Linear"). Each is a config as `mcp-servers.json` keeps it, with no secrets: the user signs in, or sets the key, after.
import type { ServerConfig } from './shared.ts'

export type CatalogEntry = {
  /** Its name here: the tools' prefix, and what a profile's `mcp` names it by. */
  name: string
  title: string
  /** What it gives an agent, in a line. */
  description: string
  server: ServerConfig
  /** What the user does once it's added, when it needs more than Sign in: where to get a key, say. */
  setup?: string
}

export const CATALOG: CatalogEntry[] = [
  {
    name: 'linear', title: 'Linear', description: 'Issues, projects and comments in Linear.',
    server: { title: 'Linear', url: 'https://mcp.linear.app/mcp', auth: { type: 'oauth' } },
  },
  {
    name: 'github', title: 'GitHub', description: 'Repositories, issues, pull requests and Actions on GitHub.',
    server: { title: 'GitHub', url: 'https://api.githubcopilot.com/mcp/', auth: { type: 'api-key' } },
    setup: 'Set a personal access token (github.com/settings/tokens) as its key.',
  },
  {
    name: 'sentry', title: 'Sentry', description: 'Errors, issues and releases in Sentry.',
    server: { title: 'Sentry', command: 'npx', args: ['-y', '@sentry/mcp-server'], env: { SENTRY_HOST: 'sentry.io' }, auth: { type: 'env', names: ['SENTRY_ACCESS_TOKEN'] } },
    setup: 'Set SENTRY_ACCESS_TOKEN to a user auth token (Sentry → Settings → Auth Tokens).',
  },
  {
    name: 'notion', title: 'Notion', description: 'Pages and databases in Notion.',
    server: { title: 'Notion', url: 'https://mcp.notion.com/mcp', auth: { type: 'oauth' } },
  },
  {
    name: 'stripe', title: 'Stripe', description: 'Customers, payments and the Stripe docs.',
    server: { title: 'Stripe', url: 'https://mcp.stripe.com', auth: { type: 'oauth' } },
  },
  {
    name: 'supabase', title: 'Supabase', description: 'Projects, databases and logs on Supabase.',
    server: { title: 'Supabase', url: 'https://mcp.supabase.com/mcp', auth: { type: 'oauth' } },
  },
  {
    name: 'context7', title: 'Context7', description: "Libraries' current documentation, by name and version.",
    server: { title: 'Context7', url: 'https://mcp.context7.com/mcp' },
  },
  {
    name: 'playwright', title: 'Playwright', description: 'A browser of its own per thread: open pages, click, type, read them.',
    server: { title: 'Playwright', command: 'npx', args: ['-y', '@playwright/mcp@latest'], lifetime: 'thread' },
  },
  {
    name: 'chrome-devtools', title: 'Chrome DevTools', description: 'Drive Chrome and read its console, network and performance.',
    server: { title: 'Chrome DevTools', command: 'npx', args: ['-y', 'chrome-devtools-mcp@latest'], lifetime: 'thread' },
  },
  {
    name: 'figma', title: 'Figma', description: "The design open in Figma's desktop app: its frames, styles and code.",
    server: { title: 'Figma', url: 'http://127.0.0.1:3845/mcp' },
    setup: "In Figma's desktop app, turn on Preferences → Enable Dev Mode MCP Server.",
  },
]

/** A catalogue entry by its name or title, any case. */
export const fromCatalog = (name: string) => {
  const key = name.trim().toLowerCase()
  return CATALOG.find((entry) => entry.name === key || entry.title.toLowerCase() === key)
}
