// The processes of a machine: their records (`processes.json` in the extension's folder, its `jsonFile`, saved whole on
// each change, and each run's own in its folder, `record.json`, to find them by if `processes.json` is lost), starting and stopping
// them, following their output (the log each writes, tailed: for ready text, waiters and the live mark), and taking
// them back after the daemon restarts (`adopt`): still running, ended while it was away (its exit file says how), or
// gone with a restart of the machine or the end of the user's session (`lost`, not reported; started again if it's
// `keep`).
import { randomBytes } from 'node:crypto'
import { watch, type FSWatcher } from 'node:fs'
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { adoptGroup, processTable, type JsonFile, type ProcessTable } from '@superego/daemon/sdk'
import { matcher, OutputLog, stripAnsi } from './log.ts'
import { endedHow, live, type Notify, type OutputMark, type Owner, type ProcessInfo, type ProcessState } from './shared.ts'
import { exitFile, startDetached } from './spawn.ts'

/** A process as kept: what's shown, and what isn't (its env, where its log stands, its pid's start time). */
export type ProcessRecord = ProcessInfo & {
  env: Record<string, string>
  /** Bytes its log rotated away so far: positions count from the first byte it ever wrote. */
  base: number
  /** Where its current (or last) run's output begins. */
  start: number
  /** Its leader's start time, as the machine says: a pid is the same process only while this matches. */
  pidStart?: string
  createdAt: number
  /** The thread learnt how it ended (process_wait or process_logs after): no report needed. */
  learnt?: boolean
  /** The machine's boot its current (or last) run started in (`processTable.boot`): after another, it's gone. */
  boot?: string
  /** `restart: 'on-failure'`: when it's due to start again, and when it failed lately (it's given up on after too many). */
  retryAt?: number
  failures?: number[]
}

/** What a start or a definition says (and `define` keeps for the next start). */
export type ProcessSpec = {
  owner: Owner
  name?: string
  command: string
  cwd: string
  env?: Record<string, string>
  ready?: string
  grace?: number
  notify?: Notify
  restart?: 'never' | 'on-failure'
  keep?: boolean
  by?: ProcessInfo['by']
}

/** What `processes.json` holds. */
export type Kept = { processes: ProcessRecord[] }
export const EMPTY: Kept = { processes: [] }
export const checkKept = (data: unknown) => Array.isArray((data as Partial<Kept> | null)?.processes) ? undefined : 'it has no list of processes'

/** Each run's copy of its record, in its folder. */
const RECORD = 'record.json'

/** What happens as it runs, for those waiting on it: output arriving, or its state changing. */
export type ProcessEvent = { text?: string; state?: ProcessState }

/** What the runner tells its host. */
export type RunnerHost = {
  /** A record changed (its state, its definition) or went (`removed`). */
  changed(process: ProcessRecord, removed?: boolean): void
  /** Its output moved: throttled by the host. */
  output(process: ProcessRecord, mark: OutputMark): void
  /** It ended on its own (not stopped), now or while no daemon ran: a report, maybe. */
  ended(process: ProcessRecord): void
  /** Something went wrong that no caller hears of (a save, a tail): said where the user sees it. */
  error(message: string, error: unknown): void
}

const DEFAULT_GRACE = 5000
/** How often a live process's log and leader are looked at besides what `fs.watch` says. */
const POLL = 1000
/** How much plain output the ready text is looked for in, from the newest. */
const READY_WINDOW = 8192
/** `restart: 'on-failure'`: given up after this many failures in this long. */
const GIVE_UP = { failures: 5, within: 120_000 }
/**
 * An end by SIGTERM or SIGHUP (as the machine shuts down or the user logs out) is recorded this long after: if the
 * daemon is stopping too meanwhile, it's left for the next daemon to find (`lost`), not reported as a failure.
 */
export const SETTLE = 3000
/** Exit statuses of a shell whose command SIGHUP, SIGINT or SIGTERM ended. */
const ENDED_BY_SESSION = new Set([129, 130, 143])
const sessionEnd = (code: number | null | undefined, signal?: string | null) =>
  (code !== undefined && code !== null && ENDED_BY_SESSION.has(code)) || signal === 'SIGTERM' || signal === 'SIGHUP' || signal === 'SIGINT'
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const sameOwner = (a: Owner, b: Owner) => JSON.stringify(a) === JSON.stringify(b)
export const newId = () => `p_${randomBytes(4).toString('hex')}`
const clock = (at: number) => new Date(at).toTimeString().slice(0, 5)

/** A line of the runner's own in a process's output: dim, so the pane sets it apart; plain text strips it. */
const line = (text: string) => `\u001b[2m── ${text} ──\u001b[0m\n`

/** What follows a live process: its group, its log's tail, those waiting on it. */
type Live = {
  generation: number
  group?: { stop(): Promise<unknown>; release?(): void }
  /** Resolves once the run it's for has been recorded as ended. */
  finished?: Promise<void>
  tail?: Tail
  /** A restart's backoff timer (`on-failure`). */
  timer?: ReturnType<typeof setTimeout>
  /** One change at a time: starts, stops and restarts of it queue. */
  queue: Promise<unknown>
}

/** A log followed from a position: new output as it comes. */
class Tail {
  pos: number
  private readonly decoder = new StringDecoder('utf8')
  private watcher: FSWatcher | undefined
  private timer: ReturnType<typeof setInterval> | undefined
  private busy = false
  private again = false
  readonly log: OutputLog
  private readonly take: (text: string, end: number) => void
  private readonly rotated: () => void
  private readonly failed: (error: unknown) => void
  constructor(log: OutputLog, pos: number, take: (text: string, end: number) => void, rotated: () => void, failed: (error: unknown) => void) {
    this.log = log
    this.pos = pos
    this.take = take
    this.rotated = rotated
    this.failed = failed
    try {
      this.watcher = watch(log.path, () => void this.pull())
      this.watcher.on('error', () => this.watcher?.close())
    } catch { /* no file yet, or no watching here: the poll alone follows it */ }
    this.timer = setInterval(() => void this.pull(), POLL)
    this.timer.unref()
  }

  /** Read what's new; resolves once caught up with what was there when asked. */
  async pull(): Promise<void> {
    if (this.busy) { this.again = true; return }
    this.busy = true
    try {
      do {
        this.again = false
        if (await this.log.rotate()) this.rotated()
        const slice = await this.log.read(this.pos)
        if (slice.end === this.pos) continue
        // What rotated away unread (or more than one read gives) is skipped.
        this.pos = slice.end
        this.take(slice.text, slice.end)
      } while (this.again)
    } catch (error) {
      this.failed(error)
    } finally {
      this.busy = false
    }
  }

  stop() {
    this.watcher?.close()
    clearInterval(this.timer)
  }
}

export class Runner {
  readonly records = new Map<string, ProcessRecord>()
  private readonly lives = new Map<string, Live>()
  private readonly listeners = new Map<string, Set<(event: ProcessEvent) => void>>()
  private closed = false
  /** Which boot of the machine this is: asked once. */
  private boot: Promise<string | undefined> | undefined
  /** The records were read (or there were none): until then, writing them would lose what's in the file. */
  private loaded = false
  readonly dir: string
  private readonly store: JsonFile<Kept>
  private readonly host: RunnerHost
  private readonly processes: ProcessTable
  private readonly shell: string | undefined

  /** In `dir`, its records kept in `store` (`processes.json` there). */
  constructor(dir: string, store: JsonFile<Kept>, host: RunnerHost, { processes = processTable, shell }: { processes?: ProcessTable; shell?: string } = {}) {
    this.dir = dir
    this.store = store
    this.host = host
    this.processes = processes
    this.shell = shell
  }

  folderOf(id: string) { return join(this.dir, id) }
  logOf(record: ProcessRecord) { return new OutputLog(this.folderOf(record.id), record.base) }

  private bootNow() { return this.boot ??= this.processes.boot() }

  /**
   * Read the records kept. A `processes.json` that doesn't read (kept aside by the store, and said) is made again from
   * each run's own record (`<id>/record.json`), so what runs isn't lost track of: how many were found then.
   */
  async load(): Promise<{ rebuilt?: number }> {
    const kept = await this.store.read()
    if (this.store.bad) {
      const found = await this.rebuild()
      this.loaded = true
      await this.save()
      return { rebuilt: found }
    }
    for (const record of kept.processes) this.records.set(record.id, record)
    this.loaded = true
    return {}
  }

  /** The records each run left in its folder: how many were found. What ended is taken as reported (none can say). */
  private async rebuild(): Promise<number> {
    const names = await readdir(this.dir).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return [] as string[]
      throw error
    })
    for (const name of names.filter((n) => /^p_[0-9a-f]+$/.test(n))) {
      let record: ProcessRecord
      try {
        record = JSON.parse(await readFile(join(this.folderOf(name), RECORD), 'utf8')) as ProcessRecord
      } catch (error) {
        // A run from before folders had one, or one that never started: nothing to find it by.
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.host.error(`couldn't read ${name}'s record`, error)
        continue
      }
      if (record.id !== name) continue
      if (!live(record.state)) record.learnt = true
      this.records.set(record.id, record)
    }
    return this.records.size
  }

  /** Keep a copy of its record in its own folder: what `rebuild` finds it by. */
  private async keep(record: ProcessRecord) {
    const file = join(this.folderOf(record.id), RECORD)
    const temp = `${file}.${process.pid}.tmp`
    try {
      await writeFile(temp, JSON.stringify(record), { mode: 0o600 })
      await rename(temp, file)
    } catch (error) {
      this.host.error(`couldn't save ${record.id}'s record`, error)
    }
  }

  /** Save every record, whole (the store writes one save at a time, the newest landing). */
  save(): Promise<void> {
    // Not read yet: what's there stays until it is.
    if (!this.loaded) return Promise.resolve()
    return this.store.save(() => ({ processes: [...this.records.values()] }))
      .catch(() => { /* said by the store's `trouble` (Processes' trouble value), and logged */ })
  }

  private liveOf(id: string): Live {
    let state = this.lives.get(id)
    if (!state) this.lives.set(id, state = { generation: 0, queue: Promise.resolve() })
    return state
  }

  /** One change of `id` at a time, in order. */
  private queued<T>(id: string, work: () => Promise<T>): Promise<T> {
    const state = this.liveOf(id)
    const done = state.queue.then(work, work)
    state.queue = done.catch(() => {})
    return done
  }

  /** Hear what happens to a process (its output, its state), until the function returned is called. */
  listen(id: string, listener: (event: ProcessEvent) => void): () => void {
    let set = this.listeners.get(id)
    if (!set) this.listeners.set(id, set = new Set())
    set.add(listener)
    return () => { set.delete(listener) }
  }

  private emit(id: string, event: ProcessEvent) {
    for (const listener of this.listeners.get(id) ?? []) {
      try { listener(event) } catch (error) { this.host.error('a listener failed', error) }
    }
  }

  /** It changed: kept, told. */
  private touch(record: ProcessRecord) {
    void this.save()
    this.host.changed(record)
    this.emit(record.id, { state: record.state })
  }

  find(owner: Owner, name: string) {
    return [...this.records.values()].find((p) => p.name === name && sameOwner(p.owner, owner))
  }

  /** A record for `spec`: the one of its owner by its name if there is one (its definition updated), else a new one. */
  private recordFor(spec: ProcessSpec): ProcessRecord {
    const known = spec.name ? this.find(spec.owner, spec.name) : undefined
    const definition = {
      owner: spec.owner, cwd: spec.cwd, command: spec.command, env: spec.env ?? {}, grace: spec.grace ?? DEFAULT_GRACE,
      notify: spec.notify ?? (spec.ready ? 'failure' : 'exit'), restart: spec.restart ?? 'never', keep: spec.keep ?? false,
      ...(spec.name ? { name: spec.name } : {}), ...(spec.ready ? { ready: spec.ready } : {}),
    } satisfies Partial<ProcessRecord>
    if (known) {
      delete known.ready
      Object.assign(known, definition, spec.by ? { by: spec.by } : {})
      return known
    }
    const record: ProcessRecord = {
      id: newId(), ...definition, by: spec.by ?? {}, state: 'idle', run: 0, base: 0, start: 0, createdAt: Date.now(),
    }
    this.records.set(record.id, record)
    return record
  }

  /** Put a process's definition, without starting it: a new one idle, a known one's next run changed. */
  define(spec: ProcessSpec): ProcessRecord {
    const record = this.recordFor(spec)
    this.touch(record)
    return record
  }

  /** Start a process by its spec; a live one of its name is the caller's to decide on first (`start` in the daemon). */
  start(spec: ProcessSpec): Promise<ProcessRecord> {
    const record = this.recordFor(spec)
    return this.queued(record.id, () => this.begin(record))
  }

  /** Stop it if it's live, then start it (again). */
  restart(id: string): Promise<ProcessRecord> {
    const record = this.get(id)
    return this.queued(id, async () => {
      await this.halt(record)
      return this.begin(record)
    })
  }

  /** Stop it if it's live; resolves once all of it is gone and it's recorded so. */
  stop(id: string): Promise<ProcessRecord> {
    const record = this.get(id)
    return this.queued(id, async () => {
      await this.halt(record)
      return record
    })
  }

  /** Forget an ended (or idle) one, and its output. */
  async remove(id: string) {
    const record = this.get(id)
    if (live(record.state)) throw new Error(`${id} is ${record.state}: stop it first`)
    clearTimeout(this.lives.get(id)?.timer)
    delete record.retryAt
    this.records.delete(id)
    this.lives.delete(id)
    this.listeners.delete(id)
    await this.save()
    await rm(this.folderOf(id), { recursive: true, force: true })
    this.host.changed(record, true)
  }

  get(id: string): ProcessRecord {
    const record = this.records.get(id)
    if (!record) throw Object.assign(new Error(`No process ${id}`), { code: 'not_found' })
    return record
  }

  /** Mark how it ended as seen: the user looked, or acted on it. */
  seen(id: string) {
    const record = this.records.get(id)
    if (!record || record.seen || record.state !== 'failed') return
    record.seen = true
    this.touch(record)
  }

  /** The thread learnt how it ended (it read its logs or waited on it after): nothing to report. */
  learnt(id: string) {
    const record = this.records.get(id)
    if (record && !live(record.state) && !record.learnt) { record.learnt = true; void this.save() }
  }

  async mark(record: ProcessRecord): Promise<OutputMark> {
    return { end: await this.logOf(record).end(), start: record.start }
  }

  /** Start a run of it: its output from here on, its state followed. */
  private async begin(record: ProcessRecord): Promise<ProcessRecord> {
    const state = this.liveOf(record.id)
    clearTimeout(state.timer)
    const generation = ++state.generation
    const folder = this.folderOf(record.id)
    await mkdir(folder, { recursive: true })
    const log = this.logOf(record)
    record.run++
    if (record.run > 1) await log.note(`\n${line(`run ${record.run} · ${clock(Date.now())}`)}`)
    record.start = await log.end()
    for (const key of ['endedAt', 'exitCode', 'signal', 'stopped', 'error', 'whileAway', 'seen', 'learnt', 'pid', 'pidStart', 'retryAt'] as const) delete record[key]
    record.startedAt = Date.now()
    const boot = await this.bootNow()
    if (boot) record.boot = boot
    else delete record.boot
    const group = await startDetached({
      dir: folder, log: log.path, command: record.command, cwd: record.cwd, env: record.env, grace: record.grace,
      ...(this.shell ? { shell: this.shell } : {}),
    })
    state.group = group
    const pid = group.child.pid
    if (pid !== undefined) {
      record.pid = pid
      const start = (await this.processes.lookup(pid))?.start
      if (start) record.pidStart = start
    }
    record.state = pid === undefined ? 'failed' : record.ready ? 'starting' : 'running'
    this.follow(record, record.start)
    state.finished = group.exited.then(async (exit) => {
      const code = exit.error ? undefined : exit.code
      await this.finish(record, generation, { code, signal: exit.signal, stopped: exit.stopped, ...(exit.error ? { error: exit.error.message } : {}) })
    })
    this.touch(record)
    await this.keep(record)
    return record
  }

  /** Follow its log from `pos`: ready text, waiters, the live mark. */
  private follow(record: ProcessRecord, pos: number) {
    const state = this.liveOf(record.id)
    state.tail?.stop()
    const test = record.ready ? matcher(record.ready) : undefined
    let window = ''
    const tail = new Tail(this.logOf(record), pos, (text, end) => {
      if (this.closed) return
      this.emit(record.id, { text })
      this.host.output(record, { end, start: record.start })
      if (test && record.state === 'starting') {
        window = (window + stripAnsi(text)).slice(-READY_WINDOW)
        if (test(window)) { record.state = 'running'; this.touch(record) }
      }
    }, () => { record.base = tail.log.base; void this.save() }, (error) => this.host.error(`couldn't read ${record.id}'s output`, error))
    state.tail = tail
    void tail.pull()
  }

  /** Stop what runs of it, and wait till its end is recorded. */
  private async halt(record: ProcessRecord) {
    const state = this.liveOf(record.id)
    clearTimeout(state.timer)
    if (record.retryAt !== undefined) { delete record.retryAt; this.touch(record) }
    if (!live(record.state) || !state.group) return
    record.stopped = true
    record.state = 'stopping'
    this.touch(record)
    await state.group.stop()
    await state.finished
  }

  /** A run ended: recorded, its end line written, its waiters told, and maybe started again. */
  private async finish(record: ProcessRecord, generation: number, how: { code?: number | null; signal?: string | null; stopped: boolean; error?: string; whileAway?: boolean }) {
    const state = this.liveOf(record.id)
    if (this.closed || state.generation !== generation) return
    const stopped = how.stopped || Boolean(record.stopped)
    // An adopted one's code is in its exit file, if it got to write it.
    const code = how.code !== undefined ? how.code : await this.exitCode(record)
    // Ended as the machine shuts down or the session ends? Then the daemon is about to stop too: leave it to the next.
    if (!stopped && !how.whileAway && sessionEnd(code, how.signal)) {
      await sleep(SETTLE)
      if (this.closed || state.generation !== generation) return
    }
    await state.tail?.pull()
    state.tail?.stop()
    state.tail = undefined
    state.group = undefined
    const failed = !stopped && (how.error !== undefined || code !== 0)
    record.state = failed ? 'failed' : 'exited'
    record.endedAt = Date.now()
    record.exitCode = how.error !== undefined ? undefined : code ?? null
    if (how.signal) record.signal = how.signal
    if (stopped) record.stopped = true
    if (how.error) record.error = how.error
    if (how.whileAway) record.whileAway = true
    delete record.pid
    delete record.pidStart
    await this.logOf(record).note(line(endedHow(record))).catch((error) => this.host.error(`couldn't write ${record.id}'s output`, error))
    this.host.output(record, await this.mark(record))
    if (failed && record.restart === 'on-failure') this.retry(record)
    this.touch(record)
    await this.keep(record)
    if (!stopped) this.host.ended(record)
  }

  /**
   * `on-failure`: start it again after a while, longer each time; given up after too many failures close together.
   * When it's due is kept with it, so a daemon restart meanwhile doesn't drop it (`adopt` sets it again).
   */
  private retry(record: ProcessRecord) {
    const now = Date.now()
    record.failures = [...(record.failures ?? []).filter((at) => at > now - GIVE_UP.within), now]
    if (record.failures.length >= GIVE_UP.failures) {
      record.error = `gave up after ${GIVE_UP.failures} failures in ${GIVE_UP.within / 60_000} minutes`
      delete record.retryAt
      return
    }
    record.retryAt = now + Math.min(60_000, 1000 * 2 ** (record.failures.length - 1))
    this.schedule(record)
  }

  /** Start it again once its `retryAt` comes. */
  private schedule(record: ProcessRecord) {
    const state = this.liveOf(record.id)
    clearTimeout(state.timer)
    state.timer = setTimeout(() => {
      if (this.records.get(record.id) === record && record.state === 'failed' && record.retryAt !== undefined) {
        void this.queued(record.id, () => this.begin(record)).catch((error) => this.host.error(`couldn't restart ${record.id}`, error))
      }
    }, Math.max(0, (record.retryAt ?? 0) - Date.now()))
    state.timer.unref()
  }

  /** What its exit file says: the code its last run exited with, if it got to write it, and when it did. */
  private async exitOf(record: ProcessRecord): Promise<{ code: number | null; at: number } | undefined> {
    const file = exitFile(this.folderOf(record.id))
    let text: string
    let at: number
    try {
      [text, at] = await Promise.all([readFile(file, 'utf8'), stat(file).then((s) => s.mtimeMs)])
    } catch (error) {
      // None: it hasn't ended, or it went without writing one (killed outright, the machine restarted).
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.host.error(`couldn't read how ${record.id} ended`, error)
      return undefined
    }
    const code = Number(text.trim())
    return { code: Number.isInteger(code) ? code : null, at }
  }
  private async exitCode(record: ProcessRecord) { return (await this.exitOf(record))?.code }

  /**
   * Take back what an earlier daemon left live: still running (its pid that same process), it's followed again; ended
   * meanwhile (its exit file), it's recorded so and reported; started before the machine last booted, or ended by
   * SIGTERM or SIGHUP while no daemon ran (a logout), or neither found, it went with the machine or the session
   * (`lost`, not reported), and a `keep` one is started again. A failed `on-failure` one due to start again is set to.
   * Returns those started again.
   */
  async adopt(): Promise<ProcessRecord[]> {
    const again: ProcessRecord[] = []
    const boot = await this.bootNow()
    for (const record of this.records.values()) {
      if (record.state === 'failed' && record.restart === 'on-failure' && record.retryAt !== undefined) { this.schedule(record); continue }
      if (!live(record.state)) continue
      const state = this.liveOf(record.id)
      const generation = ++state.generation
      const rebooted = Boolean(boot && record.boot && record.boot !== boot)
      const there = !rebooted && record.pid !== undefined && record.pidStart !== undefined && (await this.processes.lookup(record.pid))?.start === record.pidStart
      if (there) {
        const group = adoptGroup(record.pid!, { grace: record.grace, start: record.pidStart! })
        state.group = group
        // Starting still: its ready text is looked for from its run's start.
        this.follow(record, record.state === 'starting' ? record.start : await this.logOf(record).end())
        state.finished = group.exited.then((exit) => this.finish(record, generation, { stopped: exit.stopped, whileAway: false }))
        if (record.state === 'stopping') void this.queued(record.id, () => this.halt(record))
        continue
      }
      const exit = rebooted ? undefined : await this.exitOf(record)
      // Ended by SIGTERM, SIGHUP or SIGINT while no daemon ran: sent to all as the session ended (a logout), not a failure.
      const withSession = exit && sessionEnd(exit.code)
      if (exit && !withSession) {
        await this.finish(record, generation, { code: exit.code, stopped: record.state === 'stopping', whileAway: true })
        continue
      }
      record.state = 'lost'
      record.endedAt = exit?.at ?? Date.now()
      record.error = rebooted || !exit ? 'stopped by a restart of the machine' : 'stopped as the session ended'
      delete record.pid
      delete record.pidStart
      await this.logOf(record).note(line('gone with a restart')).catch((error) => this.host.error(`couldn't write ${record.id}'s output`, error))
      this.touch(record)
      if (record.keep) again.push(record)
    }
    for (const record of again) await this.queued(record.id, () => this.begin(record)).catch((error) => this.host.error(`couldn't start ${record.id} again`, error))
    return again
  }

  /** Remove what ended longer ago than `age` (ms), its output too. */
  async prune(age: number) {
    const before = Date.now() - age
    for (const record of [...this.records.values()]) {
      if (record.state !== 'idle' && !live(record.state) && (record.endedAt ?? 0) < before) await this.remove(record.id)
    }
  }

  /** Stop following (the daemon stops): what runs goes on running, for the next daemon to take back. */
  close() {
    this.closed = true
    for (const state of this.lives.values()) {
      state.tail?.stop()
      state.group?.release?.()
      clearTimeout(state.timer)
    }
    return this.store.settled()
  }
}
