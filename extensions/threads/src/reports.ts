// thread-reports, daemon half: report-back. When a thread started by another (a child) ends a run (answered, failed or
// stopped) or comes to wait on a question, its parent gets a message saying so, from it, with the first lines of its
// answer. Reports close together go as one message; one the parent has read already (thread_read, waiting on it, say)
// isn't sent at all. A message is like thread_send's: "From [child](thread:<id>): …", queued after the parent's run.
//
// Only while the child works for its parent: from its first message (thread_start's prompt), and from each the parent
// sends it (thread_send), until the user writes to it themselves (from a window or the command line), which hands it to
// them: their own conversation with it isn't reported. Runs in between (the child's own children reporting, say) are
// reported, so a grandchild's result makes its way up. Kept with the child (this extension's state: false, the
// user's), so it holds across restarts; a child from before this was kept is reported as before. Clients are told
// (`facts['thread-reports']`), so a child working for its parent notifies only when it needs the user; but only while
// its parent hears (it's there, not archived, and not without thread-reports): a child whose report would reach no one
// notifies for itself.
//
// Reports are best-effort, a convenience, not delivery to rely on: the read log and reports waiting to go are in memory
// (reads.ts), so after a restart a report that was waiting is lost, and a run resumed then may report what the parent
// had read already. A workflow that must know a child finished asks it (thread_read), not its report.
import { defineExtension, section } from '@earendil-works/pi-durable'
import { defineDaemonExtension } from '@superego/daemon'
import { waitingForSignIn, type ThreadInfo } from '@superego/protocol'
import { readsOf } from './reads.ts'
import { fromLine, linkTo, senderOf } from './tools.ts'
import { REPORTED, reportsAbout, toolsAbout } from './shared.ts'

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

/** Whether a thread hears its children's reports: it's there, in use, and not without them. */
const hears = (parent: ThreadInfo | undefined): parent is ThreadInfo => Boolean(parent && !parent.archived && !parent.without?.includes(reportsAbout.name))

/** A thread's run ended, or it waits on a question, as its parent hears it. */
async function describe(thread: ThreadInfo, host: ReportsHost): Promise<string> {
  const from = fromLine(thread)
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
    if (!hears(await host.info(parent))) return
    // Read since (by waiting on it, say): the parent has it already.
    const texts = [...batch.reports.values()].filter((r) => !host.read(r.thread)).map((r) => r.text)
    if (texts.length) await host.send(parent, texts.join('\n\n---\n\n'))
  }

  return {
    async report(thread: ThreadInfo) {
      const parent = thread.parent
      // Waiting for sign-in, it hasn't finished: it reports when it goes on and does.
      if (!parent || thread.status.state === 'working' || waitingForSignIn(thread.status)) return
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

/** The extension, with reports batched as `batching` says. */
export const threadReports = (batching: Batching = BATCHING) => defineDaemonExtension({
  ...reportsAbout,
  setup(s) {
    const reads = readsOf(s.harness)
    const info = (id: string) => s.threads.get(id).catch(() => undefined)
    const reports = reporter({
      info, answer: (id) => s.threads.lastAnswer(id), read: (thread) => reads.read(thread),
      send: (id, text) => s.threads.send(id, text, { whenBusy: 'followUp' }),
    }, batching)
    // Whether a child works for its parent (see the top): set by the messages it's sent, false once the user writes.
    const working = s.state<boolean>()
    // The children whose parent doesn't hear them (archived, say), as last looked: checked for each in use from the
    // start, as a run starts (its parent's profile may have changed), and for a parent's children as it's archived or
    // brought back.
    const unheard = new Set<string>()
    const settle = (id: string, heard: boolean) => {
      if (heard !== unheard.has(id)) return
      if (heard) unheard.delete(id)
      else unheard.add(id)
      s.invalidate()
    }
    const check = async (thread: ThreadInfo) => { if (thread.parent) settle(thread.id, hears(await info(thread.parent))) }
    const childrenOf = async (id: string) => (await s.threads.list()).filter((t) => t.parent === id)
    s.threads.list().then((all) => Promise.all(all.map(check))).catch((error) => console.error('thread-reports: checking parents failed:', error))
    // Said to clients, so a child's own finishing or failing doesn't notify too: its parent hears it (see REPORTED).
    s.facts<boolean>(({ id, state }) => state === true && !unheard.has(id) ? REPORTED : undefined)
    s.submit(async ({ thread, text, by }) => {
      if (!thread.parent) return
      if (by === undefined) await working.set(thread.id, false)
      // thread_start's prompt, or the parent's thread_send; not another thread's.
      else if (by === toolsAbout.name && (senderOf(text) ?? thread.parent) === thread.parent) await working.set(thread.id, true)
    })
    const report = async (thread: ThreadInfo) => {
      if (thread.parent && await working.get(thread.id) !== false) await reports.report(thread)
    }
    s.thread({
      turnStart: check, turnEnd: report, blocked: report,
      // Told before it shows archived: its children are settled, not checked (they'd find it in use still).
      archived: async (thread) => { for (const child of await childrenOf(thread.id)) settle(child.id, false) },
      unarchived: async (thread) => { await Promise.all([thread, ...await childrenOf(thread.id)].map(check)) },
    })
    s.agent(defineExtension({
      name: 'thread-reports',
      sections: [section('thread_reports', async ({ conversationId }) => {
        const self = await info(String(conversationId))
        if (!self) return undefined
        const parent = self.parent ? await info(self.parent) : undefined
        return [
          !self.without?.includes('thread-tools') && 'Threads you start usually report back on their own: a message from each when it ' +
            'finishes, fails or waits on a question. You needn\'t wait on them with thread_read: carry on, or end your turn.',
          hears(parent) && await working.get(self.id) !== false && `When a turn of yours ` +
            `ends, its answer (the first lines) is relayed to ${linkTo(parent)} for you: you needn't thread_send it your result. Put the outcome first.`,
        ].filter(Boolean).join('\n') || undefined
      })],
    }))
    return () => reports.stop()
  },
})

export default threadReports()
