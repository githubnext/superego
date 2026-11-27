// The threads: each mounted as it's first reached (its conversation, and a watch that keeps its status current), what
// clients see of it, and what's done with it: started, sent to, archived and back, cleared, its panes; the extensions'
// hooks told along the way, and the threads waiting on a provider's sign-in retried when it comes.
import { randomUUID } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { hostname } from 'node:os'
import { basename, dirname } from 'node:path'
import { InboxDoc, type ConversationId, type ConversationRecord, type ConversationView, type Cursor, type EntryId, type EntryRecord, type Harness, type InboxItem, type LiveState } from '@earendil-works/pi-durable'
import { deriveStatus, linkTo, MESSAGE_ENTRY, NOTE_ENTRY, RpcError, type Attachment, type Exposure, type Json, type MessageOrigin, type NewThread, type Note, type Pane, type ProviderRejection, type ReturnedMessage, type ThreadFailure, type ThreadInfo } from '@superego/protocol'
import type { UserMessage } from '@earendil-works/pi-ai'
import { attachmentsDir, attachmentsIn, contentOf } from './attachments.ts'
import type { ExtensionHost } from './extension-host.ts'
import type { ArchiveNote, ArchiveNotes, DaemonApi, MessageBlock, OutgoingMessage, ThreadDraft, ThreadNotice as NoticeInput, ThreadStarting, ThreadStop } from './extension.ts'
import { git } from './git.ts'
import { Catalog, clone, context, shortPath, stateOf, ThreadDoc, type Host, type Mounted, type ThreadMeta } from './host.ts'
import { titleOf } from './names.ts'
import type { ProfileHost } from './profile-host.ts'
import { findProfile, profileThere, relocated, type ProfileRef } from './profiles.ts'
import { lastRun, noteRecap, recapOf } from './recap.ts'
import { failureKind } from './request-budget.ts'
import { handoffMessage, HANDOFF_PROMPT, transcriptOf } from './handoff.ts'
import { opsWithoutPixels, withoutPixels } from './window-images.ts'

type Usage = { cost?: { total?: number } }
/** Everything a thread spent: every model's answers and every tool's own usage. */
const costOf = (usage: { models?: Record<string, Usage>; tools?: Record<string, Usage> } | undefined) =>
  usage && [...Object.values(usage.models ?? {}), ...Object.values(usage.tools ?? {})].reduce((sum, u) => sum + (u.cost?.total ?? 0), 0)

/** The repository `dir` is in: its checkout's top, and the project it belongs to (the main checkout, for a worktree). */
async function checkoutOf(dir: string): Promise<{ top: string; root: string } | undefined> {
  const top = await git(dir, ['rev-parse', '--show-toplevel']).catch(() => undefined)
  if (!top) return undefined
  const common = await git(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir']).catch(() => '')
  return { top, root: basename(common) === '.git' ? dirname(common) : top }
}

/** A pane's params as given: models sometimes send them as a string of JSON, which is taken for what it says. */
export function paneParams(params: unknown): Json {
  if (typeof params !== 'string') return params as Json
  try { return JSON.parse(params) as Json } catch { throw new RpcError('invalid', 'params must be an object') }
}

/** An origin with only what it says: no undefined keys, to keep in an entry. */
/** How long a message just sent may wait for its run to start before `thread.read`'s wait stops waiting for it. */
const STARTING = 10_000

/** A notice as its thread's agent is told it (`threads.notice`): whose it is, and that it isn't the user's words. */
export const noticeForAgent = (from: string, text: string) =>
  `<notice from="${from.replace(/"/g, "'")}">\n${text}\n</notice>\n(A notice ${from} showed the user in this thread, not a message from them.)`

const originOf = ({ by, from, exposure }: MessageOrigin): MessageOrigin => ({ ...(by ? { by } : {}), ...(from ? { from } : {}), ...(exposure ? { exposure } : {}) })

/**
 * How the message tool call `callId` answers came, by a thread's transcript, newest entry first: the input before the
 * model's message that made the call, a `MESSAGE_ENTRY`'s origin (`{}` for a window's user's). Every input is one; any
 * other user-role message (a compaction's summary, a reset's handoff, a hook's continuation) isn't an input, and the
 * walk goes on past it. Undefined when the call isn't among them, or no input is before it: refused, for a guard.
 */
export function answeredBy(entries: readonly Pick<EntryRecord, 'kind' | 'data' | 'model'>[], callId: string): MessageOrigin | undefined {
  let found = false
  for (const entry of entries) {
    for (const message of [...entry.model ?? []].reverse() as { role?: string; content?: unknown }[]) {
      if (!found) {
        found = message.role === 'assistant' && Array.isArray(message.content) && message.content.some((c: { type?: string; id?: string }) => c.type === 'toolCall' && c.id === callId)
        continue
      }
      if (message.role === 'user' && entry.kind === MESSAGE_ENTRY) return originOf((entry.data ?? {}) as MessageOrigin)
    }
  }
  return undefined
}

/**
 * A new thread as `startThread` takes it: an extension's attachments are inline (it has no connection to upload on).
 * `from`: the thread whose agent asked, through its shell's command line, when that isn't its parent.
 */
export type ThreadStart = Omit<NewThread, 'attachments'> & { attachments?: Attachment[]; hidden?: string; by?: string; exposure?: Exposure; from?: string }

export function createThreads(host: Host, { harness, extensions, profiles }: { harness: Harness; extensions: ExtensionHost; profiles: ProfileHost }) {
  const { options, agent, mounted, changed, defaultCwd, profileSources, folderOf } = host
  /** The threads being archived now that their run ended (see archiveWhenDone). */
  const archiving = new Set<string>()
  /** The transcript watches open on each thread, to end when it's cleared (clients then watch again). */
  const transcriptWatches = new Map<string, Set<() => unknown>>()

  /**
   * The conversations a task made (a subagent's), each by the conversation it was made in: how `threadOf` finds the
   * thread one belongs to. Heard as they're made; the ones made before this process, read at start (`learnConversations`).
   */
  const madeIn = new Map<number, number>()
  const learn = ({ id, owner }: ConversationRecord) => { if (owner) madeIn.set(Number(id), Number(owner.conversationId)) }
  harness.observeCommits({ advance: ({ changes }) => { for (const c of changes) if (c.type === 'conversation') learn(c.value) }, end: () => {} })
  async function learnConversations() {
    let cursor: Cursor | undefined
    do {
      const page = await harness.commit((tx) => tx.scanConversations({}, 500, cursor), context)
      page.items.forEach(learn)
      cursor = page.next
    } while (cursor !== undefined)
  }
  /** The thread a conversation belongs to: its own, or, a subagent's, the thread at the top of what made it. */
  function threadOf(conversationId: number): string | undefined {
    for (let id: number | undefined = conversationId, hops = 0; id !== undefined && hops <= madeIn.size; id = madeIn.get(id), hops++) {
      if (mounted.has(String(id))) return String(id)
    }
    return undefined
  }

  /** Threads being mounted: two asking at once get the one, watched once (else each run is told twice). */
  const mounting = new Map<string, Promise<Mounted>>()
  async function mount(id: ConversationId): Promise<Mounted> {
    const key = String(id)
    const existing = mounted.get(key) ?? mounting.get(key)
    if (existing) return existing
    const next = mountAnew(id).finally(() => mounting.delete(key))
    mounting.set(key, next)
    return next
  }
  async function mountAnew(id: ConversationId) {
    const key = String(id)
    const conversation = await harness.conversation(id, context)
    if (!conversation) throw new RpcError('not_found', `No thread ${key}`)
    // A one-entry window is enough to know the newest entry and the live run.
    const watch = await conversation.watch(context, { min: 1, max: 2 })
    const entry: Mounted = {
      conversation,
      meta: (await harness.snapshot(ThreadDoc, id, context)) ?? { title: '', cwd: defaultCwd, createdAt: 0 },
      stop: () => watch.stop(),
    }
    const absorb = (view: ConversationView) => {
      const wasRunning = Boolean(entry.live?.run)
      entry.live = view.docs['pi.live'] as LiveState | undefined
      const last = view.entries.at(-1)
      // Activity is a new entry or a run starting, not every streamed chunk (which would churn the thread list).
      // A message's own timestamp survives restarts.
      if (last?.id !== entry.lastEntryId) {
        entry.activeAt = (last?.model?.at(-1) as { timestamp?: number } | undefined)?.timestamp ?? Date.now()
      } else if (entry.live?.run && !wasRunning) entry.activeAt = Date.now()
      entry.lastEntryId = last?.id
      const ran = view.docs['pi.agent'] as { model?: { modelId?: string; provider?: string }; thinkingLevel?: string } | undefined
      entry.model = ran?.model?.modelId
      entry.provider = ran?.model?.provider
      entry.thinking = ran?.thinkingLevel
      if (entry.live?.run && !wasRunning) entry.ranWith = entry.provider === undefined ? undefined : agent.credentialOf(entry.provider)
      entry.cost = costOf(view.docs['pi.usage'] as Parameters<typeof costOf>[0])
      heedFailure(key, entry)
      changed()
    }
    absorb(watch.value)
    // Done when it's mounted (it answered while the daemon was down, or before): what it did, too.
    if (!entry.meta.archived && lastAnswer(entry) !== undefined && lastAnswer(entry)! > (entry.meta.seen?.entryId ?? -1)) entry.recap = await runRecap(key, entry)
    watch.start(async (call) => {
      if (call.kind !== 'value') return
      const wasRunning = Boolean(entry.live?.run)
      // A run ending (or an answer coming without one): what it did, worked out before clients hear it's done.
      if (!(call.value.docs['pi.live'] as LiveState | undefined)?.run && (wasRunning || call.value.entries.at(-1)?.id !== entry.lastEntryId)) {
        entry.recap = await runRecap(key, entry)
      }
      absorb(call.value)
      // A run starting or ending, as the extensions' hooks hear it (one resumed after a restart was running already).
      const running = Boolean(entry.live?.run)
      if (running !== wasRunning) tellLater(running ? 'turnStart' : 'turnEnd', key)
      archiveIfDone(key, entry)
    })
    mounted.set(key, entry)
    archiveIfDone(key, entry)
    return entry
  }

  /** What clients see of a thread; `without` worked out once for its facts and what it goes without. */
  const info = (id: string, m: Mounted, without = extensions.withoutFor(id, m.meta)): ThreadInfo => ({
    id, title: m.meta.title || 'New thread', cwd: m.meta.cwd, createdAt: m.meta.createdAt,
    activeAt: Math.max(m.activeAt ?? 0, m.meta.createdAt),
    ...(m.model ? { model: m.model, ...(m.provider ? { provider: m.provider } : {}), ...(m.thinking ? { thinking: m.thinking } : {}) } : {}), ...(m.cost ? { cost: m.cost } : {}),
    ...(m.meta.model || m.meta.thinking ? { chosen: { ...(m.meta.model ? { model: m.meta.model } : {}), ...(m.meta.thinking ? { thinking: m.meta.thinking } : {}) } } : {}),
    ...(m.meta.profile ? { profile: m.meta.profile } : {}),
    ...extensions.modelFromOf(id, m.meta),
    ...(m.meta.panes?.length ? { panes: m.meta.panes, ...(m.meta.pane ? { pane: m.meta.pane } : {}) } : {}),
    ...(m.meta.width !== undefined ? { width: m.meta.width } : {}), ...(m.meta.lastWidth !== undefined ? { lastWidth: m.meta.lastWidth } : {}),
    project: { root: rootOf(m), name: basename(rootOf(m)) },
    ...extensions.factsOf(id, m.meta, without),
    ...extensions.quietOf(id, m.meta, without),
    ...(m.meta.archived ? { archived: true } : {}),
    ...(m.meta.hidden ? { hidden: true, ...(m.meta.owner ? { owner: m.meta.owner } : {}) } : {}),
    ...(m.meta.parent ? { parent: m.meta.parent } : {}),
    ...failureOf(m),
    ...(m.meta.lean ? { lean: true as const } : {}),
    ...(m.meta.continues ? { continues: m.meta.continues } : {}), ...(m.meta.continuedIn ? { continuedIn: m.meta.continuedIn } : {}),
    ...(without.size ? { without: [...without].sort() } : {}),
    // A thread of another kind of agent: what it runs on, as its kind says.
    ...extensions.kindInfoOf(id, m.meta, without),
    status: deriveStatus({ live: m.live, lastEntryId: lastAnswer(m), seen: m.meta.seen, ...extensions.blockedOf(id, without, m.meta), ...signInOf(id, m), ...(m.recap ? { recap: m.recap } : {}) }),
  })
  /** How a thread's last run failed, while it stands so (`ThreadInfo.failure`). */
  const failureOf = (m: Mounted): { failure?: ThreadFailure } => {
    const failure = m.live?.run ? undefined : m.live?.runFailure
    if (!failure || failure.reason === 'aborted') return {}
    const detail = failure.detail ?? failure.reason
    return { failure: { kind: failureKind(detail), detail, times: m.failed?.taskId === failure.taskId ? m.failed.times : 1 } }
  }
  /** What a thread's last run did, in a line: its extensions' recap of it (those it doesn't go without), else its answer's first sentence. */
  async function runRecap(id: string, m: Mounted) {
    try {
      const { items } = await m.conversation.entries({ order: 'descending' }, 50, undefined, context)
      const since = items.filter((entry) => Number(entry.id) >= (m.meta.cleared ?? 0))
      // A note since (an extension's notice, say) is what's new: it says it.
      const noted = noteRecap(since[0])
      if (noted) return noted
      const run = lastRun(since)
      const without = extensions.withoutFor(id, m.meta)
      return recapOf({ thread: id, ...run }, extensions.recapsFor(without, m.meta))
    } catch (error) {
      console.error(`Thread ${id}: its recap failed:`, error)
      return undefined
    }
  }
  /**
   * A run that failed for its credentials: its thread waits for sign-in to the provider (whose turns then fail at once)
   * until those change or someone retries. Each failure once; those there before the thread was watched were heard of
   * before (or are too old to wait on). A thread that runs again, or answers, no longer waits.
   */
  function heedFailure(id: string, m: Mounted) {
    const failure = m.live?.run ? undefined : m.live?.runFailure
    const fresh = failure && m.failure !== undefined && failure.taskId !== m.failure
    m.failure = failure?.taskId ?? null
    // Counted: the same failure again and again is one more of the same won't fix.
    if (failure && failure.reason !== 'aborted') {
      const detail = failure.detail ?? failure.reason
      if (failure.taskId !== m.failed?.taskId) m.failed = { taskId: failure.taskId, detail, times: m.failed?.detail === detail ? m.failed.times + 1 : 1 }
    } else if (!m.live?.run) m.failed = undefined
    if (fresh && failure.reason === 'model_error' && m.provider && agent.rejected(m.provider, id, failure.taskId, failure.detail, m.ranWith)) return
    if (!agent.rejections.waiting(id, failure?.taskId)) agent.rejections.release(id)
  }
  const waitingOn = (id: string, m: Mounted) => m.live?.run ? undefined : agent.rejections.waiting(id, m.live?.runFailure?.taskId)
  const signInOf = (id: string, m: Mounted) => {
    const rejection = waitingOn(id, m)
    return rejection ? { signIn: rejection.summary } : {}
  }
  /** The providers that rejected this machine's credentials, with the threads in use waiting on them. */
  const rejectedNow = (): ProviderRejection[] => agent.rejections.all().map(({ credential: _, threads, ...rejection }) => ({
    ...rejection, threads: Object.keys(threads).filter((id) => mounted.has(id) && !mounted.get(id)!.meta.archived),
  }))
  /**
   * Retry the threads waiting on `provider` (or every rejected one), once each: their runs continue where they failed,
   * as one cut off by a restart does. One whose credentials are rejected again waits again, until the next change.
   */
  async function retrySignIn(provider?: string) {
    let retried = 0
    for (const id of provider ? [provider] : agent.rejections.all().map((r) => r.provider)) {
      const rejection = agent.rejections.retry(id)
      if (!rejection) continue
      for (const thread of Object.keys(rejection.threads)) {
        const m = mounted.get(thread)
        if (!m || m.meta.archived || host.state.restarting || !waitingOn(thread, m)) continue
        try {
          await m.conversation.submit({ type: 'continue' }, context)
          retried++
        } catch (error) {
          console.error(`Retrying thread ${thread} after sign-in:`, error)
        }
      }
      agent.rejections.settle(rejection)
    }
    return retried
  }
  /** A thread's project, kept since it started (the folder, for a thread there's no record of). */
  const rootOf = (m: Mounted) => m.meta.root ?? m.meta.cwd
  /** Only an assistant answer makes a thread "done"; the user's own message does not. */
  const lastAnswer = (m: Mounted) => m.live?.run ? undefined : m.lastEntryId

  /** The threads, newest first: the ones in use, or (`archived`) the ones put away; (`hidden`) those in no list instead. */
  async function list({ archived = false, hidden = false } = {}): Promise<ThreadInfo[]> {
    const catalog = await harness.snapshot(Catalog, context)
    const items: ThreadInfo[] = []
    for (const id of [...(catalog?.ids ?? [])].reverse()) {
      const m = await mount(id as ConversationId)
      if (Boolean(m.meta.archived) === archived && Boolean(m.meta.hidden) === hidden) items.push(info(String(id), m))
    }
    return items
  }

  /** A thread by id, listed or hidden. */
  async function get(id: string) {
    const conversationId = Number(id) as ConversationId
    const catalog = await harness.snapshot(Catalog, context)
    if (!catalog?.ids.includes(conversationId)) throw new RpcError('not_found', `No thread ${id}`)
    return mount(conversationId)
  }

  async function updateMeta(id: string, edit: (meta: ThreadMeta) => void) {
    const m = await get(id)
    m.meta = await m.conversation.commit(async (tx) => {
      const meta = await tx.doc(ThreadDoc, m.conversation.id)
      edit(meta)
      return clone(meta)
    }, context)
    changed()
  }

  /** Change an extension's state with a thread: `undefined` forgets it. */
  function editState(id: string, name: string, edit: (current: Json | undefined) => Json | undefined) {
    return updateMeta(id, (meta) => {
      const next = clone(edit(clone(stateOf(meta, name))))
      if (next !== undefined) meta.ext = { ...meta.ext, [name]: next }
      else if (meta.ext && Object.hasOwn(meta.ext, name)) {
        const { [name]: _gone, ...rest } = meta.ext
        if (Object.keys(rest).length) meta.ext = rest
        else delete meta.ext
      }
    })
  }

  // ── Thread hooks ────────────────────────────────────────────────────────────────────────────────────────────────

  /** The extensions' hooks for a thread, in order: those it doesn't go without, a profile's for its own threads only. */
  const hooksOf = (id: string, m: Mounted) => {
    const without = extensions.withoutFor(id, m.meta)
    return extensions.hooksFor(without, m.meta)
  }
  /** A refusal from an extension's hook, as clients see it: its own `RpcError`, else `refused`, saying whose. */
  const refusal = (owner: string, error: unknown) =>
    error instanceof RpcError ? error : new RpcError('refused', `${owner}: ${error instanceof Error ? error.message : String(error)}`)
  /**
   * A thread's profile loaded, so its extensions' hooks are there for it (after a restart, a profile loads only once
   * one of its threads runs). One that no longer loads is logged, and its hooks are gone with it.
   */
  async function withProfile(id: string) {
    const profile = await rebound(id).catch(() => undefined)
    if (profile) await profiles.profileOf(profile).catch((error: Error) => console.error(`Profile ${profile.name}: ${error.message}`))
  }
  /**
   * A thread's profile where it is now. One whose folder was moved or deleted out from under it is looked for by name
   * where the thread could start one now (relocated: from its folder, then its project's): found, the thread runs that
   * one from now on, and says so in its transcript. Not found, it keeps the one it had (see profileFor).
   */
  async function rebound(id: string): Promise<ProfileRef | undefined> {
    const m = await get(id)
    const was = m.meta.profile
    if (!was || profileThere(was)) return was
    const found = relocated(was, [m.meta.cwd, rootOf(m)], profileSources.roots())
    if (!found) return was
    await updateMeta(id, (meta) => { meta.profile = found })
    letGoOf(was)
    await note(id, `The ${was.name} profile is no longer at ${shortPath(was.dir)}: this thread runs ${found.scope === 'user' ? 'yours' : "the project's"}, at ${shortPath(found.dir)}, from now on.`)
    return found
  }
  /** A profile whose folder is gone, once no thread is bound to it: what it set up let go of, its failure forgotten. */
  function letGoOf(ref: ProfileRef) {
    if (profileThere(ref) || [...mounted.values()].some((m) => m.meta.profile?.dir === ref.dir)) return
    profiles.forget(ref.dir)
  }
  /** A thread's profile for a turn: rebound where it moved, else refused as gone, for the user to give it another. */
  async function profileFor(id: string): Promise<ProfileRef | undefined> {
    const ref = await rebound(id)
    if (ref && !profileThere(ref)) {
      throw new RpcError('profile_missing', `No profile ${ref.name} at ${ref.dir}, nor one of that name for this thread's folder`, {
        hint: `Give it another: ${options.app.id} do thread.setProfile --thread ${id} --profile <name> (or none, for the default)`,
      })
    }
    return ref
  }
  /**
   * Ask the hooks that may refuse (`archiving`, `unarchiving`): the first to throw stops it, with its error. Those whose
   * hook ran already, for `unarchiving`, are returned, to be told if it doesn't happen after all (`unarchiveAbandoned`);
   * a refusal tells them itself.
   */
  async function ask(hook: 'archiving' | 'unarchiving', id: string, notes: ArchiveNotes = {}) {
    const m = await get(id)
    const asked: ReturnType<typeof extensions.hooksFor> = []
    for (const owned of hooksOf(id, m)) {
      try {
        noted(notes, owned.owner, await owned.value[hook]?.(info(id, m)))
        if (owned.value[hook]) asked.push(owned)
      } catch (error) {
        if (hook === 'unarchiving') await abandonUnarchive(id, asked)
        throw refusal(owned.owner, error)
      }
    }
    return asked
  }
  /** Tell the hooks whose `unarchiving` ran that the thread stays archived, in reverse: each undoes what it put back. */
  async function abandonUnarchive(id: string, asked: ReturnType<typeof extensions.hooksFor>) {
    const m = await get(id)
    for (const { value, owner } of [...asked].reverse()) {
      try {
        await value.unarchiveAbandoned?.(info(id, m))
      } catch (error) {
        console.error(`Extension ${owner}: unarchiveAbandoned of thread ${id} failed:`, error)
      }
    }
  }
  /** Keep the line a hook said of what it did, under its extension's name. */
  const noted = (notes: ArchiveNotes, owner: string, said: unknown) => {
    const note = (said as ArchiveNote | undefined)?.note
    if (typeof note === 'string' && note) notes[owner] = notes[owner] ? `${notes[owner]} ${note}` : note
  }
  /** Tell the hooks what happened, in order: one that throws is logged, and the rest are told all the same. */
  async function tell(hook: 'started' | 'turnStart' | 'turnEnd' | 'blocked' | 'archived' | 'unarchived', id: string, as?: Partial<ThreadInfo>, notes: ArchiveNotes = {}) {
    const m = await get(id)
    for (const { value, owner } of hooksOf(id, m)) {
      try {
        // Each sees what the ones before it did (a worktree removed).
        noted(notes, owner, await value[hook]?.({ ...info(id, m), ...as }))
      } catch (error) {
        console.error(`Extension ${owner}: ${hook} of thread ${id} failed:`, error)
      }
    }
    return notes
  }
  /** Tell the hooks panes beside a thread closed (closed, or gone as it was cleared): one that throws is logged. */
  async function tellPaneClosed(id: string, panes: Pane[]) {
    if (!panes.length) return
    const m = await get(id)
    for (const { value, owner } of hooksOf(id, m)) {
      for (const pane of value.paneClosed ? panes : []) {
        try { await value.paneClosed!(info(id, m), pane) } catch (error) { console.error(`Extension ${owner}: paneClosed of thread ${id} failed:`, error) }
      }
    }
  }
  /**
   * Turns as the hooks hear them: in order for each thread, one after another, never holding up the run. A stop
   * (`stopped`) too, in turn: the run's end it brought may be told before or after it, as the thread's watch hears it.
   */
  const told = new Map<string, Promise<void>>()
  function tellLater(hook: 'turnStart' | 'turnEnd' | 'blocked', id: string): void
  function tellLater(hook: 'stopped', id: string, stop: ThreadStop): void
  function tellLater(hook: 'turnStart' | 'turnEnd' | 'blocked' | 'stopped', id: string, stop?: ThreadStop) {
    if (!extensions.hears(hook)) return
    const telling = async () => {
      if (hook !== 'stopped') return void await tell(hook, id)
      const m = await get(id)
      for (const { value, owner } of hooksOf(id, m)) {
        try { await value.stopped?.(info(id, m), clone(stop!)) } catch (error) { console.error(`Extension ${owner}: stopped of thread ${id} failed:`, error) }
      }
    }
    // tell() logs each hook's failure itself; a failure to reach the thread at all (gone meanwhile) leaves nothing to tell.
    const next = (told.get(id) ?? Promise.resolve()).then(telling).catch(() => {})
    told.set(id, next)
    void next.then(() => { if (told.get(id) === next) told.delete(id) })
  }
  /**
   * The threads that need the user now (an extension's `status`), so `blocked` is told once each time one comes to.
   * Status changes only when an extension says so (`invalidate`), so that's when it's looked at.
   */
  const needing = new Set<string>()
  function heedStatus() {
    for (const [id, m] of mounted) {
      const blocked = !m.meta.archived && Boolean(extensions.blockedOf(id, extensions.withoutFor(id, m.meta), m.meta).blocked)
      if (blocked === needing.has(id)) continue
      if (blocked) { needing.add(id); tellLater('blocked', id) } else needing.delete(id)
    }
  }

  /** A thread's newest transcript entries, newest first: none from before it was last cleared. */
  async function newest(id: string, limit: number) {
    const m = await get(id)
    const { items } = await m.conversation.entries({ order: 'descending' }, limit, undefined, context)
    return items.filter((entry) => Number(entry.id) >= (m.meta.cleared ?? 0))
  }
  async function answerOf(id: string) {
    for (const entry of await newest(id, 50)) {
      const message = entry.model?.[0] as { role?: string; content?: unknown } | undefined
      if (message?.role !== 'assistant' || !Array.isArray(message.content)) continue
      const said = (message.content as { type: string; text?: string }[]).filter((b) => b.type === 'text').map((b) => b.text ?? '').join('').trim()
      if (said) return said
    }
    return undefined
  }
  /**
   * Send `text` to a thread, with the model and thinking it chose, else what this machine's settings say now. `origin`,
   * how it came (`MessageOrigin`): `by` the extension sending it (`threads.send`, `threads.start`'s prompt), none for a
   * client's (a window, the command line); `exposure`, whom for, when a client ran it as the command line or an outside
   * agent (`DaemonContext.exposure`); `from`, the thread it's from. Kept with it, as a `MESSAGE_ENTRY` (`answering`): every
   * input is one, a window's user's too (`{}`), so nothing else in a transcript passes for an input.
   */
  async function submit(id: string, text: string, requestId: string, whenBusy?: 'steer' | 'followUp', attachments: Attachment[] = [], origin: MessageOrigin = {}) {
    if (!text.trim() && !attachments.length) throw new RpcError('invalid', 'Nothing to send')
    const m = await get(id)
    await ready(id, m, 'send to it')
    if (!m.meta.title) await updateMeta(id, (meta) => { meta.title = titleOf(text.trim() || attachments.map((a) => a.name).join(', ')) })
    const said = originOf(origin)
    const content = await transformed(id, m, { text, attachments, ...said }, await contentOf(attachmentsDir(options.dataDir, id), text, attachments))
    const submission = await m.conversation.submit({ type: 'input', content, requestId, ...(whenBusy ? { whenBusy } : {}), entry: { kind: MESSAGE_ENTRY, data: said } }, context)
    return String(submission.id)
  }

  /**
   * Its agent set up as it is now, to run (`doing`: what's refused for an archived one): its profile found (where it
   * moved) and loaded, its model, or its kind's runner. Refused when it's put away, its extension's off, or it has no
   * model.
   */
  async function ready(id: string, m: Mounted, doing: string) {
    // Put away: it can be read, not written to, until it's brought back.
    if (m.meta.archived) throw new RpcError('archived', 'This thread is archived', { hint: `Unarchive it to ${doing}.` })
    await profileFor(id)
    const { model, thinkingLevel, without, ...rest } = await extensions.agentOf(id, m.meta)
    // An extension's own thread runs as that extension makes it, or not at all: not while it's off here, or the thread
    // goes without it.
    if (m.meta.owner && (!extensions.offered(m.meta.owner) || without.has(m.meta.owner))) throw new RpcError('invalid', `This thread is the ${m.meta.owner} extension's, which is off here`)
    // A thread of another kind of agent has its turns run by that kind's runner, not a model: one only while it's here.
    const runner = runnerOf(m.meta, without)
    if (!model && !runner) throw new RpcError('no_model', 'No model is available', { hint: 'Sign in to a provider in Settings.' })
    await m.conversation.configure({ ...(runner ? { runner, model: null, thinkingLevel: null } : { model, thinkingLevel: thinkingLevel ?? null, runner: null }), ...rest }, context)
  }

  /**
   * Compact a thread's conversation (`thread.compact`): what came before its newest stretch summarized, `instructions`
   * saying what the summary should keep. Superego's own agent does it as pi-durable does, and answers once it's done
   * (the summary goes in at the next step while it works); another kind's agent is asked to, as it says (Claude Code's
   * `/compact`), and its turn says how it went. Refused when there's nothing old enough to compact yet.
   */
  async function compact(id: string, instructions?: string) {
    const m = await get(id)
    await ready(id, m, 'compact it')
    const asked = instructions?.trim() || undefined
    if (m.meta.agent) {
      const ask = extensions.kindCompact(m.meta.agent)
      if (!ask) throw new RpcError('invalid', `${extensions.kindTitle(m.meta.agent)} threads can't be compacted from here`)
      return { submission: await submit(id, ask(asked), randomUUID()) }
    }
    const task = await m.conversation.compact(asked, context)
    const { state } = await harness.waitForTask(task, context)
    const outcome = state.outcome
    if (outcome.status !== 'completed') throw new RpcError('error', `Compacting failed: ${outcome.error?.message ?? outcome.status}`)
    if (outcome.result.entryId === undefined && outcome.result.submissionId === undefined) {
      throw new RpcError('invalid', 'Nothing to compact yet: the conversation is still short enough to keep whole')
    }
    return { compacted: true }
  }

  /**
   * Run a thread's failed turn again (`thread.retry`), as one cut off by a restart goes on: `lean`, sent lean from now on
   * (only its newest images, its old tool output cut short: `ThreadMeta.lean`); `compact`, what came before its newest
   * stretch summarized first. For a thread stuck on a request too large for its provider, or failing the same way again.
   */
  async function retry(id: string, { lean = false, compact: compacting = false }: { lean?: boolean; compact?: boolean } = {}) {
    const m = await get(id)
    await ready(id, m, 'retry it')
    if (m.live?.run) throw new RpcError('busy', 'It\'s working already')
    if (m.meta.agent && lean) throw new RpcError('invalid', `${extensions.kindTitle(m.meta.agent)} threads send their own requests`)
    if (lean && !m.meta.lean) await updateMeta(id, (meta) => { meta.lean = true })
    if (compacting) await compact(id)
    await m.conversation.submit({ type: 'continue' }, context)
    return { retried: true }
  }

  /**
   * Start a fresh thread from one that can't go on (`thread.handoff`): in the same folder, with its profile, model and
   * parent, its first message a handoff its model writes from the old one's transcript (handoff.ts). The old one links
   * to it, and it takes over: the old one's children (they report to it now) and its extensions' state (its worktree).
   */
  async function handoff(id: string) {
    const m = await get(id)
    if (m.meta.archived) throw new RpcError('archived', 'This thread is archived', { hint: 'Unarchive it to start a fresh thread from it.' })
    if (m.meta.hidden) throw new RpcError('invalid', 'An extension\'s own thread can\'t be continued in another')
    if (m.meta.agent) throw new RpcError('invalid', `${extensions.kindTitle(m.meta.agent)} threads can't be continued from here`)
    if (m.live?.run) throw new RpcError('busy', 'It\'s working: stop it first')
    if (m.meta.continuedIn) throw new RpcError('invalid', `It's continued in thread ${m.meta.continuedIn} already`)
    const old = info(id, m)
    const transcript = transcriptOf((await m.conversation.context(context)).messages)
    const written = await writeHandoff(m, transcript)
    const fresh = await startThread({
      cwd: m.meta.cwd, title: `${old.title.replace(/ \(continued\)$/, '')} (continued)`, ...(m.meta.profile ? { profile: m.meta.profile.name } : {}),
      ...(m.meta.model ? { model: m.meta.model } : {}), ...(m.meta.thinking ? { thinking: m.meta.thinking } : {}), ...(m.meta.parent ? { parent: m.meta.parent } : {}),
      // Where the old one worked: not a worktree of its own.
      options: { worktrees: false },
    })
    const ext = clone(m.meta.ext)
    await updateMeta(fresh.id, (meta) => {
      meta.continues = id
      if (ext) meta.ext = { ...ext, ...meta.ext }
    })
    await updateMeta(id, (meta) => {
      meta.continuedIn = fresh.id
      delete meta.ext
    })
    for (const [child, c] of mounted) if (c.meta.parent === id) await updateMeta(child, (meta) => { meta.parent = fresh.id })
    await note(id, `Continued in ${linkTo(fresh)}.`)
    await submit(fresh.id, handoffMessage(linkTo(old), written), randomUUID(), undefined, [], { from: id })
    return { thread: fresh.id }
  }
  /** The handoff a thread's model writes from its transcript; why it couldn't, when it couldn't. */
  async function writeHandoff(m: Mounted, transcript: string): Promise<{ summary: string } | { failed: string; transcript: string }> {
    const model = m.provider && m.model ? agent.models.getModel(m.provider, m.model) : undefined
    if (!model) return { failed: 'it has no model here', transcript }
    try {
      const reply = await agent.models.completeSimple(model, {
        systemPrompt: HANDOFF_PROMPT, messages: [{ role: 'user', content: `<transcript>\n${transcript}\n</transcript>`, timestamp: Date.now() }],
      }, { maxTokens: 4000, signal: AbortSignal.timeout(180_000) })
      if (reply.stopReason === 'error' || reply.stopReason === 'aborted') throw new Error(reply.errorMessage ?? reply.stopReason)
      const summary = reply.content.map((block) => block.type === 'text' ? block.text : '').join('').trim()
      if (!summary) throw new Error('its model wrote nothing')
      return { summary }
    } catch (error) {
      const failed = error instanceof Error ? error.message : String(error)
      console.error(`The handoff of thread ${m.conversation.id} couldn't be written:`, error)
      return { failed, transcript }
    }
  }

  /** The runner of a thread's kind of agent (`ThreadMeta.agent`): none for Superego's own; refused when its kind isn't here. */
  function runnerOf(meta: ThreadMeta, without: ReadonlySet<string>) {
    if (!meta.agent) return undefined
    const runner = extensions.runnerOf(meta.agent, without)
    if (!runner) throw new RpcError('invalid', `This thread runs on ${meta.agent}, which isn't on here`, { hint: `Turn on the extension that has ${meta.agent} in Settings.` })
    return runner
  }

  /** How the message tool call `callId` answers came (`answeredBy`), in a thread's newest entries. */
  async function answering(conversationId: number, callId: string): Promise<MessageOrigin | undefined> {
    const id = String(conversationId)
    return mounted.has(id) ? answeredBy(await newest(id, 500), callId) : undefined
  }

  /** What parents have read of their children (`noteRead`): the activity each child was read at, newest. In memory. */
  const readAt = new Map<string, number>()
  async function noteRead(reader: string, read: Pick<ThreadInfo, 'id' | 'activeAt' | 'status'>) {
    if ((await get(read.id)).meta.parent !== reader || read.status.state === 'working') return
    readAt.set(read.id, Math.max(readAt.get(read.id) ?? 0, read.activeAt))
  }

  /** Once a thread isn't working (its run ended, or it needs the user), or `signal` aborts: its info then. */
  async function idle(id: string, signal?: AbortSignal) {
    await get(id)
    return new Promise<ThreadInfo>((resolve, reject) => {
      const check = () => {
        get(id).then((m) => {
          const now = info(id, m)
          if (now.status.state === 'working' && !signal?.aborted) return
          stop()
          resolve(now)
        }, (error) => { stop(); reject(error) })
      }
      const off = host.onChanged(check)
      const stop = () => { off(); signal?.removeEventListener('abort', check) }
      signal?.addEventListener('abort', check)
      check()
    })
  }

  /** Once any thread changes, `ms` passes, or `signal` aborts. */
  const changeOrAfter = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve) => {
    const off = host.onChanged(done)
    const timer = setTimeout(done, ms)
    signal?.addEventListener('abort', done, { once: true })
    function done() { off(); clearTimeout(timer); signal?.removeEventListener('abort', done); resolve() }
  })

  /** Whether a thread's newest message is the user's, with no reply begun: one just sent, before its run starts. */
  async function unanswered(id: string) {
    // A notice the agent was told of is no message to answer.
    const last = (await newest(id, 20)).filter((entry) => entry.kind !== NOTE_ENTRY).map((entry) => entry.model?.[0] as { role?: string } | undefined).find((message) => message?.role)
    return last?.role === 'user'
  }

  /**
   * A thread and its last answer (`thread.read`). `wait`: once it isn't working (`idle`), and has answered a message
   * just sent, unless its run doesn't start within `STARTING`; or once `signal` aborts.
   */
  async function read(id: string, { wait = false, signal }: { wait?: boolean; signal?: AbortSignal } = {}) {
    let thread = info(id, await get(id))
    const since = Date.now()
    while (wait && !signal?.aborted) {
      thread = await idle(id, signal)
      if (thread.status.state === 'blocked' || thread.status.state === 'error' || !await unanswered(id)) break
      const left = STARTING - (Date.now() - since)
      if (left <= 0) break
      await changeOrAfter(left, signal)
    }
    return { thread, answer: (await answerOf(id)) ?? null }
  }

  /**
   * A message's content as extensions' send transforms leave it (a skill it names brought along, say): each in turn,
   * those of extensions the thread goes without skipped, and a profile's for its own threads only. Untouched, it's sent
   * as it came.
   */
  async function transformed(id: string, m: Mounted, message: Pick<OutgoingMessage, 'text' | 'attachments' | 'by' | 'exposure' | 'from'>, content: string | MessageBlock[]) {
    const without = extensions.withoutFor(id, m.meta)
    const applying = extensions.transformsFor(without, m.meta)
    if (!applying.length) return content
    const thread = info(id, m)
    let blocks: MessageBlock[] = typeof content === 'string' ? (content ? [{ type: 'text', text: content }] : []) : content
    let touched = false
    for (const transform of applying) {
      // A copy: only what it returns counts, whether the message came as text or as blocks.
      const next = await transform({ thread, ...message, content: [...blocks] })
      if (next) { blocks = next; touched = true }
    }
    return touched ? blocks : content
  }

  /**
   * Open a pane beside thread `id` (or find the same one already open). Opening isn't focusing: the agent's pane opens
   * beside, and the focus stays where it is. A window that asked for one moves its focus into it, which brings it
   * forward (pane.focus): the focus is in one place, the prompt or the pane. The agent's is `by: 'agent'` (Pane);
   * opened by anyone else, the same one isn't anymore.
   */
  async function openPane(id: string, pane: Omit<Pane, 'id'>): Promise<Pane> {
    await get(id)
    if (pane.params !== undefined) pane = { ...pane, params: paneParams(pane.params) }
    let opened: Pane | undefined
    await updateMeta(id, (meta) => {
      const same = (meta.panes ?? []).find((p) => p.kind === pane.kind && JSON.stringify(p.params ?? null) === JSON.stringify(pane.params ?? null))
      opened = same ?? { id: randomUUID().slice(0, 8), ...pane }
      if (!same) meta.panes = [...(meta.panes ?? []), opened]
      else {
        if (pane.title) same.title = pane.title
        if (!pane.by) delete same.by
      }
      // A plain copy: what the transaction hands over is only valid inside it.
      opened = clone(opened)
    })
    return opened!
  }

  /**
   * A new thread as asked for: where, with what; a child of `parent` when a thread starts it (a hidden one's too, Ego's:
   * it hears from it, though no list shows it there); `hidden`, in no list and the extension's of that name. Extensions' `starting` hooks
   * may move it (a worktree) and give it state.
   */
  async function startThread({ cwd, title, model: given, thinking, prompt, attachments, profile: profileName, parent, options: asked, hidden, by, exposure, from }: ThreadStart) {
    // Uploads are inline again by now (see connection.ts).
    const dir = folderOf(cwd)
    if (!(await stat(dir).then((s) => s.isDirectory(), () => false))) throw new RpcError('invalid', `No folder ${dir} on ${hostname()}`)
    // Given neither a model nor a profile, the machine's default: another kind's (Claude Code's, picked in setup) starts
    // it on that kind, unless the project has a default profile of its own. Refused while that kind can't run here,
    // never started on another provider instead.
    const plain = !given && !profileName?.trim() && !hidden
    const kindDefault = plain && findProfile(dir, profileSources.roots())?.scope !== 'project' ? await agent.kindDefault() : undefined
    if (kindDefault?.unavailable) throw new RpcError('model_unavailable', kindDefault.unavailable, { hint: 'Pick another model with Set up models.' })
    const ownModel = given ?? kindDefault?.model
    // Another kind of agent's model (Claude Agent's): the thread runs on that kind, with a profile of it.
    const modelKind = ownModel ? await extensions.kindOfModel(ownModel) : undefined
    if (ownModel && !modelKind && !agent.catalog().models.some((m) => m.value === ownModel)) throw new RpcError('invalid', `No model ${ownModel} here; sign in to its provider first`)
    if (modelKind && hidden) throw new RpcError('invalid', `An extension's own thread can't run on ${extensions.kindTitle(modelKind)}`)
    // A parent that's there (`not_found` otherwise).
    if (parent) await get(parent)
    // The project's profile (or the user's) of that name, else the default one there is; checked (and allowed) now.
    // None for an extension's own thread: it runs as that extension makes it, whatever profiles say. Started on another
    // kind's model with no profile named, the kind's own; that one made first if need be.
    const own = modelKind ? extensions.kindProfile(modelKind) : undefined
    const named = profileName?.trim() || own?.name
    if (own && named === own.name) await own.make()
    const ref = hidden ? undefined : findProfile(dir, profileSources.roots(), named)
    const loaded = ref ? await profiles.profileOf(ref) : undefined
    // Its kind of agent, for its whole life: only one that's here.
    const kind = typeof loaded?.spec.agent === 'string' && loaded.spec.agent ? loaded.spec.agent : undefined
    if (kind && !extensions.runnerOf(kind, new Set())) throw new RpcError('invalid', `Profile ${ref!.name} runs on ${kind}, which isn't here`, { hint: `Turn on the extension that has ${kind} in Settings.` })
    // A model is its kind's: one of another kind's isn't this thread's to run with.
    if (ownModel && modelKind !== kind) {
      const runsOn = ref ? `The ${ref.name} profile runs on ${extensions.kindTitle(kind)}` : `Without a profile, a thread runs on ${extensions.kindTitle(kind)}`
      throw new RpcError('invalid', `${runsOn}, not ${extensions.kindTitle(modelKind)}: ${ownModel} isn't one of its models`, {
        hint: modelKind ? `Pick a profile that runs on ${extensions.kindTitle(modelKind)}, or none.` : 'Pick one of its models, or another profile.',
      })
    }
    // Its project is the checkout (or folder) it starts in; where in it it works is the folder given, unless a hook moves it.
    const checkout = await checkoutOf(dir)
    const draft: ThreadDraft = {
      cwd: dir, root: checkout?.root ?? dir, ...(checkout ? { checkout } : {}), title: title?.trim() ?? '',
      ...(prompt ? { prompt } : {}), ...(parent ? { parent } : {}), ...(ref && loaded ? { profile: { ref, spec: loaded.spec } } : {}),
      // Its profile's, then what it was started with.
      options: { ...clone(loaded?.spec.options), ...clone(asked) },
    }
    const ext: Record<string, Json> = {}
    const meta = { ...(ref ? { profile: ref } : {}) } as ThreadMeta
    // A first message no model could answer: refused before anything is made, rather than leaving an empty thread.
    if ((prompt?.trim() || attachments?.length) && !kind && !(await extensions.agentOf(undefined, { ...meta, ...(ownModel ? { model: ownModel } : {}) })).model) {
      throw new RpcError('no_model', 'No model is available', { hint: 'Sign in to a provider in Settings.' })
    }
    const off = extensions.switchedOff(loaded)
    // The hooks that took part, to undo what they did (`abandoned`, in reverse) if the thread isn't made after all.
    const took: ReturnType<typeof extensions.hooksFor> = []
    let id: string
    try {
      for (const hook of extensions.hooksFor(off, meta)) {
        if (!hook.value.starting) continue
        let made: ThreadStarting | void
        try {
          made = await hook.value.starting(clone(draft))
        } catch (error) {
          throw refusal(hook.owner, error)
        }
        took.push(hook)
        if (made?.cwd) draft.cwd = made.cwd
        if (made?.state !== undefined) ext[hook.owner] = clone(made.state)
      }
      id = await createThread({
        title: draft.title, cwd: draft.cwd, createdAt: Date.now(), root: draft.root, ...(Object.keys(ext).length ? { ext } : {}),
        ...(ownModel ? { model: ownModel } : {}), ...(thinking ? { thinking } : {}), ...(ref ? { profile: ref } : {}), ...(kind ? { agent: kind } : {}), ...(parent ? { parent } : {}),
        ...(hidden ? { hidden: true, owner: hidden } : {}),
      })
    } catch (error) {
      for (const hook of took.reverse()) {
        try {
          await hook.value.abandoned?.(clone(draft), clone(ext[hook.owner]))
        } catch (undoing) {
          console.error(`Extension ${hook.owner}: abandoned failed:`, undoing)
        }
      }
      throw error
    }
    // From its parent, when one starts it, or the thread whose agent's shell asked.
    const sender = parent ?? from
    if (prompt?.trim() || attachments?.length) await submit(id, prompt ?? '', randomUUID(), undefined, attachments, { by, exposure, ...(sender ? { from: sender } : {}) })
    return info(id, await get(id))
  }
  /** A new thread with `meta`: its id, once extensions were told it's there (`started`). */
  async function createThread(meta: ThreadMeta) {
    const { model, thinkingLevel } = await extensions.agentOf(undefined, meta)
    // Another kind of agent's thread has no model of Superego's: its runner answers.
    const runner = runnerOf(meta, new Set())
    const conversation = await harness.createConversation({
      ownership: { kind: 'ownerless' },
      agent: { ...(runner ? { runner } : model ? { model } : {}), ...(thinkingLevel && !runner ? { thinkingLevel } : {}), cwd: meta.cwd },
      init: async (tx, created) => {
        Object.assign(await tx.doc(ThreadDoc, created), meta)
        ;(await tx.doc(Catalog)).ids.push(created)
      },
    }, context)
    await mount(conversation.id)
    changed()
    await tell('started', String(conversation.id))
    return String(conversation.id)
  }
  /**
   * Start a thread over (`threads.clear`): stopped, then a new context, so the model sees nothing before it, and the
   * transcript starts after it. Windows showing it watch again, from there: a watch that ends `stopped` is watched again.
   */
  async function clear(id: string) {
    const m = await get(id)
    await m.conversation.abort(context)
    await m.conversation.reset(undefined, context)
    await m.conversation.waitForIdle(context)
    const last = (await m.conversation.entries({ order: 'descending' }, 1, undefined, context)).items[0]?.id
    let closed: Pane[] = []
    await updateMeta(id, (meta) => {
      meta.cleared = Number(last ?? 0) + 1
      meta.seen = last === undefined ? {} : { entryId: Number(last) }
      closed = clone(meta.panes ?? [])
      delete meta.panes
      delete meta.pane
    })
    for (const stop of transcriptWatches.get(id) ?? []) void stop()
    await tellPaneClosed(id, closed)
  }
  /**
   * Put a thread away, unless an extension's `archiving` refuses; then its `archived` hooks clean up (a worktree, say).
   * Says what the extensions did, each in a line of its own (`notes`).
   */
  async function archive(id: string): Promise<{ notes: ArchiveNotes }> {
    const notes: ArchiveNotes = {}
    // Already away: nothing for the hooks to see.
    if (!(await get(id)).meta.archived) {
      await withProfile(id)
      await ask('archiving', id, notes)
      // Cleaned up before clients see it archived: never shown put away with its worktree still there.
      await tell('archived', id, { archived: true }, notes)
      await updateMeta(id, (m) => { m.archived = true; delete m.archiveWhenDone })
    }
    return { notes }
  }
  /** Bring a thread back, unless an extension's `unarchiving` refuses (or can't put back its worktree). */
  async function unarchive(id: string) {
    if (!(await get(id)).meta.archived) return
    await withProfile(id)
    const asked = await ask('unarchiving', id)
    try {
      await updateMeta(id, (m) => { delete m.archived; delete m.archiveWhenDone })
    } catch (error) {
      await abandonUnarchive(id, asked)
      throw error
    }
    await tell('unarchived', id)
  }
  /**
   * Archive a thread once its run ends: how a thread archives itself, mid-turn, without its worktree going from under
   * the turn or the turn being cut short. Kept in its metadata, so a restart in between still archives it.
   */
  async function archiveWhenDone(id: string) {
    await updateMeta(id, (m) => { m.archiveWhenDone = true })
    archiveIfDone(id, await get(id))
  }
  function archiveIfDone(id: string, m: Mounted) {
    if (!m.meta.archiveWhenDone || m.meta.archived || m.live?.run || archiving.has(id)) return
    archiving.add(id)
    // What it did, or that it was refused (an extension's `archiving`) or failed and given up: said in the thread, where
    // the agent said it would be archived. Its turn is over, so there's no one else to tell.
    void archive(id).then(async ({ notes }) => {
      const said = Object.values(notes)
      if (said.length) await note(id, `Archived. ${said.join(' ')}`)
    }, async (error) => {
      await updateMeta(id, (meta) => { delete meta.archiveWhenDone })
      await note(id, `Couldn't archive this thread: ${error instanceof Error ? error.message : String(error)}`)
    }).catch((error) => console.error(`Couldn't archive thread ${id}:`, error)).finally(() => archiving.delete(id))
  }
  /**
   * Stop a thread (`thread.stop`): its run, and what waits its turn. The queue is taken out first, in one commit, so
   * none of it goes in meanwhile. The user's messages (a window's, the command line's: no `by` or `from`) come back,
   * in order, to be written again: they're the user's to send or not. Others' are withdrawn: said in the transcript,
   * and told to the extensions (`stopped`), so the sender hears it (thread-reports' report to a parent).
   */
  async function stop(id: string): Promise<{ returned: ReturnedMessage[] }> {
    const m = await get(id)
    const taken = await m.conversation.commit(async (tx) => {
      const items = (await tx.doc(InboxDoc, m.conversation.id)).items
      const inputs: InboxItem[] = []
      // Queued writes (a note) stay, to be placed as ever.
      for (let index = 0; index < items.length;) {
        const item = items[index]!
        if (item.mode === 'write') { index++; continue }
        inputs.push(clone(item))
        tx.settleSubmission(item.id, { status: 'unanswered', reason: 'aborted' })
        items.splice(index, 1)
      }
      return inputs
    }, context)
    await m.conversation.abort(context)
    const dir = attachmentsDir(options.dataDir, id)
    const returned: ReturnedMessage[] = []
    const withdrawn: MessageOrigin[] = []
    for (const item of taken) {
      if (item.mode === 'write') continue
      const origin = item.entry?.kind === MESSAGE_ENTRY ? originOf((item.entry.data ?? {}) as MessageOrigin) : undefined
      if (origin && !origin.by && !origin.from) {
        const content = item.content as ReturnedMessage['content']
        const { attachments, gone } = await attachmentsIn(dir, content)
        // Its images' pixels are in its attachments: not twice.
        const words = typeof content === 'string' ? content : content.map((block) => block.type === 'image' ? { type: 'image', mimeType: block.mimeType } : block)
        returned.push({ content: words, attachments, ...(gone.length ? { gone } : {}) })
      } else withdrawn.push(origin ?? {})
    }
    if (withdrawn.length) {
      await note(id, `Stopped: ${await withdrawnFrom(withdrawn)} withdrawn.`)
      tellLater('stopped', id, { withdrawn })
    }
    return { returned }
  }
  /** Who the messages withdrawn at a stop came from, as a transcript says it: "2 queued messages from Lead and 1 from …". */
  async function withdrawnFrom(withdrawn: MessageOrigin[]) {
    const counts = new Map<string, number>()
    for (const { by, from } of withdrawn) {
      // A thread gone since is named by its id.
      const sender = from ? await get(from).then((m) => info(from, m).title, () => `thread ${from}`) : by ? `the ${by} extension` : 'Superego'
      counts.set(sender, (counts.get(sender) ?? 0) + 1)
    }
    const parts = [...counts].map(([sender, n], index) => `${n}${index ? '' : ` queued message${n === 1 ? '' : 's'}`} from ${sender}`)
    return parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}` : parts[0]!
  }
  /** A line in a thread's transcript from Superego itself, not the agent's (`superego.note`): for the user, not the model. */
  async function note(id: string, text: string) {
    await (await get(id)).conversation.submit({ type: 'write', entry: { kind: NOTE_ENTRY, data: { text } } }, context)
  }
  /**
   * An extension's notice in a thread (`threads.notice`): a note that says whose it is, and, unless `agent` is false,
   * tells the agent of it (`agent`, else its text) as a user-role message nobody sent: placed at once when the thread is
   * idle, else where its run can next take it (between tool calls, or as it ends). It starts no run, and, as the
   * thread's newest entry, makes it done (unread) with the notice's text for what it says.
   */
  async function notice(id: string, by: { name: string; title: string }, { agent, ...said }: NoticeInput) {
    if (!said.text.trim()) throw new RpcError('invalid', 'A notice needs text')
    const m = await get(id)
    if (m.meta.archived) throw new RpcError('archived', 'This thread is archived', { hint: 'Unarchive it to tell it something.' })
    const data: Note = { ...said, by: by.name }
    const told = agent === false ? undefined : (agent ?? said.text).trim()
    const model: UserMessage[] | undefined = told ? [{ role: 'user', content: [{ type: 'text', text: noticeForAgent(by.title, told) }], timestamp: Date.now() }] : undefined
    await m.conversation.submit({ type: 'write', entry: { kind: NOTE_ENTRY, data: clone(data) as Json, ...(model ? { model } : {}) } }, context)
  }

  /** Whether a thread has a conversation: a message, to or from its agent, since it was last started over. */
  async function conversed(id: string) {
    const m = await get(id)
    let cursor: Cursor | undefined
    do {
      const page = await m.conversation.entries({ order: 'descending', minEntryId: (m.meta.cleared ?? 0) as EntryId }, 200, cursor, context)
      if (page.items.some((entry) => entry.model?.length)) return true
      cursor = page.next
    } while (cursor)
    return false
  }

  /**
   * Run a thread with another profile from its next turn (none: the folder's default, else none). Another kind of agent
   * (one profile's Claude Agent, the other's Superego's own) only while the thread has no conversation: the two keep
   * different histories. Its own model goes with its kind.
   */
  async function setProfile(id: string, name: string | undefined) {
    const m = await get(id)
    if (m.meta.owner) throw new RpcError('invalid', `This thread is the ${m.meta.owner} extension's: it runs as that extension makes it`)
    if (m.live?.run) throw new RpcError('busy', 'This thread is working', { hint: 'Change its profile once it finishes.' })
    const ref = findProfile(m.meta.cwd, profileSources.roots(), name)
    // Checked (and allowed) now, as a new thread's is: a thread isn't left with one it can't run.
    const loaded = ref ? await profiles.profileOf(ref) : undefined
    const kind = typeof loaded?.spec.agent === 'string' && loaded.spec.agent ? loaded.spec.agent : undefined
    const was = m.meta.profile
    if (was?.dir === ref?.dir) return ref ?? null
    const moving = kind !== m.meta.agent
    if (moving) {
      if (kind && !extensions.runnerOf(kind, new Set())) throw new RpcError('invalid', `Profile ${ref!.name} runs on ${kind}, which isn't here`, { hint: `Turn on the extension that has ${kind} in Settings.` })
      if (await conversed(id)) {
        throw new RpcError('invalid', `This thread runs on ${extensions.kindTitle(m.meta.agent)}, and ${ref ? `the ${ref.name} profile` : 'no profile'} on ${extensions.kindTitle(kind)}: a thread can't move between them once it has a conversation, as each keeps its own`, {
          hint: `Start a new thread with ${ref ? `the ${ref.name} profile` : 'no profile'}.`,
        })
      }
    }
    await updateMeta(id, (meta) => {
      if (ref) meta.profile = ref; else delete meta.profile
      if (kind === meta.agent) return
      if (kind) meta.agent = kind; else delete meta.agent
      delete meta.model
      delete meta.thinking
    })
    if (was) letGoOf(was)
    const on = moving ? `, on ${extensions.kindTitle(kind)}` : ''
    await note(id, ref ? `This thread runs the ${ref.name} profile now (${ref.scope === 'user' ? 'yours' : "the project's"}, at ${shortPath(ref.dir)})${on}.` : `This thread runs without a profile now${on}.`)
    return ref ?? null
  }

  /** Older entries than a watch's window holds: the page before `before`, oldest first, and whether there are more. */
  async function history(id: string, before: number, limit = 50) {
    const m = await get(id)
    const page = await m.conversation.entries({ maxEntryId: (before - 1) as EntryId, order: 'descending' }, Math.min(Math.max(1, limit), 200), undefined, context)
    // A cleared thread's history starts where it was cleared.
    const start = m.meta.cleared ?? 0
    const entries = [...page.items].reverse().filter((e) => Number(e.id) >= start)
    return { entries: withoutPixels(entries), more: page.next !== undefined && entries.length === page.items.length }
  }

  /** An image block of an entry of a thread's transcript (its `model`'s `message`th message, its `block`th block). */
  async function imageBlock(id: string, entryId: number, message: number, block: number) {
    const m = await get(id)
    const { items: [entry] } = await m.conversation.entries({ minEntryId: entryId as EntryId, maxEntryId: entryId as EntryId }, 1, undefined, context)
    const content = (entry?.model?.[message] as { content?: unknown } | undefined)?.content
    const found = Array.isArray(content) ? content[block] as { type?: unknown; data?: unknown; mimeType?: unknown } | undefined : undefined
    return found?.type === 'image' && typeof found.data === 'string' && typeof found.mimeType === 'string' ? { data: found.data, mimeType: found.mimeType } : undefined
  }

  /**
   * A thread's transcript from where it was last cleared, then `ops` with each change until `stop`, or until it ends
   * (`ended`: the thread cleared, say, when a client watches again).
   */
  async function watchTranscript(id: string, ops: (ops: unknown[]) => void, ended: (reason: string) => void) {
    const m = await get(id)
    const from = m.meta.cleared
    const watch = await m.conversation.watch(context, from !== undefined ? { from: from as EntryId } : undefined)
    const stop = () => watch.stop()
    const watches = transcriptWatches.get(id) ?? new Set()
    transcriptWatches.set(id, watches.add(stop))
    // Its images without their pixels: a window reads those as it shows them (window-images.ts).
    watch.start(async (call) => { if (call.kind === 'value') ops(opsWithoutPixels(call.ops as unknown[])) })
    void watch.closed.then((end) => {
      watches.delete(stop)
      ended(end.kind)
    })
    // Nothing before where it was cleared: no earlier entries to page back to.
    const { before, ...rest } = watch.value
    return { value: withoutPixels(from !== undefined && Number(before ?? from) < from ? rest : watch.value), stop }
  }

  /** The threads as an extension reaches them (`superego.threads`), as `owner`. */
  function apiFor(owner: string, title = owner): DaemonApi['threads'] {
    return {
      list: (options) => list(options),
      get: async (id) => info(id, await get(id)),
      conversation: async (id) => (await get(id)).conversation,
      of: (conversationId) => threadOf(conversationId),
      attachments: (id) => attachmentsDir(options.dataDir, id),
      // An extension's attachments are inline: it has no connection to upload on.
      start: ({ hidden, ...params }) => startThread({ ...params as ThreadStart, ...(hidden ? { hidden: owner } : {}), by: owner }),
      async send(id, text, { whenBusy = 'followUp', exposure, from } = {}) { await submit(id, text, randomUUID(), whenBusy, [], { by: owner, exposure, from }) },
      notice: (id, said) => notice(id, { name: owner, title }, said),
      answering: (conversationId, callId) => answering(conversationId, callId),
      noteRead: (reader, read) => noteRead(reader, read),
      parentRead: (thread) => (readAt.get(thread.id) ?? -1) >= thread.activeAt,
      lastAnswer: (id) => answerOf(id),
      idle: (id, { signal } = {}) => idle(id, signal),
      entries: (id, limit = 20) => newest(id, limit),
      async archive(id, { whenIdle = false } = {}) {
        if (!whenIdle) return archive(id)
        await archiveWhenDone(id)
        return { notes: {} }
      },
      async unarchive(id) { await unarchive(id) },
      clear: (id) => clear(id),
    }
  }

  return {
    list, get, updateMeta, editState, heedStatus, rebound, letGoOf, note, setProfile, tellPaneClosed, submit, compact, retry, handoff, stop, startThread, archive, unarchive, openPane, history, lastAnswer: answerOf, read,
    watchTranscript, imageBlock, apiFor, retrySignIn, rejectedNow, learnConversations, threadOf,
  }
}

export type Threads = ReturnType<typeof createThreads>
