// ask-user, daemon half: an `ask_user` tool that puts a question to the user and waits for the answer. While it waits,
// the thread shows as blocked (needs you), the question is listed live for every client, and any of them can answer.
import { defineExtension, defineTool } from '@earendil-works/pi-durable'
import { arr, obj, opt, str, union } from '@earendil-works/pi-schema'
import { defineDaemonExtension } from '@superego/daemon'
import { defineAction, RpcError } from '@superego/protocol'
import { about, ANSWER, PENDING, TOOL, type AskDetails, type Option, type Question } from './shared.ts'

/** An option as given (a label, or a label and a description), as the UI shows it. */
const optionOf = (option: string | Option): Option =>
  typeof option === 'string' ? { label: option } : { label: option.label, ...(option.description ? { description: option.description } : {}) }

export default defineDaemonExtension({
  ...about,
  setup(superego) {
    const pending = superego.value<Question[]>(PENDING, [])
    const answers = new Map<string, (answer: string) => void>()
    const settle = (id: string) => {
      answers.delete(id)
      pending.update((list) => list.filter((q) => q.id !== id))
      superego.invalidate()
    }

    superego.agent(defineExtension({
      name: 'ask-user',
      tools: [defineTool({
        name: TOOL,
        description: 'Ask the user a question and wait for their answer. Use it for decisions and facts only they have, not for '
          + 'permission to do what was asked. The question is Markdown: any context first, then the question itself as its '
          + 'last paragraph. Offer options when the likely answers are known (a short label each, with a description where '
          + 'the label needs one); they can still answer freely.',
        parameters: obj({
          question: str({ minLength: 1 }),
          options: opt(arr(union([str(), obj({ label: str({ minLength: 1 }), description: opt(str()) })]))),
        }),
        // A restart while waiting asks again rather than giving up: the question still needs an answer.
        replay: 'safe',
        async execute(args, api, context) {
          const question: Question = {
            id: api.callId, thread: String(api.conversationId), question: args.question, options: (args.options ?? []).map(optionOf), at: api.now(),
          }
          const details: AskDetails = { id: question.id, question: question.question, options: question.options }
          await api.details(details, context)
          const answered = new Promise<string>((resolve, reject) => {
            answers.set(question.id, resolve)
            context.abortSignal?.addEventListener('abort', () => reject(new Error('The question was withdrawn')), { once: true })
          })
          pending.update((list) => [...list.filter((q) => q.id !== question.id), question])
          superego.invalidate()
          try {
            const answer = await answered
            return { output: [{ type: 'text', text: `The user answered: ${answer}` }], details: { ...details, answer } }
          } finally {
            settle(question.id)
          }
        },
      })],
    }))

    superego.status((thread) => {
      const question = pending.get().find((q) => q.thread === thread)
      return question && { kind: 'question', msg: question.question }
    })

    superego.action(defineAction({
      id: ANSWER, title: 'Answer the agent’s question', runs: 'machine', expose: ['ui', 'cli'],
      params: obj({ id: str(), answer: str({ minLength: 1 }) }),
      run({ id, answer }) {
        const resolve = answers.get(id)
        if (!resolve) throw new RpcError('not_found', 'That question is no longer waiting')
        resolve(answer.trim())
        return null
      },
    }))
  },
})
