// The core's own actions: starting threads and what's done with one (send, stop, archive, its panes, its profile), and
// this machine's (settings, sign-in, a restart, a machine it reaches). Extensions' are theirs (`superego.action`).
import { randomUUID } from 'node:crypto'
import type { ConversationId, Harness, SubmissionId } from '@earendil-works/pi-durable'
import { InboxDoc } from '@earendil-works/pi-durable'
import { arr, bool, int, lit, num, obj, opt, RpcError, str, union, unknown, type Json, type MachineInfo, type Pane } from '@superego/protocol'
import { ATTACHMENT } from './attachments.ts'
import { defineAction } from './extension.ts'
import type { threadFiles } from './files.ts'
import { clone, context, type DaemonContext, type Host, type ThreadMeta } from './host.ts'
import type { Relay } from './relay.ts'
import { paneParams, type Threads, type ThreadStart } from './threads.ts'

/** The setting that lets outside agents (`superego mcp`) start threads here. Off unless turned on. */
export const OUTSIDE_THREADS = 'outside.startThreads'

export function registerCoreActions(host: Host, { harness, machine, threads, files, relay }: {
  harness: Harness; machine: MachineInfo; threads: Threads; files: ReturnType<typeof threadFiles>; relay: Relay
}) {
  const { options, settings, router, agent, mounted } = host
  /** What a thread action takes: the thread it's for, which the window passes as the one it shows. */
  const thread = { thread: true as const }
  // Outside agents (`superego mcp`) start threads only once this machine lets them: the tool isn't listed until then,
  // and refused if called anyway.
  settings.register({
    id: 'outside', title: 'Outside agents', order: 82,
    description: `Agents using this machine through ${options.app.id} mcp.`,
    settings: [{
      key: OUTSIDE_THREADS, title: 'Can start threads', default: false, type: { type: 'boolean' }, consent: true,
      description: "A thread one starts is like any other here: it has its profile's MCP servers, or those for threads without a profile.",
    }],
  })
  /** Whether outside agents may start threads here now: of what's exposed to them, the one thing a setting holds back. */
  const outsideMayStart = () => settings.get(OUTSIDE_THREADS) === true
  router.register(defineAction({
    id: 'thread.start', title: 'Start a thread (no dialog)', expose: ['ui', 'cli', 'outside'],
    description: 'Start a thread: an agent working in `cwd` (default: the machine\'s), with `prompt` as its first message. Its id comes back; thread.send sends it more.',
    params: obj({
      cwd: opt(str()), title: opt(str()), model: opt(str()), thinking: opt(str()), prompt: opt(str()), attachments: opt(arr(ATTACHMENT)), profile: opt(str()),
      parent: opt(str()), options: opt(obj({}, { open: true })),
    }),
    run(params, { exposure, from }) {
      if (exposure === 'outside' && !outsideMayStart()) {
        throw new RpcError('not_allowed', "Outside agents can't start threads on this machine", { hint: 'Turn on Settings → Outside agents → Can start threads.' })
      }
      return threads.startThread({ ...params as ThreadStart, ...(exposure ? { exposure } : {}), ...(from ? { from } : {}) })
    },
  }))
  router.register(defineAction({
    id: 'thread.send', title: 'Send a message', expose: ['ui', 'cli', 'outside'], ...thread,
    description: 'Send a thread a message. While it works, `whenBusy` says how: `steer` (now) or `followUp` (after this turn).',
    params: obj({ thread: str(), text: str(), attachments: opt(arr(ATTACHMENT)), requestId: opt(str()), whenBusy: opt(union([lit('steer'), lit('followUp')])) }),
    run: async ({ thread: id, text, attachments, requestId, whenBusy }, { exposure, from }) => ({
      submission: await threads.submit(id, text, requestId ?? randomUUID(), whenBusy, attachments, { ...(exposure ? { exposure } : {}), ...(from ? { from } : {}) }),
    }),
  }))
  router.register(defineAction({
    id: 'thread.compact', title: 'Compact conversation', expose: ['ui', 'cli'], ...thread,
    description: 'Summarize what came before the newest stretch of a thread\'s conversation, to free its context; `instructions` say what the summary should keep. Answers once it\'s done (`compacted`), or with the message that asked another kind of agent to (`submission`).',
    params: obj({ thread: str(), instructions: opt(str()) }),
    run: ({ thread: id, instructions }) => threads.compact(id, instructions),
  }))
  router.register(defineAction({
    id: 'thread.retry', title: 'Retry the failed turn', expose: ['ui', 'cli', 'outside'], ...thread,
    description: 'Run a thread\'s failed turn again. For one stuck on a request too large for its provider (`failure.kind`: `too_large`), or failing the same way again: `lean` sends it without its older images and with its old tool output cut short, from now on; `compact` summarizes what came before its newest stretch first.',
    params: obj({ thread: str(), lean: opt(bool()), compact: opt(bool()) }),
    run: ({ thread: id, lean, compact }) => threads.retry(id, { ...(lean !== undefined ? { lean } : {}), ...(compact !== undefined ? { compact } : {}) }),
  }))
  router.register(defineAction({
    id: 'thread.handoff', title: 'Start a fresh thread from this one', expose: ['ui', 'cli', 'outside'], ...thread,
    description: 'Continue a thread that can\'t go on (its request too large for its provider, say) in a fresh one: same folder, profile, model and parent, starting from a handoff its model writes (goal, what\'s done, decisions, what\'s open). The old thread links to it; its children move to it. Answers with the new `thread`.',
    params: obj({ thread: str() }),
    run: ({ thread: id }) => threads.handoff(id),
  }))
  router.register(defineAction({
    id: 'thread.stop', title: 'Stop the agent', expose: ['ui', 'cli', 'outside'], ...thread,
    description: 'Stop a thread\'s agent mid-turn, and the messages waiting their turn. The thread stays, and takes messages again. `returned`: the user\'s own waiting messages (none of another thread\'s or an extension\'s, which are withdrawn), in order, to write again: each its `content` and `attachments`.',
    params: obj({ thread: str() }),
    run: ({ thread: id }) => threads.stop(id),
  }))
  router.register(defineAction({
    id: 'thread.withdraw', title: 'Take back a message waiting its turn', expose: ['ui', 'cli'], ...thread,
    params: obj({ thread: str(), submission: str() }),
    // Gone in already (or settled), it stays: only what still waits can be taken back.
    async run({ thread: id, submission }) {
      await threads.get(id)
      await harness.abortSubmission(Number(submission) as SubmissionId, context, Number(id) as ConversationId)
      return null
    },
  }))
  router.register(defineAction({
    id: 'thread.steer', title: 'Send a waiting message now', expose: ['ui', 'cli'], ...thread,
    description: 'Send a follow-up waiting for the agent to finish now: it becomes a steer, going in after the current step. The agent isn\'t stopped. `status`: `steers`, or what became of it first (`placed`: gone in already; `settled`: taken back or done).',
    params: obj({ thread: str(), submission: str() }),
    async run({ thread: id, submission }) {
      const m = await threads.get(id)
      const sid = Number(submission) as SubmissionId
      if (!Number.isInteger(sid)) throw new RpcError('invalid', `No message ${submission} in this thread`)
      // The same item, its place in the queue and all, now a steer: in one commit, so it can't be placed meanwhile.
      // What isn't in the inbox has gone in, or been taken back, already.
      const steers = await m.conversation.commit(async (tx) => {
        const item = (await tx.doc(InboxDoc, m.conversation.id)).items.find((i) => i.id === sid)
        if (!item || item.mode === 'write') return false
        item.mode = 'steer'
        return true
      }, context)
      if (steers) return { status: 'steers' as const }
      const record = await (await harness.submission(sid, context))?.status(context)
      if (!record || record.conversationId !== m.conversation.id) throw new RpcError('not_found', `No message ${submission} in this thread`)
      return { status: record.status === 'placed' ? 'placed' as const : 'settled' as const }
    },
  }))
  router.register(defineAction({
    id: 'thread.archive', title: 'Archive the thread', expose: ['ui', 'cli', 'outside'], keys: 'mod+shift+e', ...thread,
    params: obj({ thread: str() }),
    async run({ thread: id }) {
      return await threads.archive(id)
    },
  }))
  router.register(defineAction({
    id: 'thread.unarchive', title: 'Unarchive the thread', expose: ['ui', 'cli', 'outside'], ...thread,
    params: obj({ thread: str() }),
    async run({ thread: id }) { await threads.unarchive(id); return null },
  }))
  router.register(defineAction({
    id: 'pane.open', title: 'Open a pane', expose: ['ui', 'cli', 'outside'], ...thread,
    // `by: 'agent'`: what it shows is the agent's choice, though the user asked for it (an agent's `open` block).
    params: obj({ thread: str(), kind: str({ minLength: 1 }), title: opt(str()), params: opt(unknown()), by: opt(lit('agent')) }),
    run: ({ thread: id, kind, title, params, by }) => threads.openPane(id, { kind, ...(title ? { title } : {}), ...(params !== undefined ? { params: params as Json } : {}), ...(by ? { by } : {}) }),
  }))
  router.register(defineAction({
    id: 'pane.update', title: 'Change what a pane shows', expose: ['ui', 'cli'], ...thread,
    params: obj({ thread: str(), pane: str(), title: opt(str()), params: opt(unknown()) }),
    async run({ thread: id, pane, title, params }) {
      await threads.get(id)
      let found = false
      await threads.updateMeta(id, (meta) => {
        const target = meta.panes?.find((p) => p.id === pane)
        if (!target) return
        found = true
        // What it shows is the user's now (Pane's `by`).
        if (params !== undefined) {
          target.params = paneParams(params)
          delete target.by
        }
        if (title !== undefined) target.title = title || undefined
        else delete target.title
      })
      if (!found) throw new RpcError('not_found', `No pane ${pane}`)
      return null
    },
  }))
  router.register(defineAction({
    id: 'pane.close', title: 'Close a pane', expose: ['ui', 'cli'], ...thread,
    params: obj({ thread: str(), pane: str() }),
    async run({ thread: id, pane }) {
      await threads.get(id)
      let closed: Pane | undefined
      await threads.updateMeta(id, (meta) => {
        const index = (meta.panes ?? []).findIndex((p) => p.id === pane)
        if (index < 0) return
        // A plain copy: what the transaction hands over is only valid inside it.
        closed = clone(meta.panes![index])
        meta.panes!.splice(index, 1)
        // The focus moves left: to the pane before it, or (it was the first) the thread.
        if (meta.pane === pane) meta.pane = meta.panes![index - 1]?.id
        if (!meta.pane) delete meta.pane
        if (!meta.panes!.length) delete meta.panes
      })
      if (closed) await threads.tellPaneClosed(id, [closed])
      return null
    },
  }))
  router.register(defineAction({
    id: 'pane.move', title: 'Move a pane', expose: ['ui', 'cli'], ...thread,
    description: "Move a pane to another place beside the thread: `to` is its place among the thread's panes, 0 first (past the end, last). The thread stays before them all.",
    params: obj({ thread: str(), pane: str(), to: int({ minimum: 0 }) }),
    async run({ thread: id, pane, to }) {
      await threads.get(id)
      let found = false
      await threads.updateMeta(id, (meta) => {
        const panes = meta.panes ?? []
        const from = panes.findIndex((p) => p.id === pane)
        if (from < 0) return
        found = true
        const at = Math.min(to, panes.length - 1)
        if (at === from) return
        // A plain copy: what the transaction hands over is only valid inside it.
        const moved = clone(panes[from]!)
        panes.splice(from, 1)
        panes.splice(at, 0, moved)
      })
      if (!found) throw new RpcError('not_found', `No pane ${pane}`)
      return null
    },
  }))
  router.register(defineAction({
    id: 'pane.resize', title: 'Resize a pane', expose: ['ui', 'cli'], ...thread,
    description: "Set how wide the thread's own column (no `pane`) or a pane's is, as a factor of the window's width (0.42): the same proportion in any window. `last`: its width while it's the last column (the thread with no panes); left as it is, that one takes the room the others leave. No `width`: back to its default.",
    params: obj({ thread: str(), pane: opt(str()), width: opt(num({ exclusiveMinimum: 0, maximum: 1 })), last: opt(bool()) }),
    async run({ thread: id, pane, width, last }) {
      let found = !pane
      await threads.updateMeta(id, (meta) => {
        const target = pane ? meta.panes?.find((p) => p.id === pane) : meta
        if (!target) return
        found = true
        const key = last ? 'lastWidth' : 'width'
        if (width === undefined) delete target[key]
        else target[key] = width
      })
      if (!found) throw new RpcError('not_found', `No pane ${pane}`)
      return null
    },
  }))
  router.register(defineAction({
    id: 'pane.focus', title: 'Bring a pane to the front', expose: ['ui', 'cli'], ...thread,
    params: obj({ thread: str(), pane: opt(str()) }),
    async run({ thread: id, pane }) {
      await threads.get(id)
      await threads.updateMeta(id, (meta) => { if (pane && meta.panes?.some((p) => p.id === pane)) meta.pane = pane; else delete meta.pane })
      return null
    },
  }))
  router.register(defineAction({
    id: 'file.write', title: 'Save a file', expose: ['ui', 'cli'], ...thread,
    params: obj({ thread: str(), path: str({ minLength: 1 }), content: str() }),
    async run({ thread: id, path, content }) { return { path: await files.write(id, path, content) } },
  }))
  router.register(defineAction({
    id: 'file.create', title: 'New file', expose: ['ui', 'cli'], ...thread,
    description: "Create an empty file (a folder, with `folder`) at `path`, as file.write takes it, and the folders on the way. Refused when something's already there: it never overwrites.",
    params: obj({ thread: str(), path: str({ minLength: 1 }), folder: opt(bool()) }),
    async run({ thread: id, path, folder }) { return { path: await files.create(id, path, folder) } },
  }))
  router.register(defineAction({
    id: 'thread.rename', title: 'Rename the thread', expose: ['ui', 'cli', 'outside'], ...thread,
    params: obj({ thread: str(), title: str({ minLength: 1 }) }),
    async run({ thread: id, title }) { await threads.updateMeta(id, (meta) => { meta.title = title }); return null },
  }))
  router.register(defineAction({
    id: 'thread.setProfile', title: "Change the thread's profile", expose: ['ui', 'cli'], ...thread,
    description: "Run the thread with another profile from its next turn: `profile` by name, as profile.list gives them for its folder; none, the default (if there's none of those, plain Superego). Refused while it runs, for a project's profile not allowed yet (profile.allow), and for one on another kind of agent (Claude Agent's, say) once the thread has a conversation: a thread keeps its kind for its whole life.",
    params: obj({ thread: str(), profile: opt(str()) }),
    run: ({ thread: id, profile: name }) => threads.setProfile(id, name?.trim() || undefined),
  }))
  router.register(defineAction({
    id: 'thread.seen', title: 'Mark as seen', expose: ['ui', 'cli'], ...thread,
    params: obj({ thread: str() }),
    async run({ thread: id }) {
      const m = await threads.get(id)
      const seen: NonNullable<ThreadMeta['seen']> = {}
      if (m.lastEntryId !== undefined) seen.entryId = m.lastEntryId
      if (m.live?.runFailure) seen.failureTaskId = m.live.runFailure.taskId
      await threads.updateMeta(id, (meta) => { meta.seen = seen })
      return null
    },
  }))
  router.register(defineAction({
    id: 'settings.set', title: 'Change a setting', expose: ['ui', 'cli'],
    params: obj({ key: str(), value: unknown() }),
    // A secret given here by mistake is refused (secrets.set sets one), and never logged.
    secretIn: (params) => settings.isSecret(String((params as { key?: unknown } | null)?.key)) ? ['value'] : [],
    consentIn: ({ key }) => { const spec = settings.spec(key); return spec?.consent ? spec.title : undefined },
    async run({ key, value }) {
      await settings.set(key, value as Json)
      return null
    },
  }))
  // A secret's value only the user gives, in a window or their own terminal: an agent's shell is refused (`consent`),
  // and the log keeps `•••` for it. Clients never read it back: a snapshot says only whether it's set.
  router.register(defineAction({
    id: 'secrets.set', title: 'Set a secret', expose: ['ui', 'cli'], consent: true, secret: ['value'],
    description: 'Set a secret setting (an extension\'s key or token) to `value`, or clear it with `value: null`. Kept in the OS keychain where there is one, else encrypted in the data folder.',
    params: obj({ key: str(), value: union([str(), lit(null)]) }),
    async run({ key, value }) {
      await settings.setSecret(key, value)
      return null
    },
  }))
  router.register(defineAction({
    id: 'auth.signIn', title: 'Sign in to a provider', expose: ['ui', 'cli'], secret: ['key'],
    params: obj({ provider: str(), type: union([lit('api_key'), lit('oauth')]), key: opt(str()), check: opt(bool()), domain: opt(str()) }),
    run({ provider, type, key, check, domain }, ctx: DaemonContext) {
      const flow: string = agent.login(provider, type, (event) => ctx.notify('auth.event', { flow, event }), {
        ...(key !== undefined ? { key } : {}), ...(check ? { check } : {}), ...(domain !== undefined ? { domain } : {}),
      })
      return { flow }
    },
  }))
  router.register(defineAction({
    id: 'auth.retry', title: 'Retry the threads waiting for sign-in', expose: ['ui', 'cli'],
    params: obj({ provider: opt(str()) }),
    async run({ provider }) { return { retried: await threads.retrySignIn(provider) } },
  }))
  router.register(defineAction({
    id: 'auth.respond', title: 'Answer a sign-in step', runs: 'machine', secret: ['value'],
    params: obj({ flow: str(), prompt: str(), value: str() }),
    run({ flow, prompt, value }) { host.flows.respond(flow, prompt, value); return null },
  }))
  router.register(defineAction({
    id: 'auth.cancel', title: 'Cancel a sign-in', runs: 'machine',
    params: obj({ flow: str() }),
    run({ flow }) { host.flows.cancel(flow); return null },
  }))
  router.register(defineAction({
    id: 'auth.signOut', title: 'Sign out of a provider', expose: ['ui', 'cli'],
    params: obj({ provider: str() }),
    async run({ provider }) { await agent.logout(provider); return null },
  }))
  router.register(defineAction({
    id: 'providers.save', title: 'Add or change a provider', expose: ['ui', 'cli'], secret: ['key'],
    description: 'An OpenAI-compatible endpoint, by its base URL: its models are those it lists, unless given.',
    params: obj({ id: opt(str()), name: str(), baseUrl: str(), key: opt(union([str(), lit(null)])), models: opt(arr(str())) }),
    async run(input) { return { id: await agent.saveProvider(input) } },
  }))
  router.register(defineAction({
    id: 'providers.remove', title: 'Remove a provider you added', expose: ['ui', 'cli'],
    params: obj({ provider: str() }),
    async run({ provider }) { await agent.removeProvider(provider); return null },
  }))
  router.register(defineAction({
    id: 'providers.models', title: "List an endpoint's models", runs: 'machine',
    params: obj({ baseUrl: str(), key: opt(str()), provider: opt(str()) }),
    async run({ baseUrl, key, provider }) { return { models: await agent.endpointModels(baseUrl, key, provider) } },
  }))
  router.register(defineAction({
    id: 'daemon.restart', title: 'Restart the daemon', expose: ['ui', 'cli'],
    params: obj({ build: str(), interrupt: opt(bool()), env: opt(unknown()) }),
    run({ build, interrupt, env }) {
      if (build !== machine.build) throw new RpcError('changed', 'The running daemon changed. Check again.')
      if (host.state.restarting) throw new RpcError('restarting', 'Already restarting')
      // Decided synchronously from the mounted threads, so no run can start between the check and the flag.
      const busy = [...mounted.values()].some((m) => m.live?.run)
      if (busy && !interrupt) return { restarted: false, busy }
      host.state.restarting = true
      const vars = Object.fromEntries(Object.entries(env && typeof env === 'object' ? env : {}).filter((e): e is [string, string] => typeof e[1] === 'string'))
      setImmediate(() => options.onRestart?.(vars))
      return { restarted: true, busy }
    },
  }))
  router.register(defineAction({
    id: 'machine.reconnect', title: 'Reconnect a machine', expose: ['ui', 'cli'],
    description: 'Drop the link to a machine this one reaches and connect again, as after logging in there.',
    params: obj({ id: str() }),
    run({ id }) { relay.reconnect(id); return null },
  }))
  return { outsideMayStart }
}
