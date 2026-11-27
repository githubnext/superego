// github, daemon half: a thread's pull requests. Attached by themselves (the thread's agent ran `gh pr create`; a thread
// in a worktree of its own pushed a branch that has one) or by hand (the window, `pr_attach`), and detached by hand
// (never attached again by themselves then). Each kept with its thread (`superego.state`) and shown as its facts
// (`facts.github`), the summary the marks draw. One poller per machine asks this machine's `gh` about every pull
// request its threads have, in one GraphQL query per host: often while checks run or something just happened, rarely
// otherwise, never once merged or closed; backing off a failing host, waiting out a rate limit (only the user's Refresh
// asks one that's held), resting while gh is missing or signed out (Settings says so, and each pull request's tooltip),
// and never asking a host gh isn't signed in to. The full snapshot of each (checks, reviews, comments) is kept once per
// machine, in `<dir>/prs.json` (a `jsonFile`), for the pane and `pr_view`; the agent's prompt only names the thread's
// pull requests. Its description and conversation aren't polled: the pane and `pr_view` have them fetched with the rest
// as they look (the same query, with more), kept in memory. A watching agent is woken by a notice, within its thread's wake budget: at most `WAKES` an hour about
// one pull request.
import { execFile } from 'node:child_process'
import { defineExtension, defineTool, section } from '@earendil-works/pi-durable'
import { bool, lit, obj, opt, str } from '@earendil-works/pi-schema'
import { defineAction, defineDaemonExtension } from '@superego/daemon'
import { RpcError, type ThreadInfo } from '@superego/protocol'
import { digest, promptLine } from './digest.ts'
import { eventsOf, fixText, NOTICED, noticeForAgent, said, wakes, wakeText, type PrEvent } from './events.ts'
import { fetchPrs, ghRunner, ghStatus, GhError, prsOfBranch, type Gh } from './gh.ts'
import { backoff, due, INTERVALS, type Entry, type Intervals } from './schedule.ts'
import {
  about, ATTACH, ATTACH_TOOL, DETACH, DETACH_TOOL, lead, NOTICE, parsePr, PANE, PR, PROMPT_SECTION, prsIn, REFRESH, refOf, SECTION, STATUS, UNWATCH, VIEW_TOOL, WATCH,
  WATCH_TOOL, watchWord, type Conversation, type GhProblem, type GhStatus, type GithubFacts, type GithubState, type How, type NoticeData, type PrDetail, type PrKey, type PrLink,
  type PrSummary, type PrView, type Watch,
} from './shared.ts'

export type GithubOptions = {
  /** The environment gh runs in (its PATH finds it): the login shell's unless given (a test's fake gh). */
  env?: () => NodeJS.ProcessEnv | Promise<NodeJS.ProcessEnv>
  /** How often it asks (shorter, in a test). */
  intervals?: Partial<Intervals>
}

/** A watch from what was asked: both checks and reviews unless said. */
const watchOf = (checks?: boolean, reviews?: boolean, until?: 'checks'): Watch =>
  until === 'checks' ? { checks: true, until } : { ...(checks === false ? { checks: false } : {}), ...(reviews === false ? { reviews: false } : {}) }
const empty = (): GithubState => ({ prs: [], detached: [], summaries: {} })
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
/** How many pull requests go in one query. */
const BATCH = 25
/** Below this much of the rate limit left, a host waits for it to reset. */
const RESERVE = 50
/** The loop guard: a thread's watching agent is woken at most this many times an hour about one pull request. */
const WAKES = 5
const HOUR = 60 * 60_000
/** How many told events' keys are kept per pull request. */
const TOLD = 200

/** A pull request's summary: as last fetched, with what's wrong now; from its key alone before it was ever fetched. */
function summaryOf(key: PrKey, entry: Entry | undefined, error: GhProblem | undefined): PrSummary {
  const detail = entry?.detail
  if (detail) {
    const { checkList: _c, reviews: _r, comments: _m, branch: _b, base: _a, head: _h, author: _u, polledAt: _p, error: _e, ...summary } = detail
    return error ? { ...summary, error } : summary
  }
  const ref = refOf(key)!
  return { key, url: ref.url, number: ref.number, repo: `${ref.owner}/${ref.repo}`, checks: 'none', failing: 0, review: 'none', unresolved: 0, ...(error ? { error } : {}) }
}

/** git in `cwd`: its output, trimmed; rejects when it fails. */
const git = (cwd: string, args: string[]) => new Promise<string>((done, fail) =>
  execFile('git', ['-C', cwd, ...args], { timeout: 10_000 }, (error, out) => error ? fail(error) : done(String(out).trim())))

export function githubExtension(options: GithubOptions = {}) {
  return defineDaemonExtension({
    ...about,
    setup(superego) {
      const intervals = { ...INTERVALS, ...options.intervals }
      const { signal } = superego
      const env = options.env ? async () => options.env!() : async () => {
        const found = await superego.loginEnv()
        // The login shell's over the daemon's own; without it (loginEnv logged why), the daemon's: gh may be on it still.
        return 'env' in found ? { ...process.env, ...found.env } : process.env
      }
      const gh: Gh = ghRunner(env)
      const state = superego.state<GithubState>()

      // ── The thread's pull requests, as clients see them ──────────────────────────────────────────────────────────
      superego.facts<GithubState>(({ state }) => {
        if (!state?.prs.length) return undefined
        const prs = [...state.prs].sort((a, b) => b.at - a.at).map((link) => ({ ...state.summaries[link.key] ?? summaryOf(link.key, undefined, undefined), how: link.how, at: link.at, ...(link.watch ? { watch: link.watch } : {}) }))
        return { prs } satisfies GithubFacts
      })

      // ── gh's status (Settings) ───────────────────────────────────────────────────────────────────────────────────
      const status = superego.value<GhStatus | null>(STATUS, null)
      superego.settings.register({ id: SECTION, title: 'GitHub', ui: SECTION, settings: [], value: STATUS, description: "Pull requests on threads, through this machine's gh." })
      /** What's wrong with gh for every pull request, while it's missing or signed out. */
      let ghProblem: GhProblem | undefined
      let recheckAt = 0
      /** gh as last asked, and what went wrong lately besides (a save, a poll, a branch looked at): Settings says both. */
      let ghNow: GhStatus | null = null
      const troubles = new Map<string, string>()
      const showStatus = () => status.set(ghNow && { ...ghNow, ...(troubles.size ? { troubles: [...troubles.values()] } : {}) })
      /** Show what's wrong with `what` in Settings, or, with no message, that it's gone right again. */
      const show = (what: string, message?: string) => {
        if (message === undefined ? !troubles.delete(what) : troubles.get(what) === message) return
        if (message !== undefined) troubles.set(what, message)
        showStatus()
      }
      /** Say what went wrong with `what` (logged too), or, with no message, that it's gone right again. */
      const trouble = (what: string, message?: string, error?: unknown) => {
        if (message !== undefined) console.error(`github: ${message}`, ...(error === undefined ? [] : [error]))
        show(what, message)
      }
      const messageOf = (error: unknown) => error instanceof Error ? error.message : String(error)
      /** Whether gh is to be asked about a host's pull requests: github.com, or one it's signed in to (`gh auth status`). */
      const known = (host: string) => host === 'github.com' || Boolean(ghNow?.hosts.some((h) => h.host.toLowerCase() === host))
      async function checkGh() {
        const now = Date.now()
        const next = await ghStatus(gh, now)
        ghNow = next
        showStatus()
        recheckAt = now + intervals.recheck
        const was = ghProblem
        ghProblem = !next.installed ? { kind: 'missing', message: next.problem ?? "gh isn't installed" }
          : next.problem ? { kind: 'signed-out', message: next.problem } : undefined
        if (ghProblem && !same(was, ghProblem)) console.error(`github: ${ghProblem.message}; pull requests aren't followed until it is.`)
        if (!same(was, ghProblem)) await publishAll()
        return next
      }

      // ── What's known of each pull request, kept across restarts ─────────────────────────────────────────────────
      const entries = new Map<PrKey, Entry>()
      /** Each pull request's own problem (not found, a failed fetch): said in its summary until it's fetched. */
      const problems = new Map<PrKey, GhProblem>()
      /** What's kept of each in prs.json: as last fetched, and the events told of it. */
      type Kept = { detail: PrDetail; told?: string[] }
      // What's wrong with it (unread and kept aside, a save that failed) is said in Settings, with gh's status.
      const store = superego.jsonFile<Record<PrKey, Kept>>('prs.json', {
        empty: {},
        check: (data) => data && typeof data === 'object' && !Array.isArray(data) ? undefined : 'it has no pull requests by key',
        trouble: (message) => show('store', message), // logged by the store
      })
      // Unreadable, it's kept aside, and what it kept is fetched again (its told events lost: a first fetch's aren't news).
      const loaded = store.read().then((kept) => {
        for (const [key, { detail, told }] of Object.entries(kept)) {
          if (detail) entries.set(key, { detail, ...(detail.polledAt ? { checkedAt: detail.polledAt } : {}), ...(told ? { told } : {}) })
        }
      })
      /** What's known of every pull request a thread has, saved (saves made while one writes go as one). */
      const save = () => {
        store.save(() => Object.fromEntries([...entries].flatMap(([key, e]): [PrKey, Kept][] => e.detail && linked.has(key)
          ? [[key, { detail: e.detail, ...(e.told?.length ? { told: e.told } : {}) }]] : [])))
          .catch(() => { /* said in Settings by the store's `trouble` (and logged) */ })
      }
      const entry = (key: PrKey) => entries.get(key) ?? entries.set(key, {}).get(key)!

      // ── Which threads have which pull request ────────────────────────────────────────────────────────────────────
      const linked = new Map<PrKey, Set<string>>()
      const archived = new Set<string>()
      /** A thread's state, or nothing for one that's gone (deleted since it was named): nothing to show for it then. */
      const keptOf = (id: string) => state.get(id).catch((error: unknown) => {
        if (!(error instanceof RpcError && error.kind === 'not_found')) console.error(`github: reading thread ${id}'s pull requests failed:`, error)
        return undefined
      })
      /** A thread, or nothing for one that's gone (its kind as keptOf's). */
      const threadOf = (id: string) => superego.threads.get(id).catch((error: unknown) => {
        if (!(error instanceof RpcError && error.kind === 'not_found')) console.error(`github: reading thread ${id} failed:`, error)
        return undefined
      })
      const link = (key: PrKey, thread: string) => (linked.get(key) ?? linked.set(key, new Set()).get(key)!).add(thread)
      const unlink = (key: PrKey, thread: string) => { linked.get(key)?.delete(thread); if (!linked.get(key)?.size) linked.delete(key) }
      const indexed = (async () => {
        await loaded
        const lists = await Promise.all([superego.threads.list(), superego.threads.list({ archived: true })])
        for (const thread of lists.flat()) {
          if (signal.aborted) return
          if (thread.archived) archived.add(thread.id)
          const kept = await keptOf(thread.id)
          for (const pr of kept?.prs ?? []) link(pr.key, thread.id)
        }
      })()

      /** The summary of `key` written into every thread that has it, where it changed. */
      async function publish(key: PrKey) {
        const summary = summaryOf(key, entries.get(key), problems.get(key) ?? ghProblem)
        for (const thread of linked.get(key) ?? []) {
          const kept = await keptOf(thread)
          if (!kept?.prs.some((p) => p.key === key) || same(kept.summaries[key], summary)) continue
          await state.update(thread, (s) => s && { ...s, summaries: { ...s.summaries, [key]: summary } })
            .then(() => trouble(`update ${thread}`), (error: unknown) => trouble(`update ${thread}`, `updating thread ${thread}'s pull requests failed: ${messageOf(error)}`, error))
        }
      }
      const publishAll = async () => { for (const key of [...linked.keys()]) await publish(key) }

      // ── Attaching and detaching ──────────────────────────────────────────────────────────────────────────────────
      /** Attach a pull request to a thread; by itself (`created`, `branch`) never one detached there by hand. Whether it was. */
      async function attach(thread: string, url: string, how: How): Promise<PrSummary> {
        const ref = parsePr(url)
        if (!ref) throw new RpcError('invalid', `Not a pull request's URL: ${url}`)
        let added = false
        let refused = false
        await state.update(thread, (s) => {
          const kept = s ?? empty()
          if (kept.prs.some((p) => p.key === ref.key)) return kept
          if (kept.detached.includes(ref.key) && (how === 'created' || how === 'branch')) { refused = true; return kept }
          added = true
          const pr: PrLink = { key: ref.key, url: ref.url, how, at: Date.now() }
          return {
            ...kept, prs: [...kept.prs, pr], detached: kept.detached.filter((k) => k !== ref.key),
            summaries: { ...kept.summaries, [ref.key]: summaryOf(ref.key, entries.get(ref.key), problems.get(ref.key) ?? ghProblem) },
          }
        })
        if (!refused) {
          link(ref.key, thread)
          if (!archived.has(thread)) entry(ref.key).hotUntil = Date.now() + intervals.hot
        }
        if (added) void poll([ref.key])
        return summaryOf(ref.key, entries.get(ref.key), problems.get(ref.key) ?? ghProblem)
      }

      /** Detach one (by key or URL) from a thread, and never attach it there again by itself. */
      async function detach(thread: string, pr: string) {
        const key = parsePr(pr)?.key ?? pr
        let had = false
        await state.update(thread, (s) => {
          const kept = s ?? empty()
          had = kept.prs.some((p) => p.key === key)
          const { [key]: _gone, ...summaries } = kept.summaries
          return { ...kept, prs: kept.prs.filter((p) => p.key !== key), detached: [...new Set([...kept.detached, key])], summaries }
        })
        unlink(key, thread)
        if (!had) throw new RpcError('not_found', `This thread has no pull request ${key}`)
      }

      // ── The poller ───────────────────────────────────────────────────────────────────────────────────────────────
      /** Per host: failures in a row, and until when it's left alone (but for what the user asks about now). */
      const holds = new Map<string, { failures: number; until: number }>()
      /** What the user asked about now (Refresh): asked even of a host that's held, or while gh isn't to be rechecked yet. */
      const pressed = new Set<PrKey>()
      let ticking: Promise<void> | undefined
      let again = false
      let timer: ReturnType<typeof setTimeout> | undefined
      const later = () => {
        if (signal.aborted) return
        clearTimeout(timer)
        timer = setTimeout(() => void poll(), intervals.tick)
      }

      /**
       * Ask about what's due now, `keys` among it whatever their schedule; a host that's held (backing off, rate-limited)
       * is left alone unless `asked` (the user's Refresh). Resolves once asked.
       */
      function poll(keys: PrKey[] = [], { asked = false } = {}): Promise<void> {
        for (const key of keys) { entry(key).forced = true; if (asked) pressed.add(key) }
        if (ticking) { again = true; return ticking }
        ticking = (async () => {
          await indexed
          do { again = false; await pollDue() } while (again && !signal.aborted)
        })().then(() => trouble('poll'), (error: unknown) => trouble('poll', `polling failed: ${messageOf(error)}`, error)).finally(() => { ticking = undefined; later() })
        return ticking
      }

      async function pollDue() {
        const now = Date.now()
        prune(now)
        // Not looked at while gh is missing or signed out, but every so often, and when asked.
        if (ghProblem || !ghNow) {
          if (!pressed.size && now < recheckAt && ghNow) return
          if (!(await checkGh()).installed || ghProblem) {
            for (const [key, e] of entries) if (e.forced) { e.forced = false; e.checkedAt = now }
            pressed.clear()
            return
          }
        }
        const wanted = [...entries.keys(), ...linked.keys()].filter((key, i, all) => all.indexOf(key) === i).filter((key) => {
          const e = entry(key)
          if (e.forced) return true
          // Only those an unarchived thread has.
          return [...linked.get(key) ?? []].some((t) => !archived.has(t)) && due(e, now, intervals)
        })
        const byHost = new Map<string, PrKey[]>()
        for (const key of wanted) {
          const host = refOf(key)?.host
          if (host) (byHost.get(host) ?? byHost.set(host, []).get(host)!).push(key)
        }
        for (const [host, keys] of byHost) {
          const hold = holds.get(host)
          if (hold && hold.until > now && !keys.some((k) => pressed.has(k))) continue
          // Those whose conversation is wanted (the pane's, pr_view's) asked apart, with it; the rest without.
          for (const conversation of [true, false]) {
            const these = keys.filter((k) => Boolean(entry(k).talking) === conversation)
            for (let i = 0; i < these.length && !signal.aborted; i += BATCH) await ask(host, these.slice(i, i + BATCH), { conversation })
          }
        }
      }

      /** Pull requests no thread has (⌘-clicked, looked at), forgotten an hour after they were last asked about. */
      function prune(now: number) {
        for (const [key, e] of entries) {
          if (!linked.has(key) && !e.forced && now - (e.checkedAt ?? now) > HOUR) { entries.delete(key); problems.delete(key) }
        }
      }

      /** One query to `host` for these pull requests (with `conversation`, theirs too); what it found published, what failed said. */
      async function ask(host: string, keys: PrKey[], { conversation = false } = {}) {
        const now = Date.now()
        for (const key of keys) { const e = entry(key); e.forced = false; e.talking = false; e.checkedAt = now; pressed.delete(key) }
        // A host gh isn't signed in to isn't asked: with GH_ENTERPRISE_TOKEN set, gh would send it that token.
        if (!known(host)) {
          const problem: GhProblem = { kind: 'unknown-host', message: `gh isn't signed in to ${host}: run \`gh auth login --hostname ${host}\` to follow its pull requests.` }
          for (const key of keys) { problems.set(key, problem); await publish(key) }
          return
        }
        try {
          const found = await fetchPrs(gh, host, keys.map((k) => refOf(k)!), now, { signal, conversation })
          for (const [key, talk] of found.conversations) entry(key).talk = talk
          holds.delete(host)
          if (found.remaining !== undefined && found.remaining < RESERVE && found.resetAt) {
            holds.set(host, { failures: 0, until: found.resetAt })
            console.error(`github: ${found.remaining} of the rate limit on ${host} left: waiting until ${new Date(found.resetAt).toISOString()}.`)
          }
          const news: [PrKey, PrDetail | undefined, PrDetail][] = []
          for (const [key, got] of found.prs) {
            if ('checkList' in got) { news.push([key, entry(key).detail, got]); entry(key).detail = got; problems.delete(key) } else problems.set(key, got)
            await publish(key)
          }
          save()
          for (const [key, was, now] of news) await tell(key, was, now)
        } catch (error) {
          if (signal.aborted) return
          const problem: GhProblem = error instanceof GhError ? error.problem : { kind: 'failed', message: (error as Error).message }
          if (problem.kind === 'missing' || problem.kind === 'signed-out') { await checkGh(); return }
          const failures = (holds.get(host)?.failures ?? 0) + 1
          const until = error instanceof GhError && error.retryAt ? error.retryAt : now + backoff(failures, intervals)
          holds.set(host, { failures, until })
          console.error(`github: asking ${host} about ${keys.length} pull request${keys.length === 1 ? '' : 's'} failed (${problem.message}); again at ${new Date(until).toISOString()}.`)
          for (const key of keys) { problems.set(key, problem); await publish(key) }
        }
      }

      // ── Telling: what happened to a pull request, to the threads that have it ───────────────────────────────────
      /**
       * What happened to `key` since it was last fetched, told to each unarchived thread that has it, once: a notice to
       * the user (failed checks, changes requested, approved, merged), and a wake for an agent that watches it (past
       * its thread's wake budget, the same notice without waking it). A watch ends once merged or closed, or, `until: 'checks'`, once they finish.
       */
      async function tell(key: PrKey, was: PrDetail | undefined, now: PrDetail) {
        const e = entry(key)
        const told = new Set(e.told ?? [])
        const events = eventsOf(was, now, told)
        if (!events.length) return
        e.told = [...told, ...events.flatMap((ev) => ev.keys)].slice(-TOLD)
        save()
        for (const thread of linked.get(key) ?? []) {
          if (archived.has(thread)) continue
          await tellThread(thread, key, now, events).then(() => trouble(`tell ${thread}`), (error: unknown) => trouble(`tell ${thread}`, `telling thread ${thread} about ${key} failed: ${messageOf(error)}`, error))
        }
      }

      async function tellThread(thread: string, key: PrKey, pr: PrDetail, events: PrEvent[]) {
        const link = (await keptOf(thread))?.prs.find((p) => p.key === key)
        if (!link) return
        const watch = link.watch
        const waking = watch ? events.filter((ev) => wakes(watch, ev)) : []
        const over = events.some((ev) => ev.kind === 'merged' || ev.kind === 'closed')
          || (watch?.until === 'checks' && waking.some((ev) => ev.kind === 'checks-failed' || ev.kind === 'checks-passed'))
        if (waking.length) {
          // One notice that wakes it: what happened (each event's headline), the agent told it all with pr_view's digest.
          // Past the thread's wake budget (`WAKES` an hour about this pull request), shown without waking it, saying so.
          const { held } = await superego.threads.notice(thread, { ...noticeOf(thread, pr, waking[0]!, { events: waking }), agent: wakeText(pr, waking, { stopped: over }), wake: { source: key, most: WAKES } })
          if (held) console.error(`github: not waking thread ${thread} about ${key}: ${held}`)
        }
        // Told the user: what always is, but what the agent's notice says.
        for (const ev of events.filter((ev) => NOTICED.has(ev.kind) && !waking.includes(ev))) {
          await superego.threads.notice(thread, noticeOf(thread, pr, ev))
        }
        if (watch && over) await setWatch(thread, key, undefined)
      }

      /**
       * A notice of an event: drawn by the UI half, with "Fix it" for what can be fixed, and Show. One that wakes the
       * agent (`events`, all it wakes it for, in its detail) has no Fix it: the agent's on it.
       */
      function noticeOf(thread: string, pr: PrDetail, event: PrEvent, { events }: { events?: PrEvent[] } = {}) {
        const all = events ?? [event]
        const lines = all.map((ev) => said(pr, ev))
        const { headline } = lines[0]!
        const detail = [lines[0]!.detail, ...lines.slice(1).map((l) => l.detail ? `${l.headline}: ${l.detail}` : l.headline)].filter(Boolean).join(' · ') || undefined
        const fix = events ? undefined : fixText(pr, event)
        const data: NoticeData = {
          event: event.kind, key: pr.key, url: pr.url, number: pr.number, headline, ...(detail ? { detail } : {}), ...(events ? { watched: true } : {}),
        }
        const text = detail ? `${headline}: ${detail}` : headline
        return {
          text, kind: NOTICE, data, agent: noticeForAgent(pr, event),
          actions: [
            ...(fix ? [{ label: 'Fix it', send: fix, style: 'primary' as const }] : []),
            { label: 'Show', action: 'pane.open', params: { thread, kind: PANE, params: { url: pr.url } } },
          ],
        }
      }

      /** Watch a thread's pull request (or stop, with none), as kept with the thread. */
      async function setWatch(thread: string, key: PrKey, watch: Watch | undefined) {
        let had = false
        await state.update(thread, (s) => {
          const kept = s ?? empty()
          had = kept.prs.some((p) => p.key === key)
          return { ...kept, prs: kept.prs.map((p) => {
            if (p.key !== key) return p
            const { watch: _was, ...rest } = p
            return watch ? { ...rest, watch } : rest
          }) }
        })
        if (!had) throw new RpcError('not_found', `This thread has no pull request ${key}`)
        if (watch) { entry(key).hotUntil = Date.now() + intervals.hot; void poll([key]) }
      }

      // ── A thread's branch ────────────────────────────────────────────────────────────────────────────────────────
      /**
       * A thread in a worktree of its own: the pull requests of its branch, attached, once the branch's upstream moved
       * since it last looked. Not a thread in the main checkout: that branch isn't the thread's.
       */
      async function lookAtBranch(id: string) {
        const thread = await threadOf(id)
        const tree = thread?.facts?.worktrees as { branch?: string; removed?: boolean } | undefined
        if (!thread || thread.archived || !tree?.branch || tree.removed || ghProblem) return
        const what = `branch ${id}`
        let upstream: string
        try {
          upstream = await git(thread.cwd, ['rev-parse', '-q', '--verify', '@{upstream}'])
        } catch (error) {
          // Exit 1: no upstream, so not pushed, and no pull request yet. Anything else is git failing.
          if ((error as { code?: unknown }).code !== 1) trouble(what, `looking at ${tree.branch}'s upstream failed: ${messageOf(error)}`, error)
          return
        }
        if (!upstream || (await state.get(id))?.looked === upstream) return
        let urls: string[]
        try {
          urls = await prsOfBranch(gh, thread.cwd, tree.branch, signal)
        } catch (error) {
          // gh missing or signed out: Settings says so, and it's looked at again once it's fixed.
          if (error instanceof GhError && (error.problem.kind === 'missing' || error.problem.kind === 'signed-out')) { await checkGh(); return }
          if (!signal.aborted) trouble(what, `looking for ${tree.branch}'s pull request failed: ${messageOf(error)}`)
          return
        }
        trouble(what)
        for (const url of urls) await attach(id, url, 'branch')
        await state.update(id, (s) => ({ ...s ?? empty(), looked: upstream }))
      }
      const settling = new Map<string, ReturnType<typeof setTimeout>>()
      const lookSoon = (id: string, ms = intervals.settle) => {
        clearTimeout(settling.get(id))
        settling.set(id, setTimeout(() => {
          settling.delete(id)
          void lookAtBranch(id).catch((error: unknown) => trouble(`branch ${id}`, `looking at thread ${id}'s branch failed: ${messageOf(error)}`, error))
        }, ms))
      }
      /**
       * A thread's pull requests, hot (asked about often); `now`, asked about now too (it pushed), a held host still
       * left alone. Else asked about once they're due, as hot ones are soon.
       */
      async function stir(id: string, { now = false } = {}) {
        const kept = await keptOf(id)
        const keys = kept?.prs.map((p) => p.key) ?? []
        for (const key of keys) entry(key).hotUntil = Date.now() + intervals.hot
        if (keys.length) await poll(now ? keys : [])
      }
      const stirred = (id: string, now?: boolean) => {
        stir(id, { now }).catch((error: unknown) => trouble('poll', `polling thread ${id}'s pull requests failed: ${messageOf(error)}`, error))
      }

      superego.thread({
        started(thread) { lookSoon(thread.id, 0) },
        turnEnd(thread) {
          lookSoon(thread.id)
          stirred(thread.id)
        },
        archived(thread) { archived.add(thread.id) },
        unarchived(thread) { archived.delete(thread.id); stirred(thread.id, true) },
      })

      // What the agent runs: a pull request it opened, attached; a push, its pull requests asked about now.
      superego.toolCalls(async ({ thread, call, result }) => {
        if (call.name !== 'bash') return
        const command = String((call.args as { command?: unknown } | null)?.command ?? '')
        if (/\bgh\s+pr\s+create\b/.test(command) && !result.isError) {
          for (const ref of prsIn(result.text ?? '')) await attach(thread, ref.url, 'created')
        }
        if (/\bgit\s+push\b|\bgh\s+pr\b/.test(command)) {
          lookSoon(thread, 0)
          await stir(thread, { now: true })
        }
      })

      // ── The window's reads and actions ───────────────────────────────────────────────────────────────────────────
      /**
       * A pull request as now known, asked about first when it never was (or, merged or closed, not lately); with
       * `conversation`, its description and conversation too, fetched with it unless they were within `intervals.fast`.
       * No conversation when it couldn't be fetched: the detail's `error` says why.
       */
      async function view(key: PrKey, fresh: boolean, { conversation = false } = {}): Promise<{ detail: PrDetail; conversation?: Conversation }> {
        const e = entries.get(key)
        const terminal = e?.detail?.state === 'merged' || e?.detail?.state === 'closed'
        const talk = conversation && (fresh || !e?.talk || Date.now() - e.talk.fetchedAt > intervals.fast)
        if (talk) entry(key).talking = true
        if (talk || fresh || !e?.detail || (terminal && Date.now() - (e.checkedAt ?? 0) > intervals.slow) || (!linked.has(key) && due(e, Date.now(), intervals))) await poll([key])
        const after = entries.get(key)
        const summary = summaryOf(key, after, problems.get(key) ?? ghProblem)
        const detail = { checkList: [], reviews: [], comments: [], ...after?.detail, ...summary }
        return { detail, ...(conversation && after?.talk ? { conversation: after.talk } : {}) }
      }
      async function threadsOf(key: PrKey) {
        await indexed
        return Promise.all([...linked.get(key) ?? []].map(async (id) => {
          const thread = await threadOf(id)
          return thread && { id, title: thread.title, archived: Boolean(thread.archived) }
        })).then((all) => all.filter((t) => t !== undefined))
      }
      superego.method(PR, async ({ url, fresh, conversation }): Promise<PrView> => {
        const ref = parsePr(url)
        if (!ref) throw new RpcError('invalid', `Not a pull request's URL: ${url}`)
        const { detail, conversation: talk } = await view(ref.key, fresh === true, { conversation: conversation === true })
        return { pr: detail, threads: await threadsOf(ref.key), ...(talk ? { conversation: talk } : {}) }
      }, { params: obj({ url: str(), fresh: opt(bool()), conversation: opt(bool()) }) })

      superego.action(defineAction({
        id: ATTACH, title: 'Attach a pull request', expose: ['ui', 'cli'], description: "Attach a pull request to a thread by its URL: its state shows on the thread, and it's followed.",
        params: obj({ thread: str(), url: str() }),
        async run({ thread, url }) { await superego.threads.get(thread); return attach(thread, url, 'hand') },
      }))
      superego.action(defineAction({
        id: DETACH, title: 'Detach a pull request', expose: ['ui', 'cli'], description: "Detach a pull request from a thread (by its URL or key): it's no longer shown there, nor attached again by itself.",
        params: obj({ thread: str(), pr: str() }),
        async run({ thread, pr }) { await detach(thread, pr); return null },
      }))
      const watchParams = { checks: opt(bool()), reviews: opt(bool()), until: opt(lit('checks')) }
      superego.action(defineAction({
        id: WATCH, title: 'Watch a pull request', expose: ['ui', 'cli'], description: "Wake a thread's agent when its pull request's checks finish or it's reviewed (both unless said; `until: 'checks'`, once its checks finish), until it's merged or closed.",
        params: obj({ thread: str(), pr: str(), ...watchParams }),
        async run({ thread, pr, checks, reviews, until }) {
          const key = parsePr(pr)?.key ?? pr
          const watch = watchOf(checks, reviews, until)
          await setWatch(thread, key, watch)
          return watch
        },
      }))
      superego.action(defineAction({
        id: UNWATCH, title: 'Stop watching a pull request', expose: ['ui', 'cli'], description: "Stop waking a thread's agent about its pull request.",
        params: obj({ thread: str(), pr: str() }),
        async run({ thread, pr }) { await setWatch(thread, parsePr(pr)?.key ?? pr, undefined); return null },
      }))
      superego.action(defineAction({
        id: REFRESH, title: 'Refresh pull requests', expose: ['ui', 'cli'], description: "Ask GitHub now: about a pull request (by URL), a thread's, or every one; and look at gh again.",
        params: obj({ thread: opt(str()), pr: opt(str()) }),
        async run({ thread, pr }) {
          await checkGh()
          const keys = pr ? [parsePr(pr)?.key ?? pr] : thread ? (await state.get(thread))?.prs.map((p) => p.key) ?? [] : [...linked.keys()]
          if (thread) lookSoon(thread, 0)
          await poll(keys, { asked: true })
          return status.get()
        },
      }))

      // ── The agent ────────────────────────────────────────────────────────────────────────────────────────────────
      const threadOfCall = (conversationId: unknown) => {
        const id = superego.threads.of(conversationId as never)
        if (!id) throw new Error('This tool works in a Superego thread only')
        return id
      }
      /** The thread's pull request a tool names (URL, owner/repo#N, #N), or the one leading its list. */
      async function named(thread: string, pr: string | undefined): Promise<PrKey> {
        if (pr && parsePr(pr)) return parsePr(pr)!.key
        const kept = await state.get(thread)
        const facts = [...kept?.prs ?? []].sort((a, b) => b.at - a.at).map((p) => kept!.summaries[p.key] ?? summaryOf(p.key, undefined, undefined))
        if (!pr) {
          const first = lead(facts)
          if (!first) throw new Error('This thread has no pull request. Attach one with pr_attach, or name one by its URL.')
          return first.key
        }
        const m = /^(?:([\w.-]+\/[\w.-]+))?#?(\d+)$/.exec(pr.trim())
        const found = m && facts.find((f) => f.number === Number(m[2]) && (!m[1] || f.repo.toLowerCase() === m[1].toLowerCase()))
        if (!found) throw new Error(`This thread has no pull request ${pr}: name it by its URL.`)
        return found.key
      }
      superego.agent(defineExtension({
        name: 'github',
        tools: [
          defineTool({
            name: VIEW_TOOL,
            description: "Look at a GitHub pull request: its state, description, checks (a failed one's run and the command for its logs), reviews, conversation and unresolved review comments. Without `pr`, the thread's own.",
            parameters: obj({ pr: opt(str({ description: "a pull request's URL, owner/repo#123 or #123 (one of the thread's); default: the thread's" })) }),
            replay: 'safe',
            async execute({ pr }, api) {
              const thread = threadOfCall(api.conversationId)
              const key = await named(thread, pr)
              const e = entries.get(key)
              const { detail, conversation } = await view(key, !e?.checkedAt || Date.now() - e.checkedAt > intervals.fast, { conversation: true })
              return { output: [{ type: 'text', text: digest(detail, conversation) }], details: { key, url: detail.url, state: detail.state ?? null } }
            },
          }),
          defineTool({
            name: ATTACH_TOOL,
            description: "Attach a GitHub pull request to this thread by its URL, when the user says it's this thread's (one opened by `gh pr create` here is attached by itself). Its state then shows on the thread.",
            parameters: obj({ url: str({ description: "the pull request's URL" }) }),
            async execute({ url }, api) {
              const thread = threadOfCall(api.conversationId)
              const ref = parsePr(url)
              if (ref) {
                if (!ghNow) await checkGh()
                if (!known(ref.host)) throw new Error(`gh isn't signed in to ${ref.host}, so its pull requests can't be followed. The user can run \`gh auth login --hostname ${ref.host}\`.`)
              }
              const summary = await attach(thread, url, 'agent')
              return { output: [{ type: 'text', text: `Attached ${summary.repo}#${summary.number} to this thread.` }], details: { key: summary.key, url: summary.url } }
            },
          }),
          defineTool({
            name: WATCH_TOOL,
            description: "Be woken when this thread's pull request's checks finish or it's reviewed (a notice tells you what happened), "
              + "instead of waiting on it yourself. Both unless said; `until: 'checks'` wakes you once, when its checks finish. Watching ends once it's merged or closed. `stop: true` stops it.",
            parameters: obj({
              pr: opt(str({ description: "a pull request's URL, owner/repo#123 or #123 (one of the thread's); default: the thread's" })),
              checks: opt(bool({ description: 'woken when its checks finish (passed or failed); default true' })),
              reviews: opt(bool({ description: "woken when it's reviewed or gets review comments; default true" })),
              until: opt(lit('checks', { description: "'checks': once, when its checks next finish" })),
              stop: opt(bool({ description: 'stop watching it' })),
            }),
            async execute({ pr, checks, reviews, until, stop }, api) {
              const thread = threadOfCall(api.conversationId)
              const key = await named(thread, pr)
              if (stop) {
                await setWatch(thread, key, undefined)
                return { output: [{ type: 'text', text: `No longer watching ${key}.` }], details: { key, watch: null } }
              }
              const watch = watchOf(checks, reviews, until)
              if (watch.checks === false && watch.reviews === false) throw new Error('Watching for neither checks nor reviews: say one, or stop: true.')
              await setWatch(thread, key, watch)
              const state = entries.get(key)?.detail?.state
              const ended = state === 'merged' || state === 'closed' ? ` It's ${state} already: nothing more will happen.` : ''
              return {
                output: [{ type: 'text', text: `Watching ${key} for ${watchWord(watch)}: you'll be woken with what happened. Don't wait on it yourself.${ended}` }],
                details: { key, watch },
              }
            },
          }),
          defineTool({
            name: DETACH_TOOL,
            description: "Detach a pull request from this thread: it's no longer shown here, nor attached again by itself.",
            parameters: obj({ pr: str({ description: "the pull request's URL, owner/repo#123 or #123" }) }),
            async execute({ pr }, api) {
              const thread = threadOfCall(api.conversationId)
              const key = await named(thread, pr)
              await detach(thread, key)
              return { output: [{ type: 'text', text: `Detached ${key} from this thread.` }], details: { key } }
            },
          }),
        ],
        // Which pull requests, and how to look: never how they stand, which would change it, and the prompt's cache with it.
        sections: [section(PROMPT_SECTION, async ({ conversationId }) => {
          const id = superego.threads.of(conversationId)
          const kept = id ? await keptOf(id) : undefined
          return promptLine([...kept?.prs ?? []].sort((a, b) => b.at - a.at).flatMap((p) => refOf(p.key) ?? []))
        })],
      }))

      // ── Starting ─────────────────────────────────────────────────────────────────────────────────────────────────
      // gh looked at, then every thread in a worktree of its own looked at for its branch's pull request, one at a time.
      void (async () => {
        await checkGh()
        await indexed
        later()
        for (const thread of await superego.threads.list() as ThreadInfo[]) {
          if (signal.aborted) return
          await lookAtBranch(thread.id).catch((error: unknown) => trouble(`branch ${thread.id}`, `looking at thread ${thread.id}'s branch failed: ${messageOf(error)}`, error))
        }
      })().catch((error: unknown) => { if (!signal.aborted) trouble('start', `starting failed: ${messageOf(error)}`, error) })

      return async () => {
        clearTimeout(timer)
        for (const t of settling.values()) clearTimeout(t)
        await ticking
      }
    },
  })
}

export default githubExtension()
