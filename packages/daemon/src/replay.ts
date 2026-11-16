// Record real model turns and play them back. `<ID>_RECORD=<file>` appends every answer the models give to a JSONL file;
// `<ID>_MODEL=replay:<file>` serves those answers again, in order, streamed at a readable pace. Development gets real
// shapes (thinking, tool calls, long answers) without paying for turns. Replayed tool calls run for real, in the
// thread's directory, as the original ones did.
import { appendFileSync, readFileSync } from 'node:fs'
import type { AssistantMessage } from '@earendil-works/pi-ai'
import { fauxAssistantMessage, fauxProvider, type FauxResponseStep } from '@earendil-works/pi-ai'
import type { Provider } from '@earendil-works/pi-ai/models'
import { wrapStreams } from './provider-streams.ts'

type Recorded = { at: number; provider: string; model: string; message: AssistantMessage }

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

/** A provider that answers with the turns recorded in `path`, one per request, then says it ran out. */
export function replayProvider(path: string, tokensPerSecond = 120) {
  const turns = readFileSync(path, 'utf8').split('\n').filter(Boolean).map((line) => (JSON.parse(line) as Recorded).message)
  const faux = fauxProvider({ provider: 'replay', api: 'replay', models: [{ id: 'replay', name: `Replay (${turns.length} turns)`, reasoning: true }], tokensPerSecond })
  let next = 0
  const step: FauxResponseStep = () => {
    faux.appendResponses([step])
    const turn = turns[next++]
    if (!turn) return fauxAssistantMessage(`Replay finished: all ${turns.length} recorded turns were used.`)
    return fauxAssistantMessage(turn.content as Parameters<typeof fauxAssistantMessage>[0], { stopReason: turn.stopReason })
  }
  faux.setResponses([step])
  return faux
}
