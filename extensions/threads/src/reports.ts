// thread-reports, daemon half: report-back. When a thread started by another (a child) ends a run (answered, failed or
// stopped) or comes to wait on a question, its parent gets a message saying so, from it, with the first lines of its
// answer. Reports close together go as one message; one the parent has read already (thread_read, waiting on it, say)
// isn't sent at all. A message is like thread_send's: "From [child](thread:<id>): …", queued after the parent's run.
import { defineExtension, section } from '@earendil-works/pi-durable'
import { defineDaemonExtension } from '@superego/daemon'
import type { ThreadInfo } from '@superego/protocol'
import { readsOf } from './reads.ts'
import { reportsAbout } from './shared.ts'
import { linkTo } from './tools.ts'

/** What reporting needs of the daemon. */
export type ReportsHost = {
  info(id: string): Promise<ThreadInfo | undefined>
  answer(id: string): Promise<string | undefined>
  /** Send it a message after its run, if it's working. */
  send(id: string, text: string): Promise<void>
  /** Whether its parent read it as it stands (or later). */
  read(thread: ThreadInfo): boolean
}

/** How long a report waits for others to go with it: until none came for `quietMs`, and `maxMs` at most. */
export type Batching = { quietMs: number; maxMs: number }
export const BATCHING: Batching = { quietMs: 5_000, maxMs: 30_000 }

const LINES = 6
const CHARS = 600
/** The first lines of an answer, saying when there's more. */
export function excerpt(answer: string) {
  const lines = answer.trim().split('\n')
  let cut = lines.slice(0, LINES).join('\n')
  if (cut.length > CHARS) cut = `${cut.slice(0, CHARS).trimEnd()}…`
  return cut.length < answer.trim().length ? `${cut}\n\n(thread_read has the rest.)` : cut
}

type Report = { thread: ThreadInfo; text: string }

/** A thread's run ended, or it waits on a question, as its parent hears it. */
async function describe(thread: ThreadInfo, host: ReportsHost): Promise<string> {
  const from = `From ${linkTo(thread)}:`
  const { state, msg } = thread.status
  if (state === 'blocked') return `${from} is waiting on a question${msg ? `:\n\n${excerpt(msg)}` : '.'}`
  if (state === 'error') return `${from} errored${msg ? ` (${msg.split('\n')[0]!.slice(0, 200)})` : ''}.`
  const answer = await host.answer(thread.id)
  return answer ? `${from} finished.\n\n${excerpt(answer)}` : `${from} finished, with no answer.`
}

/** Reports, batched by parent. `report` a child's run ending or its question; `stop` drops what's waiting. */
export function reporter(host: ReportsHost, { quietMs, maxMs }: Batching = BATCHING) {
  const batches = new Map<string, { reports: Map<string, Report>; first: number; timer?: ReturnType<typeof setTimeout> }>()

  async function flush(parent: string) {
    const batch = batches.get(parent)
    batches.delete(parent)
    if (!batch) return
    const to = await host.info(parent)
    if (!to || to.archived || to.without?.includes(reportsAbout.name)) return
    // Read since (by waiting on it, say): the parent has it already.
    const texts = [...batch.reports.values()].filter((r) => !host.read(r.thread)).map((r) => r.text)
    if (texts.length) await host.send(parent, texts.join('\n\n---\n\n'))
  }

  return {
    async report(thread: ThreadInfo) {
      const parent = thread.parent
      if (!parent || thread.status.state === 'working') return
      // Its answer as it is now, before it moves on.
      const text = await describe(thread, host)
      let batch = batches.get(parent)
      if (!batch) batches.set(parent, batch = { reports: new Map(), first: Date.now() })
      // A later report of the same thread says where it stands now.
      batch.reports.delete(thread.id)
      batch.reports.set(thread.id, { thread, text })
      clearTimeout(batch.timer)
      batch.timer = setTimeout(() => { flush(parent).catch((error) => console.error(`thread-reports: to ${parent}:`, error)) }, Math.max(0, Math.min(quietMs, batch.first + maxMs - Date.now())))
    },
    stop() {
      for (const batch of batches.values()) clearTimeout(batch.timer)
      batches.clear()
    },
  }
}

export default defineDaemonExtension({
  ...reportsAbout,
  setup(s) {
    const reads = readsOf(s.harness)
    const info = (id: string) => s.threads.get(id).catch(() => undefined)
    const reports = reporter({
      info, answer: (id) => s.threads.lastAnswer(id), read: (thread) => reads.read(thread),
      send: (id, text) => s.threads.submit(id, text, { whenBusy: 'followUp' }),
    })
    s.thread({ turnEnd: (thread) => reports.report(thread), blocked: (thread) => reports.report(thread) })
    s.agent(defineExtension({
      name: 'thread-reports',
      sections: [section('thread_reports', async ({ conversationId }) => {
        const self = await info(String(conversationId))
        if (!self) return undefined
        const parent = self.parent ? await info(self.parent) : undefined
        return [
          !self.without?.includes('thread-tools') && 'Threads you start report back on their own: a message from each when it finishes, ' +
            'fails or waits on a question. You needn\'t wait on them with thread_read: carry on, or end your turn.',
          parent && !parent.without?.includes(reportsAbout.name) && `When a turn of yours ends, its answer (the first lines) is ` +
            `relayed to ${linkTo(parent)} for you: you needn't thread_send it your result. Put the outcome first.`,
        ].filter(Boolean).join('\n') || undefined
      })],
    }))
    return () => reports.stop()
  },
})
