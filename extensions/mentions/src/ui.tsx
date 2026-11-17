// mentions, UI half: `@` in the composer offers other threads and the thread's files (complete.ts); taken, one goes in
// the text as `@thread:<id>` (`@thread:<machine>/<id>` on another machine) or `@path`. In a sent message, each mention
// the daemon half said what it was (its block, which the text leaves out) is drawn as a link: a thread by its title and
// status, opening it; a file opening beside the thread.
import { call, defineUiExtension, has, type Completion, type ComposerWhere } from '@superego/app/ui'
import { FileIcon, StatusGlyph } from '@superego/ui'
import { mentionAt, offers } from './complete.ts'
import { about, mentionLinks, sentMentions, type SentMention } from './shared.ts'

/** The files list of the files extension: `{ files }` for `{ thread }`. */
const FILES = 'files.list'

/**
 * The thread's files, read once for each word being typed (where it starts in which thread) and filtered as it grows.
 * None where the machine has no files extension; a failure to read them is logged, and threads are still offered.
 */
let listed: { key: string; files: Promise<string[]> } | undefined
const filesFor = ({ machine, thread }: ComposerWhere, start: number) => {
  const key = `${machine.id}\u0000${thread.id}\u0000${start}`
  if (listed?.key !== key) {
    listed = {
      key,
      files: has(machine, 'ext:files')
        ? call<{ files: string[] }>(machine.id, FILES, { thread: thread.id }).then((list) => list.files, (error: unknown) => {
          console.error(`Listing ${thread.cwd} to mention a file failed`, error)
          return []
        })
        : Promise.resolve([]),
    }
  }
  return listed.files
}

/** A path as the menu shows it: its name, and the folder it's in beside it. */
const split = (path: string) => {
  const at = path.lastIndexOf('/')
  return at < 0 ? { name: path } : { name: path.slice(at + 1), folder: path.slice(0, at) }
}

export default defineUiExtension({
  ...about,
  setup(superego) {
    superego.composer.complete({
      title: 'Mentions',
      word: mentionAt,
      async items(word, where): Promise<Completion[]> {
        const files = await filesFor(where, word.start)
        const { machines, threads } = superego.window
        return offers({ query: word.query, machine: where.machine.id, here: where.thread.id, machines, threads, files }).map((offer): Completion => {
          if (offer.kind === 'file') {
            const { name, folder } = split(offer.path)
            return { label: name, ...(folder ? { detail: folder } : {}), icon: <FileIcon size={14} />, insert: offer.insert }
          }
          // Where it is, where that isn't this thread's project.
          const { project } = offer.thread
          const detail = offer.machine.id !== where.machine.id ? `${project.name} on ${offer.machine.label}` : project.root !== where.thread.project.root ? project.name : undefined
          return {
            label: offer.thread.title,
            ...(detail ? { detail } : {}),
            icon: <StatusGlyph status={offer.thread.status} quiet={offer.thread.quiet} />,
            insert: offer.insert,
          }
        })
      },
    })
    superego.composer.sentWith<SentMention>({ read: sentMentions, words: mentionLinks })
  },
})
