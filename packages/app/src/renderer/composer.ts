// What extensions add to the composer. Completions: a provider recognises the word being typed at the caret (`$co`,
// `/skill:co`), offers items for it, and says what each puts in its place; the composer draws the menu and keeps its
// keys (↑↓ pick, ⇥ or ⏎ take, esc leaves the word). And what goes with a sent message: an extension finds the blocks
// it put in one (a skill's instructions, say) and draws them under it, kept out of the message's own text.
import type { ComponentType } from 'react'
import type { ThreadInfo } from '@superego/protocol'
import type { MachineEntry } from '../shared.ts'

/** The word a provider completes: where it starts (its trigger included) and what to look up. Providers may add their own. */
export type CompletionWord = { start: number; query: string }

/** One thing offered: `label` in the menu, `detail` beside it; taken, `insert` replaces the word (end it with a space to go on typing). */
export type Completion = { label: string; detail?: string; insert: string }

/** Where the composer is: the thread it sends to, on its machine. */
export type ComposerWhere = { machine: MachineEntry; thread: ThreadInfo }

export type CompletionProvider<W extends CompletionWord = CompletionWord> = {
  /** What its items are, for the menu's label: "Skills". */
  title: string
  /** The word at the caret this provider completes, if there is one. The first provider to find one completes it. */
  word(text: string, caret: number): W | undefined
  /** What it offers for `word`, best first. Asked again as the word changes; may take a call to the machine. */
  items(word: W, where: ComposerWhere): Completion[] | Promise<Completion[]>
}

/** The word being completed at the caret, and by which provider: the first of `providers` that finds one. */
export function completing(providers: readonly CompletionProvider<any>[], text: string, caret: number): { provider: CompletionProvider<any>; word: CompletionWord } | undefined {
  for (const provider of providers) {
    const word = provider.word(text, caret)
    if (word) return { provider, word }
  }
  return undefined
}

/** What a provider offered for a word. */
export type Offered = { provider: CompletionProvider<any>; word: CompletionWord; items: Completion[] }

/**
 * Ask `found`'s provider what it offers; `offer` gets it, unless the returned cancel came first (the word changed before
 * the answer did). A provider that fails offers nothing.
 */
export function askFor(found: { provider: CompletionProvider<any>; word: CompletionWord }, where: ComposerWhere, offer: (offered: Offered) => void): () => void {
  let current = true
  const { provider, word } = found
  const done = (items: Completion[]) => { if (current) offer({ provider, word, items }) }
  const failed = (error: unknown) => { console.error('Completing failed', error); done([]) }
  try { void Promise.resolve(provider.items(word, where)).then(done, failed) } catch (error) { failed(error) }
  return () => { current = false }
}

/** A word but its query: the same while it's typed further, another if it moved or a field of the provider's changed. */
const stem = (word: CompletionWord) => JSON.stringify({ ...word, query: undefined })

/**
 * The menu for the word being completed: what was offered for it, or for it as typed so far (the same provider and
 * stem), so the menu doesn't blink while it grows and is asked again. None once dismissed (esc) where the word starts.
 */
export function menuFor(found: { provider: CompletionProvider<any>; word: CompletionWord } | undefined, offered: Offered | undefined, dismissed?: number): Completion[] | undefined {
  if (!found || !offered || offered.provider !== found.provider || stem(offered.word) !== stem(found.word)) return undefined
  return offered.items.length && dismissed !== found.word.start ? offered.items : undefined
}

/** `text` with the word from `start` to the caret replaced by `insert`, and where the caret goes: after it. A space it ends with isn't doubled. */
export function complete(text: string, caret: number, start: number, insert: string): { text: string; caret: number } {
  const after = /\s$/.test(insert) ? text.slice(caret).replace(/^ /, '') : text.slice(caret)
  return { text: text.slice(0, start) + insert + after, caret: start + insert.length }
}

/** A block of a sent message, as the agent was given it: text, or an image. */
export type SentBlock = { type: string; text?: string; data?: string; mimeType?: string }

export type SentWith<T = any> = {
  /** What it put in a sent message: the items to draw, and the blocks (by index) they were, which the message's text leaves out. */
  read(blocks: readonly SentBlock[]): { items: T[]; blocks: number[] } | undefined
  /** Draws them under the message: a chip each, say. */
  component: ComponentType<ComposerWhere & { items: T[] }>
}

/** A sent message as `readers` find it: what each found in it, and the blocks none of them claimed. */
export function readSent<R extends SentWith>(readers: readonly R[], blocks: readonly SentBlock[]): { found: { reader: R; items: unknown[] }[]; rest: SentBlock[] } {
  const claimed = new Set<number>()
  const found: { reader: R; items: unknown[] }[] = []
  for (const reader of readers) {
    let read: ReturnType<SentWith['read']>
    try { read = reader.read(blocks) } catch (error) { console.error('Reading a sent message failed', error); continue }
    if (!read) continue
    for (const index of read.blocks) claimed.add(index)
    if (read.items.length) found.push({ reader, items: read.items })
  }
  return { found, rest: blocks.filter((_, index) => !claimed.has(index)) }
}
