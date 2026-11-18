// thread-reports: report-back. When a thread started by another (a child) ends a run (answered, failed or
// stopped) or comes to wait on a question, its parent gets a message saying so, from it, with the first lines of its
// answer: "From [child](thread:<id>): finished.", like thread_send's, or "replied." when the run answered a thread_send
// of the parent's, or "was stopped" when a stop withdrew messages others had queued for it, saying how many were the
// parent's. Reports close together go as one message. While the parent is in a run, they wait here (not in its
// queue) until that run ends, and what goes is decided then: one about a child the parent has read since (thread_read,
// waiting on it, say), or one that has been archived, isn't sent at all.
//
// Only while the child works for its parent: from its first message (thread_start's prompt), and from each the parent
// sends it (thread_send), until the user writes to it themselves (from a window or the command line), which hands it to
// them: their own conversation with it isn't reported. Runs in between (the child's own children reporting, say) are
// reported, so a grandchild's result makes its way up. Kept with the child (this extension's state: true, its
// parent's; false, the user's), so it holds across restarts. It's quiet (`ThreadInfo.quiet`), so a child working for
// its parent is unread and notifies only when it needs the user; but only while its parent hears (it's there, not
// archived, and not without thread-reports), and the user follows that one: a child whose report would reach no one is
// unread and notifies for itself. So does a hidden thread's (Ego's): its parent hears it, but is in no list and speaks
// when asked, so its report doesn't reach the user, and the child's own notice is how they learn it's done.
//
// Reports are best-effort, a convenience, not delivery to rely on: which children their parents have read
// (`threads.noteRead`), the reports waiting to go (however long the parent's run) and which runs answered the parent
// are in memory, so after a restart a report that was waiting is lost, a run resumed then may report what the parent
// had read already, and a reply reads as "finished".
// A workflow that must know a child finished asks it (thread_read), not its report.
import { defineExtension, section } from '@earendil-works/pi-durable'
import { defineDaemonExtension } from '@superego/daemon'
import { linkTo, waitingForSignIn, type ThreadInfo } from '@superego/protocol'
import { about as reportsAbout } from './shared.ts'

/** What reporting needs of the daemon. */
export type ReportsHost = {
  info(id: string): Promise<ThreadInfo | undefined>
  answer(id: string): Promise<string | undefined>
  /** Send it a message (after its run, should one have started since `busy` said it hadn't). */
  send(id: string, text: string): Promise<void>
  /** Whether it's in a run: its reports wait for `idle`. */
  busy(thread: ThreadInfo): boolean
  /** Whether its parent read it as it stands (or later): `threads.parentRead`. */
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

type Report = { thread: ThreadInfo; text: string; how: How }

/** Whether a thread hears its children's reports: it's there, in use, and not without them. */
const hears = (parent: ThreadInfo | undefined): parent is ThreadInfo => Boolean(parent && !parent.archived && !parent.without?.includes(reportsAbout.name))
/** Whether its children are quiet: it hears them, and the user follows it (it's listed, not hidden like Ego's). */
const speaksFor = (parent: ThreadInfo | undefined) => hears(parent) && !parent.hidden

/**
 * How a report came: the run answered the parent's thread_send (`replied`); it was stopped, withdrawing `withdrawn` of
 * the parent's messages queued for it (`stopped`).
 */
type How = { replied?: boolean; stopped?: { withdrawn: number } }

/** A thread's run ended, or it waits on a question, as its parent hears it. */
async function describe(thread: ThreadInfo, host: ReportsHost, { replied, stopped }: How): Promise<string> {
  const from = `From ${linkTo(thread)}:`
  const { state, msg } = thread.status
  if (state === 'blocked') return `${from} is waiting on a question${msg ? `:\n\n${excerpt(msg)}` : '.'}`
  if (state === 'error') return `${from} errored${msg ? ` (${msg.split('\n')[0]!.slice(0, 200)})` : ''}.`
  const answer = await host.answer(thread.id)
  const ended = stopped
    ? `was stopped${stopped.withdrawn ? `, withdrawing ${stopped.withdrawn === 1 ? 'the message' : `the ${stopped.withdrawn} messages`} you'd queued for it` : ''}`
    : replied ? 'replied' : 'finished'
  return answer ? `${from} ${ended}.\n\n${excerpt(answer)}` : `${from} ${ended}, with no answer.`
}

/**
 * Reports, batched by parent. `report` a child's run ending, its stop or its question (`How`); `idle` says a parent's
 * run ended, sending what waited for it; `stop` drops what's waiting.
 */
export function reporter(host: ReportsHost, { quietMs, maxMs }: Batching = BATCHING) {
  /**
   * `due`: its time came while the parent was in a run, so it goes when that run ends. `flushing`: it's being looked
   * at, so it goes once; `ended`: the parent's run ended meanwhile, so it's looked at again.
   */
  type Batch = { reports: Map<string, Report>; first: number; due?: boolean; flushing?: boolean; ended?: boolean; timer?: ReturnType<typeof setTimeout> }
  const batches = new Map<string, Batch>()

  async function flush(parent: string) {
    const batch = batches.get(parent)
    if (!batch || batch.flushing) return
    batch.flushing = true
    const to = await host.info(parent)
    batch.flushing = false
    if (!hears(to)) { batches.delete(parent); return }
    // In a run: it's decided what goes when the run ends, not now.
    if (host.busy(to)) {
      batch.due = true
      if (batch.ended) { batch.ended = false; flushing(parent) }
      return
    }
    batches.delete(parent)
    const texts = (await Promise.all([...batch.reports.values()].map(async (r) => {
      const now = await host.info(r.thread.id)
      // Archived since, or read since (by waiting on it, say): the parent has no use for it.
      return now && !now.archived && !host.read(r.thread) ? r.text : undefined
    }))).filter((text) => text !== undefined)
    if (texts.length) await host.send(parent, texts.join('\n\n---\n\n'))
  }
  const flushing = (parent: string) => { flush(parent).catch((error) => console.error(`thread-reports: to ${parent}:`, error)) }

  return {
    async report(thread: ThreadInfo, how: How = {}) {
      const parent = thread.parent
      // Waiting for sign-in, it hasn't finished: it reports when it goes on and does.
      if (!parent || thread.status.state === 'working' || waitingForSignIn(thread.status)) return
      let batch = batches.get(parent)
      if (!batch) batches.set(parent, batch = { reports: new Map(), first: Date.now() })
      // A later report of the same thread says where it stands now, keeping how the run it reports ended: a stop is
      // told after the run's end (or before, while the run's end is still being told).
      const was = batch.reports.get(thread.id)?.how
      const now: How = { ...(how.replied || was?.replied ? { replied: true } : {}), ...(how.stopped ?? was?.stopped ? { stopped: how.stopped ?? was!.stopped } : {}) }
      // Its answer as it is now, before it moves on.
      const text = await describe(thread, host, now)
      batch.reports.delete(thread.id)
      batch.reports.set(thread.id, { thread, text, how: now })
      // Due already: it goes with the rest when the parent's run ends.
      if (batch.due) return
      clearTimeout(batch.timer)
      batch.timer = setTimeout(() => flushing(parent), Math.max(0, Math.min(quietMs, batch.first + maxMs - Date.now())))
    },
    idle(parent: string) {
      const batch = batches.get(parent)
      if (batch?.flushing) batch.ended = true
      else if (batch?.due) flushing(parent)
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
    const info = (id: string) => s.threads.get(id).catch(() => undefined)
    // The threads in a run, as the hooks tell it; one resumed after a restart (no turnStart) shows working.
    const running = new Set<string>()
    const reports = reporter({
      info, answer: (id) => s.threads.lastAnswer(id), read: (thread) => s.threads.parentRead(thread),
      busy: (thread) => running.has(thread.id) || thread.status.state === 'working',
      send: (id, text) => s.threads.send(id, text, { whenBusy: 'followUp' }),
    }, batching)
    // The children whose run answers their parent's thread_send, so their report says "replied".
    const asked = new Set<string>()
    // Whether a child works for its parent (see the top): set by the messages it's sent, false once the user writes.
    const working = s.state<boolean>()
    // The children whose parent doesn't speak for them (archived, or hidden: see the top), as last looked: checked for
    // each in use from the start, as a run starts (its parent's profile may have changed), and for a parent's children
    // as it's archived or brought back.
    const loud = new Set<string>()
    const settle = (id: string, quiet: boolean) => {
      if (quiet !== loud.has(id)) return
      if (quiet) loud.delete(id)
      else loud.add(id)
      s.invalidate()
    }
    const check = async (thread: ThreadInfo) => { if (thread.parent) settle(thread.id, speaksFor(await info(thread.parent))) }
    const childrenOf = async (id: string) => (await s.threads.list()).filter((t) => t.parent === id)
    s.threads.list().then((all) => Promise.all(all.map(check))).catch((error) => console.error('thread-reports: checking parents failed:', error))
    // Quiet, so a child's own finishing or failing isn't unread too: its parent hears it.
    s.quiet<boolean>(({ id, state }) => state === true && !loud.has(id))
    // The children just made, whose next message is the prompt they were started with: what they answer then "finished".
    const fresh = new Set<string>()
    s.beforeSend(async ({ thread, by, from }) => {
      const first = fresh.delete(thread.id)
      if (!thread.parent) return
      if (by === undefined) await working.set(thread.id, false)
      // From its parent: the prompt it was started with, or the parent's thread_send; not another thread's.
      else if (from === thread.parent) {
        if (!first) asked.add(thread.id)
        await working.set(thread.id, true)
      }
    })
    const report = async (thread: ThreadInfo, how: Parameters<typeof reports.report>[1] = {}) => {
      if (thread.parent && await working.get(thread.id) === true) await reports.report(thread, how)
    }
    s.thread({
      started: (thread) => { if (thread.parent) fresh.add(thread.id) },
      turnStart: async (thread) => { running.add(thread.id); await check(thread) },
      turnEnd: async (thread) => {
        running.delete(thread.id)
        // Its own children's reports waited for this.
        reports.idle(thread.id)
        const replied = asked.delete(thread.id)
        await report(thread, { replied })
      },
      // What of the parent's it withdrew goes with the report of the run it stopped, told before this or after.
      stopped: (thread, { withdrawn }) => report(thread, { stopped: { withdrawn: withdrawn.filter((origin) => origin.from === thread.parent).length } }),
      blocked: (thread) => report(thread),
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
          hears(parent) && await working.get(self.id) === true && `When a turn of yours ` +
            `ends, its answer (the first lines) is relayed to ${linkTo(parent)} for you: you needn't thread_send it your result. Put the outcome first.`,
        ].filter(Boolean).join('\n') || undefined
      })],
    }))
    return () => reports.stop()
  },
})

export default threadReports()
