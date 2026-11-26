// mentions, daemon half: a message that mentions a thread (`@thread:42`, `@thread:workbox/42`), a file (`@src/app.ts`)
// or an extension's thing (`@canvas:fox-and-rhino`) goes with a short block saying what each is (see shared.ts): a
// thread's title and where it stands, and how to read it; a file or folder as a path in the thread's folder; an
// extension's thing as the resolver of its kind says (`superego.mention`). Nothing is inlined: the agent reads what it
// needs. A word that looks like a mention but names nothing there (`@someone`, `@canvas:missing`) is left alone.
import { stat } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { defineDaemonExtension, type DaemonApi } from '@superego/daemon'
import { machineNamed, statusLabel, type ThreadInfo } from '@superego/protocol'
import { about, mentionsBlock, mentionsIn, otherLine, type Mention } from './shared.ts'

/** A string as the agent would pass it to a tool. */
const q = JSON.stringify

/** Where a thread stands, kept to a line: a finished one's recap can run long. */
const short = (words: string) => words.length > 120 ? `${words.slice(0, 119)}…` : words

/** What a thread mention names, as a line of the block. */
async function threadLine(superego: DaemonApi, mention: Extract<Mention, { kind: 'thread' }>): Promise<string> {
  const { ref, id, machine } = mention
  const how = `Read it with thread_read (thread: ${q(id)}${machine ? `, machine: ${q(machine)}` : ''}).`
  const said = (thread: ThreadInfo | undefined, where: string) => thread
    ? `${ref} is a thread${where}: ${q(thread.title)} (${short(statusLabel(thread.status))}${thread.archived ? ', archived' : ''}). ${how}`
    : `${ref} is a thread${where}, thread ${id}, which isn't there.`
  if (!machine) return said(await superego.threads.get(id).catch(() => undefined), '')
  const found = machineNamed(superego.machines.list(), machine)
  if (!found) return `${ref} is a thread on ${machine}, a machine this one doesn't reach.`
  try {
    const list = async (archived: boolean) => (await superego.machines.call(found.id, 'thread.list', archived ? { archived } : {}) as ThreadInfo[]).find((t) => t.id === id)
    return said(await list(false) ?? await list(true), ` on ${machine}`)
  } catch (error) {
    return `${ref} is a thread on ${machine}, thread ${id}; asking ${machine} about it failed: ${(error as Error).message}. ${how}`
  }
}

/**
 * What an extension's thing names, as a line of the block: as the resolver of its kind (that the thread has) says; a
 * bare one no extension resolves may be a path with a colon in it.
 */
async function describeOther(superego: DaemonApi, thread: ThreadInfo, mention: Extract<Mention, { kind: 'other' }>): Promise<string | undefined> {
  const resolve = superego.mentionResolver(mention.type, thread)
  if (!resolve) return mention.quoted ? undefined : fileLine(thread.cwd, { ref: mention.ref, path: mention.ref.slice(1) })
  const said = await resolve({ ref: mention.ref, id: mention.id })
  return said?.trim() ? otherLine(mention.ref, mention.type, said) : undefined
}

/** What a file mention names, as a line of the block: nothing when it names nothing in `cwd`. */
async function fileLine(cwd: string, { ref, path }: { ref: string; path: string }): Promise<string | undefined> {
  if (isAbsolute(path)) return undefined
  const found = await stat(resolve(cwd, path)).catch(() => undefined)
  if (!found) return undefined
  return `${ref} is a ${found.isDirectory() ? 'folder' : 'file'}, relative to this thread's folder.`
}

export default defineDaemonExtension({
  ...about,
  setup(superego) {
    // The block goes after the message's own content.
    superego.beforeSend(async ({ thread, text, content }) => {
      const mentions = mentionsIn(text)
      if (!mentions.length) return
      const lines = await Promise.all(mentions.map((mention) => mention.kind === 'thread' ? threadLine(superego, mention)
        : mention.kind === 'other' ? describeOther(superego, thread, mention) : fileLine(thread.cwd, mention)))
      const said = lines.filter((line): line is string => Boolean(line))
      if (!said.length) return
      return [...content, { type: 'text' as const, text: mentionsBlock(said) }]
    })
  },
})
