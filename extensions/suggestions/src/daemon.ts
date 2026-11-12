// suggestions, daemon half: when a run answers, a side call to the thread's own model guesses what the user might send
// next, published for the UI to offer. Anything the thread does next takes the suggestions away.
import { defineExtension, GenerationTask, hook } from '@earendil-works/pi-durable'
import { defineDaemonExtension } from '@superego/daemon'
import { NEXT, type Suggested } from './shared.ts'
import { promptsOf, SYSTEM, transcriptOf } from './suggest.ts'

export default defineDaemonExtension({
  name: 'suggestions',
  title: 'Prompt suggestions',
  description: 'After each answer, suggest what you might send next.',
  setup(superego) {
    const next = superego.value<Record<string, Suggested>>(NEXT, {})
    // Each thread's latest ask: an answer that comes back after the thread moved on is dropped.
    const asks = new Map<string, number>()
    const forget = (thread: string) => {
      asks.set(thread, (asks.get(thread) ?? 0) + 1)
      if (thread in next.get()) next.update(({ [thread]: _gone, ...rest }) => rest)
    }
    // A thread's own conversation; not a subagent's.
    const threadOf = (conversationId: number) => {
      const thread = superego.threads.of(conversationId)
      return thread === String(conversationId) ? thread : undefined
    }

    superego.agent(defineExtension({
      name: 'suggestions',
      hooks: [hook(GenerationTask, {
        beforeRequest(_request, api) {
          const thread = threadOf(api.conversationId)
          if (thread) forget(thread)
          return undefined
        },
        async afterRun(run, api, context) {
          const thread = threadOf(api.conversationId)
          if (!thread) return undefined
          forget(thread)
          const ask = asks.get(thread)
          const { model: ref } = await (await superego.threads.conversation(thread)).agent(context)
          // A replayed thread is scripted: a side call would take the next scripted answer.
          if (!ref || ref.provider === 'replay') return undefined
          // The harness's models, kept past the hook for the call that outlives it.
          const models = api.models
          const model = models.getModel(ref.provider, ref.modelId)
          if (!model) return undefined
          const page = await api.entries({ maxEntryId: run.last, order: 'descending' }, 40, undefined, context)
          const transcript = transcriptOf([...page.items].reverse().flatMap((entry) => (entry.model ?? []) as never[]))
          if (!transcript) return undefined
          // Not awaited: the run ends now, and the suggestions follow when they come.
          void models.completeSimple(model, {
            systemPrompt: SYSTEM,
            messages: [{ role: 'user', content: transcript, timestamp: Date.now() }],
          }, { maxTokens: 300, signal: AbortSignal.timeout(30_000) }).then((reply) => {
            if (asks.get(thread) !== ask || reply.stopReason === 'error' || reply.stopReason === 'aborted') return
            const prompts = promptsOf(reply.content.map((b) => b.type === 'text' ? b.text : '').join(''))
            if (prompts.length) next.update((all) => ({ ...all, [thread]: { after: run.answer, prompts } }))
          }, () => {})
          return undefined
        },
      })],
    }))
  },
})
