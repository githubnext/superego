// mentions, UI half: `@` in the composer offers other threads, things extensions name (`superego.composer.mention`) and
// the thread's files (complete.ts, sources.ts); taken, one goes in the text as `@thread:<id>` (`@thread:<machine>/<id>`
// on another machine), `@<kind>:<id>` or `@path`. In a sent message, each mention the daemon half said what it was (its
// block, which the text leaves out) is drawn as a link: a thread by its title and status, opening it; a file opening
// beside the thread; an extension's thing as its source says (`<kind>:<id>` by default, for its space or link to open).
import { call, defineUiExtension, has, mentionHref, type Completion, type ComposerWhere, type MentionSource } from '@superego/app/ui'
import { FileIcon, StatusGlyph } from '@superego/ui'
import { mentionAt, offers, scopeOf, type Offer, type SourceItems } from './complete.ts'
import { createLookup } from './sources.ts'
import { about, mentionLinks, sentMentions, type SentMention } from './shared.ts'

/**
 * How long the menu waits for what's still being asked (the files, a source's list or search) before it shows what it
 * has: what comes after joins it, as it comes.
 */
export const SOFT_WINDOW = 150

/**
 * The files where the composer is (the thread's folder, or the one a thread is about to start in), read once for each
 * word being typed (where it starts, in which thread or folder) and filtered as it grows. None where the machine has no
 * files extension, or for a thread yet to start in no folder in particular (the home folder); a failure to read them is
 * logged, and threads are still offered.
 */
let listed: { key: string; files: Promise<string[]>; done?: string[] } | undefined
const filesFor = ({ machine, thread, cwd }: ComposerWhere, start: number) => {
  const key = `${machine.id}\u0000${thread?.id ?? cwd}\u0000${start}`
  if (listed?.key !== key) {
    const of = thread ? { thread: thread.id } : cwd.trim() ? { cwd: cwd.trim() } : undefined
    const now: NonNullable<typeof listed> = {
      key,
      files: of && has(machine, 'ext:files')
        ? call<{ files: string[] }>(machine.id, 'files.list', of).then((list) => list.files, (error: unknown) => {
          console.error(`Listing ${thread?.cwd ?? cwd} to mention a file failed`, error)
          return []
        })
        : Promise.resolve([]),
    }
    void now.files.then((files) => { now.done = files })
    listed = now
  }
  return listed
}

/** A path as the menu shows it: its name, and the folder it's in beside it. */
const split = (path: string) => {
  const at = path.lastIndexOf('/')
  return at < 0 ? { name: path } : { name: path.slice(at + 1), folder: path.slice(0, at) }
}

/** Where a sent mention of an extension's thing links to, as its source (if `where` still has one) says: none for no link. */
const hrefFrom = (sources: readonly MentionSource[]) => (kind: string, id: string): string | undefined => {
  const source = sources.find((s) => s.kind === kind)
  if (!source?.href) return source?.href === false ? undefined : mentionHref(kind, id)
  try { return source.href(id) } catch (error) {
    console.error(`Mention source ${kind}: its href failed for ${JSON.stringify(id)}`, error)
    return undefined
  }
}

export default defineUiExtension({
  ...about,
  setup(superego) {
    const lookup = createLookup()
    /** An offer as a row of the menu. */
    const row = (offer: Offer, where: ComposerWhere, sources: readonly MentionSource[]): Completion => {
      if (offer.kind === 'file') {
        const { name, folder } = split(offer.path)
        return { label: name, ...(folder ? { detail: folder } : {}), icon: <FileIcon size={14} />, insert: offer.insert }
      }
      if (offer.kind === 'other') {
        const source = sources.find((s) => s.kind === offer.type)
        const Icon = source?.icon
        const icon = offer.item.icon ?? (Icon ? <Icon size={14} aria-hidden /> : undefined)
        const detail = offer.item.detail ?? source?.title
        return { label: offer.item.label, ...(detail ? { detail } : {}), ...(icon ? { icon } : {}), insert: offer.insert }
      }
      // Where it is, where that isn't this thread's project.
      const { project } = offer.thread
      const detail = offer.machine.id !== where.machine.id ? `${project.name} on ${offer.machine.label}` : project.root !== (where.thread?.project.root ?? where.cwd) ? project.name : undefined
      return {
        label: offer.thread.title,
        ...(detail ? { detail } : {}),
        icon: <StatusGlyph status={offer.thread.status} quiet={offer.thread.quiet} />,
        insert: offer.insert,
      }
    }

    superego.composer.complete({
      title: 'Mentions',
      word: mentionAt,
      items(word, where, { signal, update }) {
        const all = superego.composer.mentionSources(where)
        const kinds = all.map((s) => s.kind)
        const { scope, q } = scopeOf(word.query, kinds)
        // `@<kind>:` asks that source alone; `@thread:` and `@file:`, none.
        const sources = scope === 'thread' || scope === 'file' ? [] : scope ? all.filter((s) => s.kind === scope) : all
        const answers = new Map<MentionSource, SourceItems>()
        const pending: Promise<unknown>[] = []
        for (const asked of lookup.ask(sources, q, where, word.start, signal)) {
          if (asked.now) answers.set(asked.source, asked.now)
          else if (asked.later) pending.push(asked.later.then((items) => { if (items) answers.set(asked.source, items) }))
        }
        const files = !scope || scope === 'file' ? filesFor(where, word.start) : undefined
        if (files && !files.done) pending.push(files.files)
        const build = () => {
          const { machines, threads } = superego.window
          return offers({
            query: word.query, machine: where.machine.id, here: where.thread?.id, machines, threads, files: files?.done ?? [],
            sources: sources.flatMap((s) => answers.get(s) ?? []), kinds,
          }).map((offer) => row(offer, where, sources))
        }
        if (!pending.length) return build()
        // What's there once all have answered, or after a moment, whichever is first; then again as the rest come.
        return new Promise<Completion[]>((resolve) => {
          let answered = false
          let left = pending.length
          const offer = () => {
            if (signal.aborted) return
            if (answered) return update(build())
            answered = true
            clearTimeout(soft)
            resolve(build())
          }
          const soft = setTimeout(offer, SOFT_WINDOW)
          signal.addEventListener('abort', () => { clearTimeout(soft); resolve([]) }, { once: true })
          for (const one of pending) void one.then(() => { left--; if (answered || !left) offer() })
        })
      },
    })
    superego.composer.sentWith<SentMention>({
      read: sentMentions,
      words: (text, items, { machine, thread }) => mentionLinks(text, items, hrefFrom(superego.composer.mentionSources({ machine, cwd: thread.cwd, thread }))),
    })
  },
})
