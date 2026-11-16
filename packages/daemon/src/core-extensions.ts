// The core's own agent parts, as extensions like any other: each optional (but Markdown), so a machine can turn it off
// and a profile can do without it. Set up first, through the same API as the bundled ones.
import { defineExtension, defineTool, section } from '@earendil-works/pi-durable'
import { createCodingTools } from '@earendil-works/pi-durable/tools'
import { obj, opt, str, type Json, type Pane } from '@superego/protocol'
import { agentsInstructions } from './agents-md.ts'
import type { DaemonExtension } from './extension.ts'

/** How the window shows an agent's messages (Markdown.tsx), so it writes for that. */
const MARKDOWN_PROMPT = [
  'The thread shows your messages as GitHub-flavoured Markdown: tables, task lists and strikethrough render; raw HTML does not.',
  'Fenced code blocks are syntax-highlighted by their language tag (```ts, ```bash, ```diff, …), so always tag the language.',
].join('\n')

export function coreExtensions({ agentsDir, panesOf, openPane }: {
  /** The folder agents share: standing instructions in its AGENTS.md (see agents-md.ts). */
  agentsDir: string
  /** The pane kinds a thread's agent is told of, and what each shows. */
  panesOf(thread: string): { kind: string; about: string }[]
  openPane(thread: string, pane: Omit<Pane, 'id'>): Promise<Pane>
}): DaemonExtension[] {
  // Panes: the agent opens them beside its thread (a file, another thread, an extension's or a profile's own), from the
  // kinds its instructions list.
  const panesPart = defineExtension({
    name: 'panes',
    tools: [defineTool({
      name: 'pane_open',
      description: 'Open a pane beside this conversation for the user to look at. The kinds there are, and the params each takes, are listed in your instructions under panes.',
      parameters: obj({ kind: str({ minLength: 1 }), title: opt(str()), params: opt(obj({}, { open: true, description: 'What the pane shows, as an object: { "path": "notes/a.md" }, not a string of JSON.' })) }),
      async execute({ kind, title, params }, api) {
        // Only the kinds this thread is told of: another (its extension off, or gone without) would be kept but not drawn.
        const kinds = panesOf(String(api.conversationId)).map((k) => k.kind)
        if (!kinds.includes(kind)) throw new Error(`There is no "${kind}" pane here. The kinds there are: ${kinds.map((k) => `"${k}"`).join(', ')}.`)
        const pane = await openPane(String(api.conversationId), { kind, ...(title ? { title } : {}), ...(params !== undefined ? { params: params as Json } : {}) })
        return { output: [{ type: 'text', text: `Opened the ${kind} pane (${pane.id}).` }] }
      },
    })],
    sections: [section('panes', ({ conversationId }) => {
      const kinds = panesOf(String(conversationId))
      return `Panes you can open beside this conversation with pane_open, by kind:\n${kinds.map(({ kind, about }) => `- "${kind}": ${about}`).join('\n')}`
    })],
  })
  return [
    { name: 'coding-tools', version: '1.0.0', api: '^2', title: 'Coding tools', description: 'Read, write and edit files, and run commands.', setup: (s) => s.agent(createCodingTools()) },
    {
      // How messages show is the window's, not something to turn off.
      name: 'markdown', version: '1.0.0', api: '^2', title: 'Markdown', description: 'Know how the thread shows messages, and write for it.', required: true,
      setup: (s) => s.agent(defineExtension({ name: 'markdown', sections: [section('markdown', () => MARKDOWN_PROMPT)] })),
    },
    {
      name: 'panes', version: '1.0.0', api: '^2', title: 'Panes', description: 'Open panes beside a thread: files, other threads, and the kinds extensions add.',
      setup(s) {
        s.agent(panesPart)
        // The window's built-in kinds (its panes.tsx); extensions describe their own (git's Changes, web-panes').
        s.pane('editor', '{ path }: a file, for the user to read and edit')
        s.pane('thread', '{ thread }: another conversation')
      },
    },
    {
      name: 'agents-md', version: '1.0.0', api: '^2', title: 'AGENTS.md', description: 'Follow the standing instructions in AGENTS.md files.',
      setup: (s) => s.agent(defineExtension({ name: 'agents-md', sections: [section('agents_md', async ({ env }) => agentsInstructions(agentsDir, env?.cwd))] })),
    },
  ]
}
