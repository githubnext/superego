// suggestions, daemon half: when a run answers, a side call to the thread's own model guesses what the user might send
// next, published for the UI to offer. The machine's skills (the skills extension's `skills.list`) go with the ask, for
// one suggestion to run a skill when it fits. Anything the thread does next takes the suggestions away.
import { defineExtension, GenerationTask, hook } from '@earendil-works/pi-durable'
import { defineDaemonExtension } from '@superego/daemon'
import { about, NEXT, type Suggested } from './shared.ts'
import { offeredSkills, requestOf, suggestionsOf, transcriptOf, type SkillInfo } from './suggest.ts'

export default defineDaemonExtension({
  ...about,
  setup(superego) {
    // Watched by each thread for its own.
    const next = superego.scopedValue<Suggested | null>(NEXT, null)
    // Each thread's latest ask: an answer that comes back after the thread moved on is dropped.
    const asks = new Map<string, number>()
    const forget = (thread: string) => {
      asks.set(thread, (asks.get(thread) ?? 0) + 1)
      next.delete(thread)
    }
    // The machine's skills, from the skills extension; none while it's switched off (its method gone).
    const listSkills = async (): Promise<SkillInfo[]> => {
      if (!superego.extensions().some((e) => e.name === 'skills' && e.on)) return []
      try {
        return await superego.call('skills.list') as SkillInfo[]
      } catch (error) {
        // Suggestions without skills are still worth offering: the failure is logged, and they go on without.
        console.error('suggestions: listing skills:', error)
        return []
      }
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
          // Not awaited: the run ends now, and the suggestions follow when they come. It outlives the hook, not the
          // extension: torn down (switched off, the daemon stopping), the call is cut off.
          const skills = offeredSkills(await listSkills(), transcript)
          const { systemPrompt, prompt } = requestOf(transcript, skills)
          if (superego.signal.aborted) return undefined
          void models.completeSimple(model, {
            systemPrompt,
            messages: [{ role: 'user', content: prompt, timestamp: Date.now() }],
          }, { maxTokens: 300, signal: AbortSignal.any([superego.signal, AbortSignal.timeout(30_000)]) }).then((reply) => {
            if (superego.signal.aborted || asks.get(thread) !== ask || reply.stopReason === 'error' || reply.stopReason === 'aborted') return
            const prompts = suggestionsOf(reply.content.map((b) => b.type === 'text' ? b.text : '').join(''), skills.map(({ skill }) => skill))
            if (prompts.length) next.set(thread, { prompts })
          }, () => {})
          return undefined
        },
      })],
    }))
  },
})
