// pane-ui, daemon half: UI an agent keeps in a pane beside its thread. `open_ui` draws blocks in a `ui` pane and
// `update_ui` redraws them; neither waits, and what the user presses there is sent to the thread as a message. Each
// pane's UI is kept with its thread (this extension's state in the thread's document, so it survives a restart and goes
// with the thread when it's forked or archived), and published in the thread's scope of a live value for the pane to draw.
import { randomUUID } from 'node:crypto'
import { defineExtension, defineTool } from '@earendil-works/pi-durable'
import { obj, opt, str } from '@earendil-works/pi-schema'
import { BLOCKS_GUIDE, blocksParameter, checkBlocks } from '@superego/blocks'
import { defineDaemonExtension } from '@superego/daemon'
import type { Json } from '@superego/protocol'
import { about, KIND, LOAD, OPEN, SPECS, UPDATE, type PaneSpec, type ThreadSpecs } from './shared.ts'

/** The panes' UI a thread keeps: the newest this many, so its state (and the value sent to its windows) stays small. */
const KEPT = 20

const OPEN_DESCRIPTION = `Open a pane beside the conversation showing UI you write as blocks, or redraw one (same id). Returns at once; what the user presses or picks there arrives as their next message (like "→ Deploy", with any inputs' values). Change it later with ${UPDATE}.
Use it for something the user keeps looking at or comes back to while you work: a dashboard, a checklist, a control panel, a comparison, a live chart. For a one-off answer, write text; for a question that needs an answer before you go on, ask in the conversation.

${BLOCKS_GUIDE}`

const UPDATE_DESCRIPTION = `Redraw the UI of a pane you opened with ${OPEN}, by its id: new blocks replace the old (and the title, if given). It doesn't reopen a pane the user closed; ${OPEN} with the same id does.`

export default defineDaemonExtension({
  ...about,
  setup(superego) {
    const specs = superego.scopedValue<ThreadSpecs | null>(SPECS, null)
    const state = superego.state<ThreadSpecs>()

    /** A thread's panes' UI: published already, or read from the thread and published now. */
    const load = async (thread: string): Promise<ThreadSpecs> => {
      if (specs.scopes().includes(thread)) return specs.get(thread) ?? {}
      const kept = await state.get(thread) ?? {}
      // Something published it while the state was read: that's newer.
      if (!specs.scopes().includes(thread) && !superego.signal.aborted) specs.set(thread, kept)
      return specs.get(thread) ?? kept
    }
    const keep = async (thread: string, spec: PaneSpec) => {
      const all: ThreadSpecs = { ...await load(thread), [spec.id]: spec }
      for (const id of Object.keys(all).sort((a, b) => all[a]!.at - all[b]!.at).slice(0, Math.max(0, Object.keys(all).length - KEPT))) delete all[id]
      specs.set(thread, all)
      await state.set(thread, all)
    }
    const threadOf = (conversationId: number) => superego.threads.of(conversationId) ?? String(conversationId)

    // A pane whose thread isn't published yet (after a restart, say) asks for it: read back from the thread then.
    superego.method(LOAD, async ({ thread }) => await load(thread) as Json, { params: obj({ thread: str() }) })

    // An archived thread's panes don't show: forget them here. They stay with the thread, read back when next asked for.
    superego.thread({ archived(thread) { specs.delete(thread.id) } })

    superego.agent(defineExtension({
      name: 'pane-ui',
      tools: [
        defineTool({
          name: OPEN,
          description: OPEN_DESCRIPTION,
          parameters: obj({
            id: opt(str({ minLength: 1, maxLength: 64, pattern: '^[A-Za-z0-9_.-]+$', description: 'Your name for the pane, to update it by; made up when left out' })),
            title: str({ minLength: 1, description: 'The pane’s tab title' }),
            blocks: blocksParameter(),
          }),
          replay: 'safe',
          async execute(args, api) {
            const blocks = checkBlocks(args.blocks)
            const thread = threadOf(api.conversationId)
            const id = args.id ?? randomUUID().slice(0, 6)
            await keep(thread, { id, title: args.title, blocks, at: api.now() })
            await superego.dispatch('pane.open', { id: thread, kind: KIND, title: args.title, params: { id } })
            return {
              output: [{ type: 'text', text: `Opened the pane "${args.title}" (id: ${id}). What the user presses there arrives as their next message.` }],
              details: { id, title: args.title, blocks },
            }
          },
        }),
        defineTool({
          name: UPDATE,
          description: UPDATE_DESCRIPTION,
          parameters: obj({ id: str({ minLength: 1 }), title: opt(str({ minLength: 1 })), blocks: blocksParameter() }),
          replay: 'safe',
          async execute(args, api) {
            const blocks = checkBlocks(args.blocks)
            const thread = threadOf(api.conversationId)
            const current = (await load(thread))[args.id]
            if (!current) throw new Error(`No UI pane "${args.id}" in this conversation. Open it with ${OPEN} first.`)
            const title = args.title ?? current.title
            await keep(thread, { ...current, title, blocks, at: api.now() })
            // A new title names its open panes' tabs too.
            if (args.title && args.title !== current.title) {
              const { panes = [] } = await superego.threads.get(thread)
              for (const pane of panes.filter((p) => p.kind === KIND && (p.params as { id?: string } | undefined)?.id === args.id)) {
                await superego.dispatch('pane.update', { id: thread, pane: pane.id, title })
              }
            }
            return { output: [{ type: 'text', text: `Updated the pane "${title}".` }], details: { id: args.id, title, blocks } }
          },
        }),
      ],
    }))
  },
})
