// Starting a fresh thread from one that can't go on (`thread.handoff`): its request grew too large for its provider,
// say. The new thread starts with a handoff: what the old one was doing, decided and left open, written by its model
// from a plain-text transcript of what it saw (images named, long tool output cut), small enough for any provider.
import type { Message } from '@earendil-works/pi-ai'
import { imageName } from './request-budget.ts'

/** How much of the transcript the handoff is written from, newest kept: about 40k tokens. */
const TRANSCRIPT_CHARS = 160_000
/** How much of a tool call's arguments, and of its result, the transcript keeps. */
const ARGS_CHARS = 400
const RESULT_CHARS = 1200
/** How much of the transcript goes in the handoff itself, when no summary could be written. */
const FALLBACK_CHARS = 24_000

/** What the model is told to write. */
export const HANDOFF_PROMPT = [
  'You write handoff notes. The transcript below is of an agent\'s conversation with its user, which can\'t go on:',
  'it grew too large for its model. A fresh agent continues the work in the same folder from your note alone.',
  '',
  'Write the note in Markdown, with these sections:',
  '## Goal: what the user wants, in their terms.',
  '## Done: what was built or found, with the files and paths involved.',
  '## Decisions: choices made and why, and what the user asked for or ruled out.',
  '## Open: what was in progress or left to do, the last request first, and anything unanswered.',
  '',
  'Be specific (names, paths, commands, numbers); leave out chatter. Don\'t address the user.',
].join('\n')

const clip = (text: string, max: number) => text.length <= max ? text : `${text.slice(0, max)}… (${(text.length - max).toLocaleString('en')} more characters)`
const words = (content: Message['content'], messages: readonly Message[], index: number) => typeof content === 'string' ? content
  : content.map((block) => block.type === 'text' ? block.text : block.type === 'image' ? `[image: ${imageName(messages, index)}]` : '').filter(Boolean).join('\n')

/** A conversation as plain text, for its handoff to be written from: its newest `max` characters. */
export function transcriptOf(messages: readonly Message[], max = TRANSCRIPT_CHARS) {
  const lines: string[] = []
  messages.forEach((message, index) => {
    if (message.role === 'user') lines.push(`USER:\n${words(message.content, messages, index)}`)
    else if (message.role === 'toolResult') lines.push(`RESULT (${message.toolName})${message.isError ? ' error' : ''}:\n${clip(words(message.content, messages, index), RESULT_CHARS)}`)
    else if (message.role === 'assistant') {
      for (const block of message.content) {
        if (block.type === 'text' && block.text.trim()) lines.push(`AGENT:\n${block.text}`)
        else if (block.type === 'toolCall') lines.push(`CALL ${block.name} ${clip(JSON.stringify(block.arguments), ARGS_CHARS)}`)
      }
    }
  })
  const text = lines.join('\n\n')
  return text.length <= max ? text : `(earlier part left out)\n\n${text.slice(-max)}`
}

/**
 * The first message of the thread that continues `from` (a link to it): the handoff its model wrote, or, when none
 * could be written (`failed`, why), the end of its transcript.
 */
export function handoffMessage(from: string, handoff: { summary: string } | { failed: string; transcript: string }) {
  const intro = `This thread continues ${from}, which grew too large for its model to go on. Carry on from where it left off: what's open first.`
  if ('summary' in handoff) return `${intro}\n\n${handoff.summary.trim()}`
  const tail = handoff.transcript.length <= FALLBACK_CHARS ? handoff.transcript : `(earlier part left out)\n\n${handoff.transcript.slice(-FALLBACK_CHARS)}`
  return `${intro}\n\nIts handoff couldn't be written (${handoff.failed}), so here's the end of its transcript instead:\n\n<transcript>\n${tail}\n</transcript>`
}
