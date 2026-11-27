// processes, daemon half: long-running commands a thread (or a folder, or the machine) owns, run so they outlive the
// daemon (runner.ts), with the agent's process_* tools, actions and reads for the window and other extensions (Run,
// Schedules), live values for the pane and the chip, a mark's facts, reports back to the thread when one ends, and
// their lifetime: a thread's own stopped as it's archived, a folder's as its last thread goes, all of them as
// Processes is switched off; what ended removed after a week.
import { defineExtension, defineTool, section } from '@earendil-works/pi-durable'
import { bool, int, lit, map, obj, oneOf, opt, str, union } from '@earendil-works/pi-schema'
import { defineAction, defineDaemonExtension, type DaemonApi, type ThreadNotice } from '@superego/daemon'
import { RpcError, type ThreadInfo } from '@superego/protocol'
import { isAbsolute, resolve } from 'node:path'
import { matcher, READ_AT_MOST, tail } from './log.ts'
import { reporter, BATCHING, type Batching } from './reports.ts'
import { checkKept, EMPTY, Runner, type Kept, type ProcessRecord, type ProcessSpec } from './runner.ts'
import {
  about, ended, endedHow, LIST, linkTo, live, OUTPUT, PANE, READ, REPORT, span, titleOf, TROUBLE,
  type OutputMark, type ReportData, type OutputSlice, type Owner, type ProcessFacts, type ProcessInfo,
} from './shared.ts'

/** What ended is removed after this long. */
export const KEEP_ENDED = 7 * 24 * 3600_000
/** How many lines of output a report and a waited start carry. */
const REPORT_LINES = 20
const OUTPUT_EVERY = 100
/** The longest a tool waits, in seconds. */
const MOST_WAIT = 600
/** Reports wake a thread's agent at most this many times an hour (within its wake budget); past it, they're told without waking it. */
export const WAKES = 5

/** What a process shows: its record less what stays on the machine. */
export function infoOf(record: ProcessRecord): ProcessInfo {
  const { env: _env, base: _base, start: _start, pidStart: _pidStart, createdAt: _createdAt, learnt: _learnt, ...info } = record
  return info
}

/** How a wait went. */
export type WaitOutcome = { outcome: 'matched' | 'ready' | 'exited' | 'timeout'; process: ProcessInfo; tail: string }

const ownerSchema = union([obj({ thread: str() }), obj({ folder: str() }), obj({ machine: lit(true) })])
const specFields = {
  owner: opt(ownerSchema),
  thread: opt(str({ description: 'the thread it belongs to (its owner), unless `owner` or `folder` says' })),
  folder: opt(str({ description: 'a folder it belongs to instead, shared by every thread there' })),
  name: opt(str({ description: 'a name unique among its owner’s processes' })),
  command: str({ minLength: 1, description: 'a shell command line' }),
  cwd: opt(str({ description: 'where it runs: the thread’s (or the folder) unless given' })),
  env: opt(map(str())),
  ready: opt(str({ description: 'text (or /regex/) in its output that marks it ready' })),
  grace: opt(int({ minimum: 0, description: 'ms between SIGTERM and SIGKILL as it stops (5000)' })),
  notify: opt(oneOf(['exit', 'failure', 'never'] as const)),
  restart: opt(oneOf(['never', 'on-failure'] as const)),
  keep: opt(bool({ description: 'started again after a restart of the machine, if it was running' })),
}
const targetFields = {
  id: opt(str({ description: 'the process' })),
  owner: opt(ownerSchema),
  thread: opt(str()),
  folder: opt(str()),
  name: opt(str({ description: 'with its owner, instead of its id' })),
}

/** The extension; `batching` and `shell` are for tests. */
export function processesExtension({ batching = BATCHING, shell }: { batching?: Batching; shell?: string } = {}) {
  return defineDaemonExtension({
    ...about,
    setup(superego) {
      const lists = superego.scopedValue<ProcessInfo[]>(LIST, [])
      const marks = superego.scopedValue<OutputMark>(OUTPUT, { end: 0, start: 0 })
      const trouble = superego.value<string | null>(TROUBLE, null)
      const fail = (message: string, error: unknown) => {
        console.error(`processes: ${message}:`, error)
        if (!superego.signal.aborted) trouble.set(`${message}: ${error instanceof Error ? error.message : String(error)}`)
      }

      // ── The threads, as last listed: whose folder is where, which continues which ─────────────────────────────────
      const threads = new Map<string, ThreadInfo>()
      const continues = new Map<string, string>()
      const know = (thread: ThreadInfo) => {
        if (thread.archived) threads.delete(thread.id)
        else threads.set(thread.id, thread)
        if (thread.continues) continues.set(thread.id, thread.continues)
      }
      const relist = async () => {
        const all = await superego.threads.list()
        threads.clear()
        for (const thread of all) know(thread)
        publish()
      }
      /** A thread and those it continues: their processes are its. */
      const lineOf = (id: string) => {
        const ids = [id]
        for (let at = continues.get(id); at && !ids.includes(at); at = continues.get(at)) ids.push(at)
        return ids
      }
      /** A thread's processes and its folder's: its own first, then by when each was made. */
      function listOf(id: string): ProcessRecord[] {
        const mine = new Set(lineOf(id))
        const cwd = threads.get(id)?.cwd
        return [...runner.records.values()]
          .filter((p) => ('thread' in p.owner && mine.has(p.owner.thread)) || ('folder' in p.owner && p.owner.folder === cwd))
          .sort((a, b) => Number('folder' in a.owner) - Number('folder' in b.owner) || a.createdAt - b.createdAt)
      }
      const factsOf = (id: string): ProcessFacts | undefined => {
        const list = listOf(id)
        const facts = {
          running: list.filter((p) => p.state === 'running' || p.state === 'stopping').length,
          starting: list.filter((p) => p.state === 'starting').length,
          failed: list.filter((p) => p.state === 'failed' && !p.seen).length,
        }
        return facts.running || facts.starting || facts.failed ? facts : undefined
      }

      // ── Publishing: each thread's list, its facts, each process's output mark ─────────────────────────────────────
      const published = new Map<string, string>()
      const facts = new Map<string, string>()
      function publish() {
        if (superego.signal.aborted) return
        let changedFacts = false
        for (const id of threads.keys()) {
          const list = listOf(id).map(infoOf)
          const text = JSON.stringify(list)
          if (published.get(id) !== text) { published.set(id, text); lists.set(id, list) }
          const now = JSON.stringify(factsOf(id) ?? null)
          if (facts.get(id) !== now) { facts.set(id, now); changedFacts = true }
        }
        if (changedFacts) superego.invalidate()
      }
      superego.facts(({ id }) => factsOf(id))

      const pendingMarks = new Map<string, OutputMark>()
      let markTimer: ReturnType<typeof setTimeout> | undefined
      const flushMarks = () => {
        markTimer = undefined
        if (superego.signal.aborted) return
        for (const [id, mark] of pendingMarks) marks.set(id, mark)
        pendingMarks.clear()
      }

      // What's wrong with processes.json (unread and kept aside, a save that failed) is said as its trouble too.
      let fileTrouble: string | undefined
      const store = superego.jsonFile<Kept>('processes.json', {
        empty: EMPTY, check: checkKept,
        trouble(message) {
          if (message) trouble.set(message)
          else if (fileTrouble && trouble.get() === fileTrouble) trouble.set(null)
          fileTrouble = message
        },
      })
      const runner = new Runner(superego.dir, store, {
        changed: (record, removed) => {
          if (removed) marks.delete(record.id)
          publish()
        },
        output: (record, mark) => {
          pendingMarks.set(record.id, mark)
          if (!markTimer && !superego.signal.aborted) markTimer = setTimeout(flushMarks, OUTPUT_EVERY)
        },
        ended: (record) => {
          const wake = record.notify === 'exit' || (record.notify === 'failure' && record.state === 'failed')
          if (!wake || record.state === 'lost') return
          const owner = record.owner
          if ('thread' in owner) reports.report(owner.thread, record.id)
          // A folder's (Run's): the thread working there is told.
          else if ('folder' in owner) {
            void workingIn(owner.folder).then((thread) => { if (thread) reports.report(thread, record.id) })
              .catch((error) => fail(`couldn't find whom to tell ${record.id} ended`, error))
          }
        },
        error: fail,
      }, shell ? { shell } : {})

      // ── Reports ─────────────────────────────────────────────────────────────────────────────────────────────────
      const running = new Set<string>()
      /** The thread working in `folder`: of those there (not archived, not continued elsewhere), the last active. */
      async function workingIn(folder: string): Promise<string | undefined> {
        const there = (await superego.threads.list()).filter((t) => t.cwd === folder && !t.archived && !t.continuedIn)
        return there.sort((a, b) => b.activeAt - a.activeAt)[0]?.id
      }
      /** A process's end as its thread is told it: a card for the user (`Report`), its Restart; the agent, how and its last lines. */
      async function report(id: string): Promise<ThreadNotice | undefined> {
        const record = runner.records.get(id)
        if (!record) return undefined
        const slice = await runner.logOf(record).read(record.start)
        const lines = tail(slice.text, REPORT_LINES).replace(/^\s*\n/, '')
        const how = endedHow(record)
        const away = record.whileAway ? ', while Superego was stopped' : ''
        const data: ReportData = { id, title: titleOf(record), how, failed: record.state === 'failed', tail: lines, ...(record.whileAway ? { whileAway: true } : {}) }
        return {
          text: `${linkTo(record)} ${how}${away}.`, kind: REPORT, data,
          agent: `From process ${linkTo(record)}: ${how}${away}.${lines ? `\n\`\`\`\n${lines.replace(/```/g, '`\u200b``')}\n\`\`\`\n(process_logs has the rest.)` : ''}`,
          actions: [{ label: 'Restart', action: 'processes.restart', params: { id } }],
        }
      }
      const reports = reporter({
        info: (id) => superego.threads.get(id).catch((error: { code?: string }) => {
          // Deleted meanwhile: nobody to tell.
          if (error.code === 'not_found') return undefined
          throw error
        }),
        busy: (thread) => running.has(thread.id) || thread.status.state === 'working',
        wanted: (id) => { const p = runner.records.get(id); return Boolean(p && !p.learnt && !live(p.state)) },
        // A notice each, the last waking the agent (its run takes them all), within the thread's wake budget: past it
        // (or `WAKES` an hour of Processes'), it's shown without waking it, saying so.
        async send(thread, ids) {
          const notices = (await Promise.all(ids.map(report))).filter((notice): notice is ThreadNotice => Boolean(notice))
          for (const [i, notice] of notices.entries()) {
            const last = i === notices.length - 1
            await superego.threads.notice(thread, { ...notice, ...(last ? { wake: { most: WAKES } } : {}) })
          }
          for (const id of ids) runner.learnt(id)
        },
        error: fail,
      }, batching)

      // The records kept, read and taken back before anything acts on them (an action, a read, a tool): a definition
      // put meanwhile would make a second of the same name, and a stop wouldn't find what to stop yet.
      const loaded = runner.load().then(({ rebuilt }) => {
        if (rebuilt !== undefined) trouble.set(`${fileTrouble ?? "processes.json didn't read."} Found ${rebuilt} process${rebuilt === 1 ? '' : 'es'} again from their folders.`)
      })
      const adopted = loaded.then(() => runner.adopt())
      // Unread (and said so, by `ready` below): what acts on them is refused, rather than losing track of what runs.
      const fromLoaded = loaded.then(
        // Taken back, or not (said by `ready`): either way, acting on them can go ahead.
        () => adopted.then(() => undefined, () => undefined),
        (error: Error) => { throw new RpcError('failed', `Processes couldn't read what it runs (${error.message}): see processes.json in ${superego.dir}.`) },
      )
      fromLoaded.catch(() => { /* each action waiting on it fails with it; the failure itself is said by `ready` */ })

      // ── Starting, finding, stopping ─────────────────────────────────────────────────────────────────────────────
      type SpecParams = { owner?: Owner; thread?: string; folder?: string; name?: string; command: string; cwd?: string; env?: Record<string, string>; ready?: string; grace?: number; notify?: ProcessInfo['notify']; restart?: ProcessInfo['restart']; keep?: boolean }
      const ownerOf = (p: { owner?: Owner; thread?: string; folder?: string }): Owner => {
        if (p.owner) return p.owner
        if (p.folder) return { folder: p.folder }
        if (p.thread) return { thread: p.thread }
        throw new RpcError('invalid', 'Say whose it is: `thread`, `folder` or `owner`.')
      }
      async function specOf(p: SpecParams, by: ProcessInfo['by']): Promise<ProcessSpec> {
        const owner = ownerOf(p)
        let base: string
        if ('folder' in owner) base = owner.folder
        else if ('thread' in owner) {
          const thread = await superego.threads.get(owner.thread)
          if (thread.archived) throw new RpcError('archived', `Thread ${owner.thread} is archived.`)
          base = thread.cwd
        } else base = superego.dataDir
        const cwd = p.cwd ? (isAbsolute(p.cwd) ? p.cwd : resolve(base, p.cwd)) : base
        return {
          owner, command: p.command, cwd, by,
          ...(p.name ? { name: p.name } : {}), ...(p.env ? { env: p.env } : {}), ...(p.ready ? { ready: p.ready } : {}),
          ...(p.grace !== undefined ? { grace: p.grace } : {}), ...(p.notify ? { notify: p.notify } : {}),
          ...(p.restart ? { restart: p.restart } : {}), ...(p.keep !== undefined ? { keep: p.keep } : {}),
        }
      }
      function refuseOff() {
        if (superego.settings.get('extensions.processes') === false) throw new RpcError('refused', 'Processes is switched off on this machine (Settings → Extensions).')
      }
      /** Start one; a live one of its name: an error, kept as it is, or restarted, as `ifRunning` says. */
      async function start(spec: ProcessSpec, ifRunning: 'error' | 'keep' | 'restart' = 'error'): Promise<ProcessRecord> {
        refuseOff()
        const known = spec.name ? runner.find(spec.owner, spec.name) : undefined
        if (known && live(known.state)) {
          if (ifRunning === 'keep') return known
          if (ifRunning === 'error') throw new RpcError('busy', `${known.name} (${known.id}) is ${known.state} already: restart it (process_restart), or give another name.`)
          runner.define(spec)
          return runner.restart(known.id)
        }
        return runner.start(spec)
      }
      function find({ id, owner, thread, folder, name }: { id?: string; owner?: Owner; thread?: string; folder?: string; name?: string }): ProcessRecord {
        if (id) {
          const record = runner.records.get(id)
          if (!record) throw new RpcError('not_found', `No process ${id}.`)
          return record
        }
        if (!name) throw new RpcError('invalid', 'Say which: its `id`, or its `name` and owner.')
        const record = runner.find(ownerOf({ ...(owner ? { owner } : {}), ...(thread ? { thread } : {}), ...(folder ? { folder } : {}) }), name)
        if (!record) throw new RpcError('not_found', `No process named ${name} there.`)
        return record
      }
      async function stopAll(records: ProcessRecord[]) {
        await Promise.all(records.map((p) => runner.stop(p.id)))
        return records.length
      }

      async function read(record: ProcessRecord, { since, lines, plain, all }: { since?: number; lines?: number; plain?: boolean; all?: boolean }): Promise<OutputSlice> {
        const log = runner.logOf(record)
        const from = since ?? (all || lines ? 0 : record.start)
        const slice = await log.read(Math.max(from, all ? 0 : lines ? record.start : from), all ? 4 * READ_AT_MOST : READ_AT_MOST)
        const text = lines ? tail(slice.text, lines) : plain ? tail(slice.text, Number.MAX_SAFE_INTEGER) : slice.text
        return { text, from: slice.from, end: slice.end, start: record.start, first: slice.first }
      }

      /** Wait for it: ready, ended, or text in its output (this run's), up to `timeout` seconds. */
      async function wait(record: ProcessRecord, what: string, timeout: number, signal?: AbortSignal): Promise<WaitOutcome> {
        const test = what === 'ready' || what === 'exit' ? undefined : matcher(what)
        const done = (outcome: WaitOutcome['outcome']) => async (): Promise<WaitOutcome> => {
          const slice = await runner.logOf(record).read(record.start)
          if (ended(record.state)) runner.learnt(record.id)
          return { outcome, process: infoOf(record), tail: tail(slice.text, REPORT_LINES) }
        }
        const check = (text?: string): WaitOutcome['outcome'] | undefined => {
          if (test && text !== undefined && test(text)) return 'matched'
          if (what === 'ready' && record.state === 'running') return 'ready'
          if (!live(record.state)) return 'exited'
          return undefined
        }
        // Text already there, in this run's output.
        let window = test ? (await runner.logOf(record).read(record.start)).text : ''
        const now = check(test ? window : undefined)
        if (now) return done(now)()
        return new Promise<WaitOutcome>((resolve, reject) => {
          const finish = (outcome: WaitOutcome['outcome']) => { off(); clearTimeout(timer); signal?.removeEventListener('abort', aborted); done(outcome)().then(resolve, reject) }
          const off = runner.listen(record.id, ({ text }) => {
            if (text !== undefined) window = (window + text).slice(-65536)
            const outcome = check(text !== undefined ? window : undefined)
            if (outcome) finish(outcome)
          })
          const timer = setTimeout(() => finish('timeout'), Math.min(timeout, MOST_WAIT) * 1000)
          const aborted = () => { off(); clearTimeout(timer); reject(signal!.reason instanceof Error ? signal!.reason : new Error('Stopped waiting')) }
          if (signal?.aborted) aborted()
          else signal?.addEventListener('abort', aborted, { once: true })
        })
      }

      // ── Actions and reads: the window, `superego do`, other extensions ──────────────────────────────────────────
      const byOf = (context: { from?: string; by?: string }): ProcessInfo['by'] => {
        if (context.from) return { thread: context.from }
        if (context.by) return { extension: context.by }
        return { user: true }
      }
      const answer = (record: ProcessRecord) => infoOf(record)
      const rpc = (error: unknown): never => {
        if (error instanceof RpcError) throw error
        const { code, message } = error as { code?: string; message: string }
        throw new RpcError(code === 'not_found' ? 'not_found' : 'failed', message)
      }

      superego.action(defineAction({
        id: 'processes.start', title: 'Start a process', description: 'Start a command as a process of a thread, a folder or the machine.',
        expose: ['ui', 'cli'], params: obj({ ...specFields, ifRunning: opt(oneOf(['error', 'keep', 'restart'] as const)) }),
        run: async (params, context) => { await fromLoaded; return answer(await start(await specOf(params, byOf(context)), params.ifRunning).catch(rpc)) },
      }))
      superego.action(defineAction({
        id: 'processes.define', title: 'Define a process', description: 'Put a process, idle, to start later (its Start in the pane); a stopped one’s command changed.',
        expose: ['ui', 'cli'], params: obj(specFields),
        run: async (params, context) => { await fromLoaded; return answer(runner.define(await specOf(params, byOf(context)))) },
      }))
      superego.action(defineAction({
        id: 'processes.restart', title: 'Restart a process', description: 'Start a process again, stopping it first if it runs.',
        expose: ['ui', 'cli'], params: obj(targetFields),
        run: async (params) => { await fromLoaded; refuseOff(); const record = find(params); runner.seen(record.id); return answer(await runner.restart(record.id).catch(rpc)) },
      }))
      superego.action(defineAction({
        id: 'processes.stop', title: 'Stop a process', description: 'Stop a process and everything it started.',
        expose: ['ui', 'cli'], params: obj(targetFields),
        run: async (params) => { await fromLoaded; return answer(await runner.stop(find(params).id).catch(rpc)) },
      }))
      superego.action(defineAction({
        id: 'processes.remove', title: 'Remove a process', description: 'Forget a process that ended, and its output.',
        expose: ['ui', 'cli'], params: obj(targetFields),
        run: async (params) => { await fromLoaded; const record = find(params); await runner.remove(record.id).catch(rpc); return null },
      }))
      superego.action(defineAction({
        id: 'processes.dismiss', title: 'Dismiss what went wrong', description: 'Clear the problem Processes shows.',
        expose: ['ui'], params: obj({}),
        run: () => { trouble.set(null); return null },
      }))
      superego.action(defineAction({
        id: 'processes.seen', title: 'Mark a failure seen', description: 'Its thread’s row stops showing it failed.',
        expose: ['ui'], params: obj({ id: str() }),
        run: ({ id }) => { runner.seen(id); return null },
      }))
      superego.action(defineAction({
        id: 'processes.show', title: 'Show processes', description: 'Open the thread’s processes beside it.',
        expose: ['ui', 'cli'], thread: true, params: obj({ thread: opt(str()), id: opt(str()) }),
        run: ({ thread, id }) => {
          if (!thread) throw new RpcError('invalid', 'Say which thread (--thread).')
          return superego.dispatch('pane.open', { thread, kind: PANE, ...(id ? { params: { id } } : {}) })
        },
      }))

      superego.method('processes.list', async ({ thread, folder, all }) => {
        await fromLoaded
        if (all) return [...runner.records.values()].map(infoOf)
        if (thread) {
          if (!threads.has(thread)) know(await superego.threads.get(thread))
          return listOf(thread).map(infoOf)
        }
        if (folder) return [...runner.records.values()].filter((p) => 'folder' in p.owner && p.owner.folder === folder).map(infoOf)
        throw new RpcError('invalid', 'Say whose: `thread`, `folder` or `all`.')
      }, { params: obj({ thread: opt(str()), folder: opt(str()), all: opt(bool()) }) })
      superego.method(READ, async ({ id, since, lines, plain }) => (await fromLoaded, read(find({ id }), {
        ...(since !== undefined ? { since } : {}), ...(lines !== undefined ? { lines } : {}), ...(plain !== undefined ? { plain } : {}),
      })), { params: obj({ id: str(), since: opt(int({ minimum: 0 })), lines: opt(int({ minimum: 1 })), plain: opt(bool()) }) })
      superego.method('processes.wait', async ({ id, for: what, timeout }) => (await fromLoaded, wait(find({ id }), what, timeout)),
        { params: obj({ id: str(), for: str(), timeout: int({ minimum: 0, maximum: MOST_WAIT }) }) })
      superego.method('processes.output', async ({ id }) => (await fromLoaded, runner.mark(find({ id }))), { params: obj({ id: str() }) })

      // ── The agent ───────────────────────────────────────────────────────────────────────────────────────────────
      agentPart(superego, {
        threadOf: (conversationId) => superego.threads.of(conversationId as never)!,
        start: async (thread, args) => {
          await fromLoaded
          const record = await start(await specOf({ ...args, thread }, { thread }))
          return record
        },
        async find(thread, ref) {
          await fromLoaded
          const byId = runner.records.get(ref)
          if (byId) return byId
          // By its name, else by its command as it was given.
          const mine = listOf(thread)
          const named = mine.some((p) => p.name === ref) ? mine.filter((p) => p.name === ref) : mine.filter((p) => p.command === ref)
          const found = named.find((p) => live(p.state)) ?? named.at(-1)
          if (!found) throw new Error(`No process ${ref} here: process_list lists them.`)
          return found
        },
        list: async (thread, all) => (await fromLoaded, all ? [...runner.records.values()] : listOf(thread)),
        read: (record, options) => read(record, options),
        learnt: (record) => runner.learnt(record.id),
        wait,
        stop: (record) => runner.stop(record.id),
        restart: (record) => { refuseOff(); return runner.restart(record.id) },
      })

      // ── A thread's life ─────────────────────────────────────────────────────────────────────────────────────────
      superego.thread({
        started(thread) { know(thread); publish() },
        turnStart(thread) { running.add(thread.id); know(thread) },
        turnEnd(thread) { running.delete(thread.id); reports.idle(thread.id) },
        // In `archiving`, not `archived`: before another extension's `archived` removes its worktree.
        async archiving(thread) {
          // Continued in another thread: its processes are that one's now.
          const own = thread.continuedIn ? [] : [...runner.records.values()].filter((p) => 'thread' in p.owner && p.owner.thread === thread.id && live(p.state))
          const others = (await superego.threads.list()).some((t) => t.cwd === thread.cwd && t.id !== thread.id)
          const folder = others ? [] : [...runner.records.values()].filter((p) => 'folder' in p.owner && p.owner.folder === thread.cwd && live(p.state))
          const count = await stopAll([...own, ...folder])
          if (count) return { note: `stopped ${count === 1 ? 'its process' : `${count} processes`}` }
        },
        archived(thread) { threads.delete(thread.id); published.delete(thread.id); facts.delete(thread.id); lists.delete(thread.id) },
        unarchived(thread) { know(thread); publish() },
      })

      // Switched off on this machine: what runs stops.
      let wasOn = superego.settings.get('extensions.processes') !== false
      superego.settings.onChange(() => {
        const on = superego.settings.get('extensions.processes') !== false
        if (on === wasOn) return
        wasOn = on
        if (!on) void stopAll([...runner.records.values()].filter((p) => live(p.state))).catch((error) => fail("couldn't stop its processes", error))
      })

      // ── Set up: the records, then (not awaited) what an earlier daemon left running, the threads, a week's pruning ─
      const ready = (async () => {
        await adopted
        await runner.prune(KEEP_ENDED)
        await relist()
      })().catch((error) => fail("couldn't take back its processes", error))
      const pruning = setInterval(() => void runner.prune(KEEP_ENDED).catch((error) => fail("couldn't remove old processes", error)), 6 * 3600_000)
      pruning.unref()

      return async () => {
        clearInterval(pruning)
        clearTimeout(markTimer)
        reports.stop()
        await ready
        // Teardown leaves them running whatever the reason: the daemon stopping or restarting (the next takes them back),
        // or this set-up given up on. Only switching Processes off stops them (above).
        await runner.close()
      }
    },
  })
}

export default processesExtension()

// ── The agent's tools ───────────────────────────────────────────────────────────────────────────────────────────────

type ToolHost = {
  threadOf(conversationId: unknown): string
  start(thread: string, args: { command: string; name?: string; cwd?: string; ready?: string; notify?: ProcessInfo['notify']; env?: Record<string, string> }): Promise<ProcessRecord>
  find(thread: string, ref: string): Promise<ProcessRecord>
  list(thread: string, all: boolean): Promise<ProcessRecord[]>
  read(record: ProcessRecord, options: { lines?: number; all?: boolean }): Promise<OutputSlice>
  learnt(record: ProcessRecord): void
  wait(record: ProcessRecord, what: string, timeout: number, signal?: AbortSignal): Promise<WaitOutcome>
  stop(record: ProcessRecord): Promise<ProcessRecord>
  restart(record: ProcessRecord): Promise<ProcessRecord>
}

/** A process in a few lines, for the agent. */
export function describe(p: ProcessInfo): string {
  const now = Date.now()
  const state = p.state === 'running' || p.state === 'starting'
    ? `${p.state}${p.pid ? `, pid ${p.pid}` : ''}${p.startedAt ? `, up ${span(now - p.startedAt)}` : ''}${p.state === 'starting' && p.ready ? `, waiting for ${JSON.stringify(p.ready)}` : ''}`
    : p.state === 'idle' ? 'idle (defined, not started)' : `${p.state}: ${endedHow(p)}${p.endedAt ? ` (${span(now - p.endedAt)} ago)` : ''}`
  const owner = 'folder' in p.owner ? ` [folder ${p.owner.folder}]` : 'machine' in p.owner ? ' [machine]' : ''
  return `${p.id}${p.name ? ` ${p.name}` : ''}: ${state}${owner}\n  $ ${p.command}${p.error && p.state !== 'lost' ? `\n  error: ${p.error}` : ''}`
}

const text = (value: string) => ({ output: [{ type: 'text' as const, text: value }] })

function agentPart(superego: DaemonApi, host: ToolHost) {
  const waited = async (record: ProcessRecord, seconds: number, signal?: AbortSignal) => {
    if (!seconds) return describe(infoOf(record))
    const { outcome, process, tail: lines } = await host.wait(record, record.ready ? 'ready' : 'exit', seconds, signal)
    const said = outcome === 'timeout' ? `still ${process.state} after ${seconds}s` : outcome === 'ready' ? 'ready' : endedHow(process)
    return `${describe(process)}\n${said}${lines ? `:\n${lines}` : ''}`
  }
  superego.agent(defineExtension({
    name: 'processes',
    tools: [
      defineTool({
        name: 'process_start',
        description: 'Start a long-running command (a server, a watcher, a long build or test run) as a process of this thread, on this machine. '
          + 'It runs on after your turn, its output kept; you are told when it ends (a build) or fails (a server, given `ready`). '
          + 'Answers its id at once, or after `wait` seconds for it to be ready (or exit) with its last lines.',
        parameters: obj({
          command: str({ minLength: 1, description: 'a shell command line, run in the user’s login shell' }),
          name: opt(str({ description: 'a short name, unique among this thread’s processes (dev, tests)' })),
          cwd: opt(str({ description: 'where it runs: the thread’s folder unless given (relative to it)' })),
          ready: opt(str({ description: 'text, or /regex/, in its output that says it’s ready (a server’s “ready in”)' })),
          wait: opt(int({ minimum: 0, maximum: MOST_WAIT, description: 'seconds to wait for it to be ready (or to exit, without `ready`): 0, return at once' })),
          notify: opt(oneOf(['exit', 'failure', 'never'] as const, { description: 'when to wake you as it ends: any end (the default without `ready`), only a failure (with `ready`), never' })),
          env: opt(map(str())),
        }),
        executionMode: 'sequential',
        async execute(args, api, context) {
          const thread = host.threadOf(api.conversationId)
          const record = await host.start(thread, args)
          return text(await waited(record, args.wait ?? 0, context.abortSignal))
        },
      }),
      defineTool({
        name: 'process_list',
        description: "This thread's processes and its folder's (the dev command's): id, name, state, command, how long up or how it ended. `all`: every process on this machine.",
        parameters: obj({ all: opt(bool()) }),
        async execute({ all }, api) {
          const list = await host.list(host.threadOf(api.conversationId), Boolean(all))
          return text(list.length ? list.map((p) => describe(infoOf(p))).join('\n') : 'No processes.')
        },
      }),
      defineTool({
        name: 'process_logs',
        description: "A process's output, plain (colours and redrawn lines resolved): the last `lines` (100) of its current or last run; `all`, of earlier runs too; `grep`, only lines matching it (a /regex/ or text).",
        parameters: obj({
          id: str({ description: 'its id, or its name (or its command)' }),
          lines: opt(int({ minimum: 1, maximum: 5000 })),
          grep: opt(str()),
          all: opt(bool()),
        }),
        async execute({ id, lines, grep, all }, api) {
          const record = await host.find(host.threadOf(api.conversationId), id)
          const slice = await host.read(record, { all: Boolean(all) })
          if (ended(record.state)) host.learnt(record)
          const test = grep ? matcher(grep) : undefined
          const out = tail(slice.text, lines ?? 100, test)
          const cut = slice.from > (all ? slice.first : record.start) ? '(earlier output is in its log)\n' : ''
          return text(`${describe(infoOf(record))}\n${cut}${out || '(no output)'}`)
        },
      }),
      defineTool({
        name: 'process_wait',
        description: "Wait for a process: until it's `ready`, until it `exit`s, or until text (or /regex/) shows in this run's output; up to `timeout` seconds. Answers what happened and its last lines.",
        parameters: obj({
          id: str({ description: 'its id, or its name (or its command)' }),
          for: str({ description: "'ready', 'exit', or text or /regex/ in its output" }),
          timeout: int({ minimum: 1, maximum: MOST_WAIT, description: 'seconds' }),
        }),
        // Waited again after a restart: what it waits for may still come.
        replay: 'safe',
        async execute(args, api, context) {
          const record = await host.find(host.threadOf(api.conversationId), args.id)
          const { outcome, process, tail: lines } = await host.wait(record, args.for, args.timeout, context.abortSignal)
          const said = outcome === 'matched' ? `matched ${JSON.stringify(args.for)}` : outcome === 'ready' ? 'ready'
            : outcome === 'timeout' ? `timed out after ${args.timeout}s (${process.state})` : endedHow(process)
          return text(`${said}\n${describe(process)}${lines ? `\n${lines}` : ''}`)
        },
      }),
      defineTool({
        name: 'process_stop',
        description: 'Stop a process and everything it started (SIGTERM, then SIGKILL after its grace).',
        parameters: obj({ id: str({ description: 'its id, or its name (or its command)' }) }),
        executionMode: 'sequential',
        async execute({ id }, api) {
          const record = await host.stop(await host.find(host.threadOf(api.conversationId), id))
          return text(describe(infoOf(record)))
        },
      }),
      defineTool({
        name: 'process_restart',
        description: 'Start a process again, stopping it first if it runs. Answers once it has started (not necessarily ready: process_wait).',
        parameters: obj({ id: str({ description: 'its id, or its name (or its command)' }) }),
        executionMode: 'sequential',
        async execute({ id }, api) {
          const record = await host.restart(await host.find(host.threadOf(api.conversationId), id))
          return text(describe(infoOf(record)))
        },
      }),
    ],
    sections: [section('processes', () =>
      'Anything that runs longer than a command (a server, a watcher, a long build or test run): process_start, not `&`, `nohup` '
      + "or a bash call that waits. It runs on this machine; its localhost is this machine's. You're told when one ends "
      + '(or, given `ready`, fails); process_wait waits for it, process_logs reads its output.')],
  }))
}
