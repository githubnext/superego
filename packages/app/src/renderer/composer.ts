// What extensions add to the composer. Completions: a provider recognises the word being typed at the caret (`$co`,
// `/skill:co`), offers items for it, and says what each puts in its place; the composer draws the menu and keeps its
// keys (↑↓ pick, ⇥ or ⏎ take, esc leaves the word). Providers that find the same word share one menu (`/` opening the
// message: the composer's commands and skills). Things extensions name are offered as `@` is typed (`MentionSource`:
// the Mentions extension completes them). And what goes with a sent message: an extension finds the blocks it put in one
// (a skill's instructions, say) and draws them under it, kept out of the message's own text.
import type { ComponentType, ReactNode } from 'react'
import type { ThreadInfo } from '@superego/protocol'
import type { MachineEntry } from '../shared/bridge.ts'

/** The word a provider completes: where it starts (its trigger included) and what to look up. Providers may add their own. */
export type CompletionWord = { start: number; query: string }

/**
 * One thing offered: `label` in the menu, `detail` beside it, `icon` before it (to tell kinds apart in one menu); taken,
 * `insert` replaces the word (end it with a space to go on typing). `submit`: a command, run as it's chosen. ⏎ (or a
 * click) takes it and sends the message as it then is; ⇥ only puts it in, to type more after it.
 */
export type Completion = { label: string; detail?: string; icon?: ReactNode; insert: string; submit?: boolean }

/**
 * Where the composer is: on a machine, writing for work in `cwd` (as typed: may start with `~`, or be empty for the
 * machine's home), to `thread`; none for a thread yet to start (the New thread dialog's).
 */
export type ComposerWhere = { machine: MachineEntry; cwd: string; thread?: ThreadInfo }

/** Completions for the composer, as the user types: a word at the caret (a `/skill`, say), and what it could be. */
export type CompletionProvider<W extends CompletionWord = CompletionWord> = {
  /** What its items are, for the menu's label: "Skills". */
  title: string
  /**
   * The word at the caret this provider completes, if there is one. The first provider to find one completes it, with
   * every other that finds a word starting where it does (a `/` opening the message: commands and skills).
   */
  word(text: string, caret: number): W | undefined
  /**
   * What it offers for `word`, best first. Asked again as the word changes; may take a call to the machine. `ask.signal`
   * aborts once the answer isn't wanted (the word changed or ended): pass it on to what it waits for. Answered, it may
   * offer again with what came in late (`ask.update(items)`, until the signal aborts).
   */
  items(word: W, where: ComposerWhere, ask: CompletionAsk): Completion[] | Promise<Completion[]>
}

/** What a provider's `items` is asked with besides the word: when to stop, and how to offer again. */
export type CompletionAsk = {
  /** Aborted once the answer isn't wanted: the word changed or ended. */
  signal: AbortSignal
  /** Offer these instead, after it answered: what came in late. */
  update(items: Completion[]): void
}

/**
 * Something an extension names, offered as `@` is typed (`MentionSource`): taken, it's written `@<kind>:<id>`
 * (`mentionRef`), and once sent, the daemon half that resolves its kind (`superego.mention`) tells the agent what it
 * is, and it's drawn as a link.
 */
export type MentionItem = {
  /** What names it, written after `@<kind>:` (quoted where it must be): `'fox-and-rhino'`, `'Q4 plan'`. No `"` or line break. */
  id: string
  /** What the menu shows, and what the query is matched against (with `id` and `keywords`). */
  label: string
  /** Beside it, quieter: a folder, a notebook, a date. Unset: the source's `title`. */
  detail?: string
  /** Its icon, instead of the source's. */
  icon?: ReactNode
  /** More words it's found by, not shown: a match in them ranks below one in its label or id. */
  keywords?: string
  /** Of items that match as well, the higher first (the time it changed, say). */
  order?: number
}

/**
 * Things of a kind an extension names in the composer (`superego.composer.mention`): `@` offers them beside threads and
 * files, and `@<kind>:` offers them alone. `list` or `search` says what there is; the Mentions extension asks, scores and
 * caps them, so a slow or noisy source never holds up or floods the menu.
 */
export type MentionSource = {
  /** Its kind: lowercase (`'note'`, `'canvas'`), written `@<kind>:<id>`. Not `thread`, `file` or `folder`. */
  kind: string
  /** What its things are: `'Canvases'`. */
  title: string
  /** Its items' icon, unless an item has its own. */
  icon?: ComponentType<{ size?: number; 'aria-hidden'?: boolean }>
  /**
   * All of them, for a few hundred at most: asked once for each `@` word being typed (where it starts, in which thread
   * or folder), and matched as the word grows with no call again. `signal` aborts once the word is left, or after
   * 800ms (it offers nothing for that word then).
   */
  list?(where: ComposerWhere, options: { signal: AbortSignal }): MentionItem[] | Promise<MentionItem[]>
  /**
   * Those matching `query`, for more than a list can hold: asked at once for a bare `@`, then 80ms after typing stops,
   * `signal` aborting as the word changes or after 800ms. What it returns is a match, ranked again beside the rest.
   */
  search?(query: string, where: ComposerWhere, options: { signal: AbortSignal }): MentionItem[] | Promise<MentionItem[]>
  /**
   * Where a sent mention of `id` links to in the transcript. Default: `<kind>:<id>` (`mentionHref`, the id
   * URI-encoded), for a space or link of `match: '<kind>:'` to open. `false`: no link, the mention stays as written.
   */
  href?: false | ((id: string) => string)
}

/** A provider, and the word it found at the caret. */
export type Found = { provider: CompletionProvider<any>; word: CompletionWord }

/**
 * The word being completed at the caret, and by which providers: the first of `providers` that finds one, and those
 * after it that find one starting at the same place, in order. None: no word.
 */
export function completing(providers: readonly CompletionProvider<any>[], text: string, caret: number): Found[] {
  const found: Found[] = []
  for (const provider of providers) {
    const word = provider.word(text, caret)
    if (word && (!found.length || word.start === found[0]!.word.start)) found.push({ provider, word })
  }
  return found
}

/** What the providers offered for a word: their items, in their order, and the titles of those that offered any. */
export type Offered = { found: readonly Found[]; items: Completion[]; title: string }

/**
 * Ask each of `found`'s providers what it offers; `offer` gets them together once all have answered, and again as one
 * offers anew (`update`), unless the returned cancel came first (the word changed before the answer did): that aborts
 * what they were asked with. A provider that fails offers nothing.
 */
export function askFor(found: readonly Found[], where: ComposerWhere, offer: (offered: Offered) => void): () => void {
  const asking = new AbortController()
  const lists: (Completion[] | undefined)[] = found.map(() => undefined)
  const offerAll = () => {
    if (asking.signal.aborted || lists.some((list) => !list)) return
    const title = found.filter((_, index) => lists[index]!.length).map(({ provider }) => provider.title).join(' · ')
    offer({ found, items: lists.flat() as Completion[], title })
  }
  found.forEach(({ provider, word }, index) => {
    // What it offered last: an update after its answer replaces it; an answer after an update is older.
    let updated = false
    const update = (items: Completion[]) => {
      if (asking.signal.aborted) return
      updated = true
      lists[index] = items
      offerAll()
    }
    void (async () => {
      try { return await provider.items(word, where, { signal: asking.signal, update }) } catch (error) { console.error(`Completing (${provider.title}) failed`, error); return [] }
    })().then((items) => {
      if (updated) return
      lists[index] = items
      offerAll()
    })
  })
  return () => asking.abort()
}

/** A word but its query: the same while it's typed further, another if it moved or a field of the provider's changed. */
const stem = (word: CompletionWord) => JSON.stringify({ ...word, query: undefined })

/** Whether two finds are of the same word, as typed so far: by the same providers, each with the same stem. */
const sameWord = (a: readonly Found[], b: readonly Found[]) =>
  a.length === b.length && a.every((f, index) => f.provider === b[index]!.provider && stem(f.word) === stem(b[index]!.word))

/**
 * The menu for the word being completed: what was offered for it, or for it as typed so far (the same providers and
 * stems), so the menu doesn't blink while it grows and is asked again. None once dismissed (esc) where the word starts.
 */
export function menuFor(found: readonly Found[], offered: Offered | undefined, dismissed?: number): Completion[] | undefined {
  if (!found.length || !offered || !sameWord(found, offered.found)) return undefined
  return offered.items.length && dismissed !== found[0]!.word.start ? offered.items : undefined
}

/** `text` with the word from `start` to the caret replaced by `insert`, and where the caret goes: after it. A space it ends with isn't doubled. */
export function complete(text: string, caret: number, start: number, insert: string): { text: string; caret: number } {
  const after = /\s$/.test(insert) ? text.slice(caret).replace(/^ /, '') : text.slice(caret)
  return { text: text.slice(0, start) + insert + after, caret: start + insert.length }
}

/** A block of a sent message, as the agent was given it: text, or an image (its pixels left out: `ImageStub`). */
export type SentBlock = { type: string; text?: string; data?: string; mimeType?: string; width?: number; height?: number }

/** What a composer claim put in a message, read back from it once sent and drawn under it. */
export type SentWith<T = any> = {
  /** What it put in a sent message: the items to draw, and the blocks (by index) they were, which the message's text leaves out. */
  read(blocks: readonly SentBlock[]): { items: T[]; blocks: number[] } | undefined
  /** Draws them under the message (in its thread): a chip each, say. */
  component?: ComponentType<{ machine: MachineEntry; thread: ThreadInfo; items: T[] }>
  /** The message's own words as Markdown to draw, given what was found (in `where`'s thread): a name it mentions as a link, say. */
  words?(text: string, items: T[], where: SentWhere): string
}

/** Where a sent message is: its thread, on its machine. */
export type SentWhere = { machine: MachineEntry; thread: ThreadInfo }

/** A sent message's words as the readers that found something in it draw them (`words`), each in turn. */
export function sentWords(found: readonly { reader: SentWith; items: unknown[] }[], text: string, where: SentWhere): string {
  return found.reduce((words, { reader, items }) => {
    if (!reader.words) return words
    try { return reader.words(words, items, where) } catch (error) { console.error('Drawing a sent message\'s words failed', error); return words }
  }, text)
}

/** A sent message as `readers` find it: what each found in it, and the blocks none of them claimed (`at`: their indexes in it). */
export function readSent<R extends SentWith>(readers: readonly R[], blocks: readonly SentBlock[]): { found: { reader: R; items: unknown[] }[]; rest: SentBlock[]; at: number[] } {
  const claimed = new Set<number>()
  const found: { reader: R; items: unknown[] }[] = []
  for (const reader of readers) {
    let read: ReturnType<SentWith['read']>
    try { read = reader.read(blocks) } catch (error) { console.error('Reading a sent message failed', error); continue }
    if (!read) continue
    for (const index of read.blocks) claimed.add(index)
    if (read.items.length) found.push({ reader, items: read.items })
  }
  const at = blocks.flatMap((_, index) => claimed.has(index) ? [] : [index])
  return { found, rest: at.map((index) => blocks[index]!), at }
}
