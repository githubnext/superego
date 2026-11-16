// agent-ui, daemon half: the agent's ways to ask the user things and show them UI of its own.
// - `ask_user` puts a question in words, `ask_ui` puts blocks; both wait. While they do, the thread shows as blocked
//   (needs you), and what it waits on is published in the thread's scope, oldest first, for every client: any of them
//   answers it (`agent-ui.answer`).
// - `show_ui` draws blocks in the transcript and returns at once; what's pressed later is the user's next message.
// - `open_ui` and `update_ui` draw blocks in a `ui` pane beside the thread, kept with the thread (this extension's
//   state in its document, so it survives a restart and goes with the thread when it's forked or archived) and
//   published from there (`state({ publish })`) for the pane to draw.
// The blocks are described once, in a prompt section the tools' descriptions point to.
import { randomUUID } from 'node:crypto'
import { defineExtension, defineTool, section } from '@earendil-works/pi-durable'
import { arr, obj, opt, str, union, unknown } from '@earendil-works/pi-schema'
import { BLOCKS_GUIDE, blocksParameter, checkBlocks, type Reply, type Value } from '@superego/blocks'
import { defineAction, defineDaemonExtension } from '@superego/daemon'
import { RpcError } from '@superego/protocol'
import {
  about, ANSWER, ASK, ASK_USER, GUIDE_SECTION, KIND, OPEN, PANES, SHOW, UPDATE, WAITING,
  type AskDetails, type Option, type PaneSpec, type QuestionDetails, type Spec, type ThreadPanes, type Waiting,
} from './shared.ts'

/** The panes' UI a thread keeps: the newest this many, so its state (and the value sent to its windows) stays small. */
const KEPT = 20

const BLOCKS = `Blocks are described in your instructions under ${GUIDE_SECTION}.`

const GUIDE = `${SHOW}, ${ASK}, ${OPEN} and ${UPDATE} draw UI you write as a list of blocks, top to bottom.\n${BLOCKS_GUIDE}`

const ASK_USER_DESCRIPTION = 'Ask the user a question and wait for their answer. Use it for decisions and facts only they have, not for '
  + 'permission to do what was asked. The question is Markdown: any context first, then the question itself as its '
  + 'last paragraph. Offer options when the likely answers are known (a short label each, with a description where '
  + 'the label needs one); they can still answer freely.'

const SHOW_DESCRIPTION = `Show the user UI in your answer, in the transcript, and return at once. When they later press a button or pick a choice, it arrives as their next message (like "→ Option B", with any inputs' values); don't wait for it.
Use it when something is clearer seen than read: options side by side with previews, a comparison table, a small dashboard or chart, or a few next steps to offer as buttons. Don't use it for ordinary answers, explanations, summaries or code: Markdown text is better for those, and most replies need no UI. To wait for the user's answer before carrying on, use ${ASK}. ${BLOCKS}`

const ASK_DESCRIPTION = `Ask the user something through UI and wait for their answer: options with descriptions or previews, a short form, buttons. Returns JSON { values, button }: values by input id; button is the pressed button's id, or "submit" (the form's submit button, or picking from a lone single choice). If they answer in words instead, it has "text".
Use it when the decision has several parts or the options need showing. For a plain question, use ${ASK_USER}; don't build a form for one yes/no. "submit" labels the submit button. ${BLOCKS}`

const OPEN_DESCRIPTION = `Open a pane beside the conversation showing UI you write as blocks, or redraw one (same id). Returns at once; what the user presses or picks there arrives as their next message (like "→ Deploy", with any inputs' values). Change it later with ${UPDATE}.
Use it for something the user keeps looking at or comes back to while you work: a dashboard, a checklist, a control panel, a comparison, a live chart. For a one-off answer, write text; for a question that needs an answer before you go on, ask in the conversation. ${BLOCKS}`

const UPDATE_DESCRIPTION = `Redraw the UI of a pane you opened with ${OPEN}, by its id: new blocks replace the old (and the title, if given). It doesn't reopen a pane the user closed; ${OPEN} with the same id does.`

/** An option as given (a label, or a label and a description), as the UI shows it. */
const optionOf = (option: string | Option): Option =>
  typeof option === 'string' ? { label: option } : { label: option.label, ...(option.description ? { description: option.description } : {}) }

const specOf = ({ title, blocks, submit }: { title?: string | undefined; blocks: unknown; submit?: string | undefined }): Spec =>
  ({ ...(title ? { title } : {}), blocks: checkBlocks(blocks), ...(submit ? { submit } : {}) })

export default defineDaemonExtension({
  ...about,
  setup(superego) {
    const threadOf = (conversationId: number) => superego.threads.of(conversationId) ?? String(conversationId)

    // ── Waiting on the user: one queue for both asking tools, oldest first ────────────────────────────────────────
    const waiting = superego.scopedValue<Waiting[]>(WAITING, [])
    const answers = new Map<string, { tool: Waiting['tool']; resolve(reply: Reply): void }>()

    /** Publish `entry` as waiting until it's answered (or the call is withdrawn): the answer. */
    async function wait(entry: Waiting, signal: AbortSignal | undefined): Promise<Reply> {
      // Stopped before it was asked (while its details were kept): withdrawn at once, never published.
      if (signal?.aborted) throw new Error('The question was withdrawn')
      const answered = new Promise<Reply>((resolve, reject) => {
        answers.set(entry.id, { tool: entry.tool, resolve })
        signal?.addEventListener('abort', () => reject(new Error('The question was withdrawn')), { once: true })
      })
      waiting.update(entry.thread, (list) => [...list.filter((w) => w.id !== entry.id), entry])
      superego.invalidate()
      try {
        return await answered
      } finally {
        answers.delete(entry.id)
        const left = waiting.get(entry.thread).filter((w) => w.id !== entry.id)
        if (left.length) waiting.set(entry.thread, left)
        else waiting.delete(entry.thread)
        superego.invalidate()
      }
    }

    superego.status((thread) => {
      const first = waiting.get(thread)[0]
      if (!first) return undefined
      return { kind: 'question', msg: first.tool === ASK_USER ? first.question : first.title ?? 'Waiting for your answer' }
    })

    superego.action(defineAction({
      id: ANSWER, title: 'Answer what the agent is waiting on', runs: 'machine', expose: ['ui', 'cli'],
      params: obj({ id: str(), text: opt(str()), values: opt(unknown()), button: opt(str()) }),
      run({ id, text, values, button }) {
        const waiter = answers.get(id)
        if (!waiter) throw new RpcError('not_found', 'That question is no longer waiting')
        const words = text?.trim()
        if (text !== undefined && !words) throw new RpcError('invalid', 'An answer in words needs some words')
        if (waiter.tool === ASK_USER && words === undefined) throw new RpcError('invalid', 'A question is answered in words (text)')
        if (values !== undefined && (typeof values !== 'object' || values === null || Array.isArray(values))) throw new RpcError('invalid', 'values must be an object')
        // Taken now, so a second answer at the same moment (another window) is told it's no longer waiting.
        answers.delete(id)
        waiter.resolve({ values: (values ?? {}) as Record<string, Value>, ...(button ? { button } : {}), ...(words !== undefined ? { text: words } : {}) })
        return null
      },
    }))

    // ── Panes: kept with each thread, and published in its scope for its panes ───────────────────────────────────────
    const panes = superego.state<ThreadPanes>({ publish: { key: PANES, empty: {} } })
    const keep = async (thread: string, spec: PaneSpec) => {
      await panes.update(thread, (current) => {
        const all: ThreadPanes = { ...current, [spec.id]: spec }
        for (const id of Object.keys(all).sort((a, b) => all[a]!.at - all[b]!.at).slice(0, Math.max(0, Object.keys(all).length - KEPT))) delete all[id]
        return all
      })
    }

    superego.agent(defineExtension({
      name: 'agent-ui',
      sections: [section(GUIDE_SECTION, () => GUIDE)],
      tools: [
        defineTool({
          name: ASK_USER,
          description: ASK_USER_DESCRIPTION,
          parameters: obj({
            question: str({ minLength: 1 }),
            options: opt(arr(union([str(), obj({ label: str({ minLength: 1 }), description: opt(str()) })]))),
          }),
          // A restart while waiting asks again rather than giving up: the question still needs an answer.
          replay: 'safe',
          async execute(args, api, context) {
            const details: QuestionDetails = { id: api.callId, question: args.question, options: (args.options ?? []).map(optionOf) }
            await api.details(details, context)
            const { text = '' } = await wait({ ...details, tool: ASK_USER, thread: threadOf(api.conversationId), at: api.now() }, context.abortSignal)
            return { output: [{ type: 'text', text: `The user answered: ${text}` }], details: { ...details, answer: text } }
          },
        }),
        defineTool({
          name: SHOW,
          description: SHOW_DESCRIPTION,
          parameters: obj({ title: opt(str()), blocks: blocksParameter() }),
          replay: 'safe',
          async execute(args) {
            return {
              output: [{ type: 'text', text: 'Shown. Whatever the user presses or picks arrives as their next message.' }],
              details: specOf(args),
            }
          },
        }),
        defineTool({
          name: ASK,
          description: ASK_DESCRIPTION,
          parameters: obj({ title: opt(str({ description: 'What you are asking, in a few words' })), blocks: blocksParameter(), submit: opt(str()) }),
          // As ask_user: asked again after a restart.
          replay: 'safe',
          async execute(args, api, context) {
            const details: AskDetails = { id: api.callId, ...specOf(args) }
            await api.details(details, context)
            const answer = await wait({ ...details, tool: ASK, thread: threadOf(api.conversationId), at: api.now() }, context.abortSignal)
            const result = answer.text !== undefined ? { text: answer.text } : { values: answer.values, button: answer.button ?? null }
            return { output: [{ type: 'text', text: JSON.stringify(result) }], details: { ...details, answer } }
          },
        }),
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
            await superego.dispatch('pane.open', { thread, kind: KIND, title: args.title, params: { id } })
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
            const current = (await panes.get(thread))?.[args.id]
            if (!current) throw new Error(`No UI pane "${args.id}" in this conversation. Open it with ${OPEN} first.`)
            const title = args.title ?? current.title
            await keep(thread, { ...current, title, blocks, at: api.now() })
            // A new title names its open panes' tabs too.
            if (args.title && args.title !== current.title) {
              const { panes: open = [] } = await superego.threads.get(thread)
              for (const pane of open.filter((p) => p.kind === KIND && (p.params as { id?: string } | undefined)?.id === args.id)) {
                await superego.dispatch('pane.update', { thread, pane: pane.id, title })
              }
            }
            return { output: [{ type: 'text', text: `Updated the pane "${title}".` }], details: { id: args.id, title, blocks } }
          },
        }),
      ],
    }))
  },
})
