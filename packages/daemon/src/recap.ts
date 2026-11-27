// What a thread's run did, in a line, for its `done` status (`msg`) and so a notification: an extension's recap of the
// run (`superego.recap`: the tasks extension's last outcome, say), else the first sentence of its answer. Worked out
// once the run ends, before clients hear it's done.
import type { EntryRecord } from '@earendil-works/pi-durable'
import { firstSentence, NOTE_ENTRY, plainText, shorten, type Json, type Note } from '@superego/protocol'

/** A run that ended, as an extension's `recap` sees it: the tool calls it made, in order, and its answer, if any. */
export type RunRecord = {
  thread: string
  /** Its last answer, as the model wrote it (Markdown). */
  answer?: string
  /** Each tool call, oldest first: `failed` when its result was an error (bad arguments, say). */
  calls: { name: string; arguments: Json; failed: boolean }[]
}

type Block = { type: string; text?: string; id?: string; name?: string; arguments?: Json }
type Message = { role?: string; content?: unknown; toolCallId?: string; isError?: boolean }

/**
 * A thread's last run, from its newest entries (newest first): everything since the message that started it. A notice
 * (`NOTE_ENTRY`) the agent was told of during it is no message that starts one.
 */
export function lastRun(newestFirst: readonly EntryRecord[]): Omit<RunRecord, 'thread'> {
  const calls: RunRecord['calls'] = []
  const failed = new Set<string>()
  let answer: string | undefined
  for (const entry of newestFirst) {
    if (entry.kind === NOTE_ENTRY) continue
    for (const message of [...(entry.model ?? [])].reverse() as Message[]) {
      // The message the run answers: what came before is another run's.
      if (message.role === 'user') return { ...(answer ? { answer } : {}), calls }
      if (message.role === 'toolResult' && message.isError && message.toolCallId) failed.add(message.toolCallId)
      if (message.role !== 'assistant' || !Array.isArray(message.content)) continue
      const blocks = message.content as Block[]
      const said = blocks.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('').trim()
      if (said && answer === undefined) answer = said
      for (const block of [...blocks].reverse()) {
        if (block.type !== 'toolCall' || typeof block.name !== 'string') continue
        calls.unshift({ name: block.name, arguments: block.arguments ?? {}, failed: block.id !== undefined && failed.has(block.id) })
      }
    }
  }
  return { ...(answer ? { answer } : {}), calls }
}

/**
 * The recap of `run`: the first of `recaps` to say something (plain text, shortened), else its answer's first sentence.
 * A recap that throws is logged, and counts as nothing.
 */
export function recapOf(run: RunRecord, recaps: { owner: string; recap: (run: RunRecord) => string | undefined }[]): string | undefined {
  for (const { owner, recap } of recaps) {
    try {
      const said = recap(run)
      const text = said && shorten(plainText(said))
      if (text) return text
    } catch (error) {
      console.error(`Extension ${owner}: recap of thread ${run.thread} failed:`, error)
    }
  }
  return run.answer ? firstSentence(run.answer) : undefined
}

/** What a thread's newest entry says, when it's a note (an extension's notice, say): its text, plain and shortened, for its `done` status. */
export function noteRecap(newest: EntryRecord | undefined): string | undefined {
  if (newest?.kind !== NOTE_ENTRY) return undefined
  const text = (newest.data as Note | undefined)?.text
  return typeof text === 'string' && text.trim() ? shorten(plainText(text)) : undefined
}
