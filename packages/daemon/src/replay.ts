// Record real model turns and play them back. `<ID>_RECORD=<file>` appends every answer the models give to a JSONL file;
// `<ID>_MODEL=replay:<file>` serves those answers again, in order, streamed at a readable pace. Development gets real
// shapes (thinking, tool calls, long answers) without paying for turns. Replayed tool calls run for real, in the
// thread's directory, as the original ones did.
//
// Threads running at once race for the next turn. A turn with `thread` (written by hand: recording leaves it out) is
// only for a conversation whose first user message holds that text, so a scripted lead and its children each take
// their own turns, in order, whichever asks first. A thread's id, unknown when the turns are written, is `{{thread:<its
// title>}}` in a turn: the id the conversation so far gives it, in a link (`[<title>](thread:<id>)`) as thread_start's
// result has one.
import { appendFileSync, readFileSync } from 'node:fs'
import type { AssistantMessage, Message } from '@earendil-works/pi-ai'
import { fauxAssistantMessage, fauxProvider, type FauxResponseStep } from '@earendil-works/pi-ai'
import type { Provider } from '@earendil-works/pi-ai/models'
import { wrapStreams } from './provider-streams.ts'

type Recorded = { at: number; provider: string; model: string; message: AssistantMessage; thread?: string }

/** `provider`, appending each answer it finishes to `path`. Failed and aborted answers are left out. */
export function withRecording<T extends Provider>(provider: T, path: string): T {
  return wrapStreams(provider, (call, model, ...rest) => {
    const stream = call(model, ...rest)
    void stream.result().then((message) => {
      if (message.stopReason === 'error' || message.stopReason === 'aborted') return
      const line: Recorded = { at: Date.now(), provider: provider.id, model: model.id, message }
      appendFileSync(path, JSON.stringify(line) + '\n', { mode: 0o600 })
    }, () => {})
    return stream
  })
}

/** The text of a conversation's first user message: what a turn's `thread` is looked for in. */
function firstAsked(messages: readonly Message[]) {
  const first = messages.find((m) => m.role === 'user')
  if (!first) return ''
  return typeof first.content === 'string' ? first.content : first.content.map((b) => b.type === 'text' ? b.text : '').join('\n')
}

/** A turn's content with each `{{thread:<title>}}` the id linked by that title in `messages` (left as it is if none is). */
function withIds(content: AssistantMessage['content'], messages: readonly Message[]): AssistantMessage['content'] {
  const json = JSON.stringify(content)
  if (!json.includes('{{thread:')) return content
  const said = JSON.stringify(messages)
  return JSON.parse(json.replace(/\{\{thread:(.+?)\}\}/g, (all, title: string) =>
    new RegExp(`\\[${title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\]\\(thread:([^)\\\\]+)\\)`).exec(said)?.[1] ?? all))
}

/**
 * A provider that answers with the turns recorded in `path`, one per request (the first not taken yet that's for any
 * thread or for this one), then says it ran out.
 */
export function replayProvider(path: string, tokensPerSecond = 120) {
  const turns: (Recorded | undefined)[] = readFileSync(path, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as Recorded)
  const total = turns.length
  const faux = fauxProvider({ provider: 'replay', api: 'replay', models: [{ id: 'replay', name: `Replay (${total} turns)`, reasoning: true }], tokensPerSecond })
  const step: FauxResponseStep = (context) => {
    faux.appendResponses([step])
    const asked = firstAsked(context.messages)
    const next = turns.findIndex((t) => t && (t.thread === undefined || asked.includes(t.thread)))
    const turn = turns[next]?.message
    if (!turn) return fauxAssistantMessage(`Replay finished: all ${total} recorded turns${turns.some(Boolean) ? ' for this thread' : ''} were used.`)
    turns[next] = undefined
    return fauxAssistantMessage(withIds(turn.content, context.messages) as Parameters<typeof fauxAssistantMessage>[0], { stopReason: turn.stopReason, ...(turn.errorMessage ? { errorMessage: turn.errorMessage } : {}) })
  }
  faux.setResponses([step])
  return faux
}
