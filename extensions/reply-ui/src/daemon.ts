// reply-ui, daemon half: UI an agent puts in its reply. `show_ui` draws blocks in the transcript and returns at once;
// what the user clicks later comes back as their next message. `ask_ui` draws them and waits, as ask_user does: the
// thread shows as blocked, the UI is published in the thread's scope for every client, and any of them can answer.
import { defineExtension, defineTool } from '@earendil-works/pi-durable'
import { obj, opt, str, unknown } from '@earendil-works/pi-schema'
import { BLOCKS_GUIDE, blocksParameter, checkBlocks, type Reply, type Value } from '@superego/blocks'
import { defineDaemonExtension } from '@superego/daemon'
import { defineAction, RpcError } from '@superego/protocol'
import { about, ANSWER, ASK, ASKING, SHOW, type AskDetails, type Asking, type Spec } from './shared.ts'

const SHOW_DESCRIPTION = `Show the user UI in your reply, in the transcript, and return at once. When they later press a button or pick a choice, it arrives as their next message (like "→ Option B", with any inputs' values); don't wait for it.
Use it when something is clearer seen than read: options side by side with previews, a comparison table, a small dashboard or chart, or a few next steps to offer as buttons. Don't use it for ordinary answers, explanations, summaries or code: Markdown text is better for those, and most replies need no UI. To wait for the user's answer before carrying on, use ${ASK}.

${BLOCKS_GUIDE}`

const ASK_DESCRIPTION = `Ask the user something through UI and wait for their answer: options with descriptions or previews, a short form, buttons. Returns JSON { values, action }: values by input id; action is the pressed button's id, or "submit" (the form's submit button, or picking from a lone single choice). If they answer in words instead, it has "text".
Use it when the decision has several parts or the options need showing. For a plain question, ask in text (or with ask_user); don't build a form for one yes/no. Blocks as for ${SHOW}; "submit" labels the submit button.`

export default defineDaemonExtension({
  ...about,
  setup(superego) {
    // Each thread's waiting UI, in its own scope: a window showing a thread hears only that thread's.
    const asking = superego.scopedValue<Asking[]>(ASKING, [])
    const answers = new Map<string, (reply: Reply) => void>()
    const settle = ({ id, thread }: Asking) => {
      answers.delete(id)
      const left = asking.get(thread).filter((a) => a.id !== id)
      if (left.length) asking.set(thread, left)
      else asking.delete(thread)
      superego.invalidate()
    }
    const spec = ({ title, blocks, submit }: { title?: string | undefined; blocks: unknown; submit?: string | undefined }): Spec =>
      ({ ...(title ? { title } : {}), blocks: checkBlocks(blocks), ...(submit ? { submit } : {}) })

    superego.agent(defineExtension({
      name: 'reply-ui',
      tools: [
        defineTool({
          name: SHOW,
          description: SHOW_DESCRIPTION,
          parameters: obj({ title: opt(str()), blocks: blocksParameter() }),
          replay: 'safe',
          async execute(args) {
            return {
              output: [{ type: 'text', text: 'Shown. Whatever the user presses or picks arrives as their next message.' }],
              details: spec(args),
            }
          },
        }),
        defineTool({
          name: ASK,
          description: ASK_DESCRIPTION,
          parameters: obj({ title: opt(str({ description: 'What you are asking, in a few words' })), blocks: blocksParameter(), submit: opt(str()) }),
          // A restart while waiting asks again rather than giving up: it still needs an answer.
          replay: 'safe',
          async execute(args, api, context) {
            const details: AskDetails = { id: api.callId, ...spec(args) }
            const waiting: Asking = { ...details, thread: String(api.conversationId), at: api.now() }
            await api.details(details, context)
            const answered = new Promise<Reply>((resolve, reject) => {
              answers.set(waiting.id, resolve)
              context.abortSignal?.addEventListener('abort', () => reject(new Error('The question was withdrawn')), { once: true })
            })
            asking.update(waiting.thread, (list) => [...list.filter((a) => a.id !== waiting.id), waiting])
            superego.invalidate()
            try {
              const answer = await answered
              const result = answer.text !== undefined ? { text: answer.text } : { values: answer.values, action: answer.action ?? null }
              return { output: [{ type: 'text', text: JSON.stringify(result) }], details: { ...details, answer } }
            } finally {
              settle(waiting)
            }
          },
        }),
      ],
    }))

    superego.status((thread) => {
      const first = asking.get(thread)[0]
      return first && { kind: 'question', msg: first.title ?? 'Waiting for your answer' }
    })

    superego.action(defineAction({
      id: ANSWER, title: 'Answer UI the agent is waiting on', runs: 'machine', expose: ['ui', 'cli'],
      params: obj({ id: str(), values: opt(unknown()), action: opt(str()), text: opt(str()) }),
      run({ id, values, action, text }) {
        const resolve = answers.get(id)
        if (!resolve) throw new RpcError('not_found', 'That question is no longer waiting')
        if (values !== undefined && (typeof values !== 'object' || values === null || Array.isArray(values))) throw new RpcError('invalid', 'values must be an object')
        if (text !== undefined && !text.trim()) throw new RpcError('invalid', 'An answer in words needs some words')
        resolve({ values: (values ?? {}) as Record<string, Value>, ...(action ? { action } : {}), ...(text !== undefined ? { text: text.trim() } : {}) })
        return null
      },
    }))
  },
})
