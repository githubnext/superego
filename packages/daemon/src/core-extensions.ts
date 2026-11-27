// The core's own agent parts, as extensions like any other: each optional (but Markdown), so a machine can turn it off
// and a profile can do without it. Set up first, through the same API as the bundled ones.
import { defineExtension, defineTool, GenerationTask, hook, section } from '@earendil-works/pi-durable'
import { createCodingTools, type ImageProcessor } from '@earendil-works/pi-durable/tools'
import { obj, opt, str, type Json, type Pane } from '@superego/protocol'
import { agentsInstructions } from './agents-md.ts'
import type { DaemonExtension } from './extension.ts'
import { describe, IMAGE_OMITTED, mb, REQUEST_SHRUNK, type OmittedImage, type ShrunkRequest } from './model-images.ts'
import { leaner } from './request-budget.ts'

/** How the window shows an agent's messages (Markdown.tsx), so it writes for that. */
const MARKDOWN_PROMPT = [
  'The thread shows your messages as GitHub-flavoured Markdown: tables, task lists and strikethrough render; raw HTML does not.',
  'Fenced code blocks are syntax-highlighted by their language tag (```ts, ```bash, ```diff, …), so always tag the language.',
].join('\n')

/** What a thread's transcript says of the images left out of what its model was sent (see model-images.ts). */
export function omittedNote(omitted: readonly OmittedImage[]) {
  const asked = omitted.some((image) => image.refused) ? `Asked it again without ${omitted.length === 1 ? 'it' : 'them'}.` : ''
  if (omitted.length === 1) return [`Left an image out of what the model is sent (${describe(omitted[0]!)}): ${omitted[0]!.reason}.`, asked].filter(Boolean).join(' ')
  return [`Left ${omitted.length} images out of what the model is sent:`, ...omitted.map((image) => `- ${describe(image)}: ${image.reason}`), asked].filter(Boolean).join('\n')
}

/** What a thread's transcript says when its provider refused a request as too large, and the budget it learned. */
export function shrunkNote({ provider, bytes, limit }: ShrunkRequest) {
  return `${provider} refused a request of ${mb(bytes)} as too large. Asked it again with older images and tool output left out: requests to it are kept within ${mb(limit)} from now on.`
}

export function coreExtensions({ agentsDir, where, panesOf, openPane, images, note, lean }: {
  /** The folder agents share: standing instructions in its AGENTS.md (see agents-md.ts). */
  agentsDir: string
  /** Where the agent runs, when the user's window is on another computer (see where.ts); nothing on one computer. */
  where(): string | undefined
  /** The pane kinds a thread's agent is told of, and what each shows. */
  panesOf(thread: string): { kind: string; about: string }[]
  openPane(thread: string, pane: Omit<Pane, 'id'>): Promise<Pane>
  /** What fits the images `read` gives the model. */
  images: ImageProcessor
  /** Say a line in a thread's transcript, for the user. */
  note(thread: string, text: string): Promise<void>
  /** Whether a thread is sent lean (`ThreadMeta.lean`). */
  lean(thread: string): boolean
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
        const pane = await openPane(String(api.conversationId), { kind, ...(title ? { title } : {}), ...(params !== undefined ? { params: params as Json } : {}), by: 'agent' })
        return { output: [{ type: 'text', text: `Opened the ${kind} pane (${pane.id}).` }] }
      },
    })],
    sections: [section('panes', ({ conversationId }) => {
      const kinds = panesOf(String(conversationId))
      return `Panes you can open beside this conversation with pane_open, by kind:\n${kinds.map(({ kind, about }) => `- "${kind}": ${about}`).join('\n')}`
    })],
  })
  return [
    { name: 'coding-tools', version: '1.0.0', api: '^5', title: 'Coding tools', group: 'agent', core: true, description: 'Read, write and edit files, and run commands.', setup: (s) => s.agent(createCodingTools({ images })) },
    {
      // An image the model was refused is left out of what it's sent from then on, and a request its provider refused as
      // too large is asked again smaller: the user is told, in the thread. A lean thread is sent only its newest images.
      name: 'model-images', version: '1.0.0', api: '^5', title: 'Images for the model', description: 'Say in the thread when an image is left out of what the model is sent.', required: true,
      setup: (s) => s.agent(defineExtension({
        name: 'model-images',
        hooks: [hook(GenerationTask, {
          beforeRequest({ messages }, api) {
            const thread = s.threads.of(Number(api.conversationId))
            return thread && lean(thread) ? { messages: leaner(messages) } : undefined
          },
          async afterResponse(message, api) {
            const omitted = (message.diagnostics ?? []).filter((d) => d.type === IMAGE_OMITTED).map((d) => d.details as OmittedImage)
            const shrunk = (message.diagnostics ?? []).filter((d) => d.type === REQUEST_SHRUNK).map((d) => d.details as ShrunkRequest)
            const thread = omitted.length || shrunk.length ? s.threads.of(Number(api.conversationId)) : undefined
            if (thread && omitted.length) await note(thread, omittedNote(omitted))
            if (thread) for (const one of shrunk) await note(thread, shrunkNote(one))
          },
        })],
      })),
    },
    {
      // How messages show is the window's, not something to turn off.
      name: 'markdown', version: '1.0.0', api: '^5', title: 'Markdown', description: 'Know how the thread shows messages, and write for it.', required: true,
      setup: (s) => s.agent(defineExtension({ name: 'markdown', sections: [section('markdown', () => MARKDOWN_PROMPT)] })),
    },
    {
      // Which computer the agent is on, next to the user's, is a fact of its world, not something to turn off.
      name: 'where', version: '1.0.0', api: '^5', title: 'Where it runs', description: 'Know when the user\'s window is on another computer than the agent.', required: true,
      setup: (s) => s.agent(defineExtension({ name: 'where', sections: [section('where', () => where())] })),
    },
    {
      name: 'panes', version: '1.0.0', api: '^5', title: 'Panes', group: 'beside', core: true, description: 'Open panes beside a thread: files, other threads, and the kinds extensions add.',
      // The window's built-in kinds (its panes.tsx); extensions describe their own (git's Changes, browser's).
      panes: { editor: '{ path }: a file, for the user to read and edit', thread: '{ thread }: another conversation' },
      setup: (s) => s.agent(panesPart),
    },
    {
      name: 'agents-md', version: '1.0.0', api: '^5', title: 'AGENTS.md', group: 'agent', core: true, description: 'Follow the standing instructions in AGENTS.md files.',
      setup: (s) => s.agent(defineExtension({ name: 'agents-md', sections: [section('agents_md', async ({ env }) => agentsInstructions(agentsDir, env?.cwd))] })),
    },
  ]
}
