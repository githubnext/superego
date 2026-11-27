// github, daemon half: a thread's pull requests. Attached by themselves (the thread's agent ran `gh pr create`; a thread
// in a worktree of its own pushed a branch that has one) or by hand (the window, `pr_attach`), and detached by hand
// (never attached again by themselves then). Each kept with its thread (`superego.state`) and shown as its facts
// (`facts.github`), the summary the marks draw. One poller per machine asks this machine's `gh` about every pull
// request its threads have, in one GraphQL query per host: often while checks run or something just happened, rarely
// otherwise, never once merged or closed; backing off a failing host, waiting out a rate limit, and resting while gh
// is missing or signed out (Settings says so, and each pull request's tooltip). The full snapshot of each (checks,
// reviews, comments) is kept once per machine, in `<dir>/prs.json`, for the pane and the agent (`pr_view`, its prompt).
import { execFile } from 'node:child_process'
import { readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { defineExtension, defineTool, section } from '@earendil-works/pi-durable'
import { bool, obj, opt, str } from '@earendil-works/pi-schema'
import { defineAction, defineDaemonExtension } from '@superego/daemon'
import { RpcError, type ThreadInfo } from '@superego/protocol'
import { digest, promptLine } from './digest.ts'
import { fetchPrs, ghRunner, ghStatus, GhError, prsOfBranch, type Gh } from './gh.ts'
import { backoff, due, INTERVALS, type Entry, type Intervals } from './schedule.ts'
import {
  about, ATTACH, ATTACH_TOOL, DETACH, DETACH_TOOL, lead, parsePr, PR, PROMPT_SECTION, prsIn, REFRESH, refOf, SECTION, STATUS, VIEW_TOOL,
  type GhProblem, type GhStatus, type GithubFacts, type GithubState, type How, type PrDetail, type PrKey, type PrLink, type PrSummary, type PrView,
} from './shared.ts'

export type GithubOptions = {
  /** The environment gh runs in (its PATH finds it): the login shell's unless given (a test's fake gh). */
  env?: () => NodeJS.ProcessEnv | Promise<NodeJS.ProcessEnv>
  /** How often it asks (shorter, in a test). */
  intervals?: Partial<Intervals>
}

const empty = (): GithubState => ({ prs: [], detached: [], summaries: {} })
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
/** How many pull requests go in one query. */
const BATCH = 25
/** Below this much of the rate limit left, a host waits for it to reset. */
const RESERVE = 50

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
        const prs = [...state.prs].sort((a, b) => b.at - a.at).map((link) => ({ ...state.summaries[link.key] ?? summaryOf(link.key, undefined, undefined), how: link.how, at: link.at }))
        return { prs } satisfies GithubFacts
      })

      // ── gh's status (Settings) ───────────────────────────────────────────────────────────────────────────────────
      const status = superego.value<GhStatus | null>(STATUS, null)
      superego.settings.register({ id: SECTION, title: 'GitHub', ui: SECTION, settings: [], value: STATUS, description: "Pull requests on threads, through this machine's gh." })
      /** What's wrong with gh for every pull request, while it's missing or signed out. */
      let ghProblem: GhProblem | undefined
      let recheckAt = 0
      async function checkGh() {
        const now = Date.now()
        const next = await ghStatus(gh, now)
        status.set(next)
        recheckAt = now + intervals.recheck
        const was = ghProblem
        ghProblem = !next.installed ? { kind: 'missing', message: next.problem ?? "gh isn't installed" }
          : next.problem ? { kind: 'signed-out', message: next.problem } : undefined
        if (ghProblem && !same(was, ghProblem)) console.error(`github: ${ghProblem.message}; pull requests aren't followed until it is.`)
        if (!same(was, ghProblem)) await publishAll()
        return next
      }

      // ── What's known of each pull request, kept across restarts ─────────────────────────────────────────────────
      const file = join(superego.dir, 'prs.json')
      const entries = new Map<PrKey, Entry>()
      /** Each pull request's own problem (not found, a failed fetch): said in its summary until it's fetched. */
      const problems = new Map<PrKey, GhProblem>()
      const loaded = readFile(file, 'utf8').then((text) => {
        for (const [key, detail] of Object.entries(JSON.parse(text) as Record<string, PrDetail>)) entries.set(key, { detail, ...(detail.polledAt ? { checkedAt: detail.polledAt } : {}) })
      }, (error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') console.error(`github: reading ${file} failed:`, error) })
      let saving: ReturnType<typeof setTimeout> | undefined
      /** Written now: what's known of every pull request a thread has. */
      const flush = () => {
        clearTimeout(saving)
        saving = undefined
        const kept = Object.fromEntries([...entries].flatMap(([key, e]) => e.detail && linked.has(key) ? [[key, e.detail]] : []))
        const temp = `${file}.${process.pid}.tmp`
        return writeFile(temp, JSON.stringify(kept)).then(() => rename(temp, file)).catch((error: unknown) => console.error(`github: saving ${file} failed:`, error))
      }
      const save = () => { saving ??= setTimeout(() => void flush(), 500) }
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
            .catch((error: unknown) => console.error(`github: updating thread ${thread} failed:`, error))
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
      /** Per host: failures in a row, and until when it's left alone. */
      const holds = new Map<string, { failures: number; until: number }>()
      let ticking: Promise<void> | undefined
      let again = false
      let timer: ReturnType<typeof setTimeout> | undefined
      const later = () => {
        if (signal.aborted) return
        clearTimeout(timer)
        timer = setTimeout(() => void poll(), intervals.tick)
      }

      /** Ask about what's due now, `keys` among it whatever their schedule. Resolves once asked. */
      function poll(keys: PrKey[] = []): Promise<void> {
        for (const key of keys) entry(key).forced = true
        if (ticking) { again = true; return ticking }
        ticking = (async () => {
          await indexed
          do { again = false; await pollDue() } while (again && !signal.aborted)
        })().catch((error: unknown) => console.error('github: polling failed:', error)).finally(() => { ticking = undefined; later() })
        return ticking
      }

      async function pollDue() {
        const now = Date.now()
        const forced = [...entries].filter(([, e]) => e.forced).map(([key]) => key)
        // Not looked at while gh is missing or signed out, but every so often, and when asked.
        if (ghProblem || !status.get()) {
          if (!forced.length && now < recheckAt && status.get()) return
          if (!(await checkGh()).installed || ghProblem) {
            for (const key of forced) { entry(key).forced = false; entry(key).checkedAt = now }
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
          const asked = keys.some((k) => entry(k).forced)
          if (hold && hold.until > now && !asked) continue
          for (let i = 0; i < keys.length && !signal.aborted; i += BATCH) await ask(host, keys.slice(i, i + BATCH))
        }
      }

      /** One query to `host` for these pull requests; what it found published, what failed said. */
      async function ask(host: string, keys: PrKey[]) {
        const now = Date.now()
        for (const key of keys) { const e = entry(key); e.forced = false; e.checkedAt = now }
        try {
          const found = await fetchPrs(gh, host, keys.map((k) => refOf(k)!), now, signal)
          holds.delete(host)
          if (found.remaining !== undefined && found.remaining < RESERVE && found.resetAt) {
            holds.set(host, { failures: 0, until: found.resetAt })
            console.error(`github: ${found.remaining} of the rate limit on ${host} left: waiting until ${new Date(found.resetAt).toISOString()}.`)
          }
          for (const [key, got] of found.prs) {
            if ('checkList' in got) { entry(key).detail = got; problems.delete(key) } else problems.set(key, got)
            await publish(key)
          }
          save()
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

      // ── A thread's branch ────────────────────────────────────────────────────────────────────────────────────────
      /**
       * A thread in a worktree of its own: the pull requests of its branch, attached, once the branch's upstream moved
       * since it last looked. Not a thread in the main checkout: that branch isn't the thread's.
       */
      async function lookAtBranch(id: string) {
        const thread = await threadOf(id)
        const tree = thread?.facts?.worktrees as { branch?: string; removed?: boolean } | undefined
        if (!thread || thread.archived || !tree?.branch || tree.removed || ghProblem) return
        // No upstream: not pushed, so no pull request yet.
        const upstream = await git(thread.cwd, ['rev-parse', '-q', '--verify', '@{upstream}']).catch(() => undefined)
        if (!upstream || (await state.get(id))?.looked === upstream) return
        let urls: string[]
        try {
          urls = await prsOfBranch(gh, thread.cwd, tree.branch, signal)
        } catch (error) {
          // gh missing or signed out: Settings says so, and it's looked at again once it's fixed.
          if (error instanceof GhError && (error.problem.kind === 'missing' || error.problem.kind === 'signed-out')) { await checkGh(); return }
          if (!signal.aborted) console.error(`github: looking for ${tree.branch}'s pull request failed:`, (error as Error).message)
          return
        }
        for (const url of urls) await attach(id, url, 'branch')
        await state.update(id, (s) => ({ ...s ?? empty(), looked: upstream }))
      }
      const settling = new Map<string, ReturnType<typeof setTimeout>>()
      const lookSoon = (id: string, ms = intervals.settle) => {
        clearTimeout(settling.get(id))
        settling.set(id, setTimeout(() => {
          settling.delete(id)
          void lookAtBranch(id).catch((error: unknown) => console.error(`github: thread ${id}'s branch:`, error))
        }, ms))
      }
      /** A thread's pull requests, hot (asked about often) and asked about now. */
      async function stir(id: string) {
        const kept = await keptOf(id)
        const keys = kept?.prs.map((p) => p.key) ?? []
        for (const key of keys) entry(key).hotUntil = Date.now() + intervals.hot
        if (keys.length) await poll(keys)
      }

      superego.thread({
        started(thread) { lookSoon(thread.id, 0) },
        turnEnd(thread) {
          lookSoon(thread.id)
          void stir(thread.id)
        },
        archived(thread) { archived.add(thread.id) },
        unarchived(thread) { archived.delete(thread.id); void stir(thread.id) },
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
          await stir(thread)
        }
      })

      // ── The window's reads and actions ───────────────────────────────────────────────────────────────────────────
      /** A pull request as now known, asked about first when it never was (or, merged or closed, not lately). */
      async function view(key: PrKey, fresh: boolean): Promise<PrDetail> {
        const e = entries.get(key)
        const terminal = e?.detail?.state === 'merged' || e?.detail?.state === 'closed'
        if (fresh || !e?.detail || (terminal && Date.now() - (e.checkedAt ?? 0) > intervals.slow) || (!linked.has(key) && due(e, Date.now(), intervals))) await poll([key])
        const after = entries.get(key)
        const summary = summaryOf(key, after, problems.get(key) ?? ghProblem)
        return { checkList: [], reviews: [], comments: [], ...after?.detail, ...summary }
      }
      async function threadsOf(key: PrKey) {
        await indexed
        return Promise.all([...linked.get(key) ?? []].map(async (id) => {
          const thread = await threadOf(id)
          return thread && { id, title: thread.title, archived: Boolean(thread.archived) }
        })).then((all) => all.filter((t) => t !== undefined))
      }
      superego.method(PR, async ({ url, fresh }): Promise<PrView> => {
        const ref = parsePr(url)
        if (!ref) throw new RpcError('invalid', `Not a pull request's URL: ${url}`)
        return { pr: await view(ref.key, fresh === true), threads: await threadsOf(ref.key) }
      }, { params: obj({ url: str(), fresh: opt(bool()) }) })

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
      superego.action(defineAction({
        id: REFRESH, title: 'Refresh pull requests', expose: ['ui', 'cli'], description: "Ask GitHub now: about a pull request (by URL), a thread's, or every one; and look at gh again.",
        params: obj({ thread: opt(str()), pr: opt(str()) }),
        async run({ thread, pr }) {
          await checkGh()
          const keys = pr ? [parsePr(pr)?.key ?? pr] : thread ? (await state.get(thread))?.prs.map((p) => p.key) ?? [] : [...linked.keys()]
          if (thread) lookSoon(thread, 0)
          await poll(keys)
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
            description: "Look at a GitHub pull request: its state, checks (a failed one's run and the command for its logs), reviews and unresolved review comments. Without `pr`, the thread's own.",
            parameters: obj({ pr: opt(str({ description: "a pull request's URL, owner/repo#123 or #123 (one of the thread's); default: the thread's" })) }),
            replay: 'safe',
            async execute({ pr }, api) {
              const thread = threadOfCall(api.conversationId)
              const key = await named(thread, pr)
              const e = entries.get(key)
              const detail = await view(key, !e?.checkedAt || Date.now() - e.checkedAt > intervals.fast)
              return { output: [{ type: 'text', text: digest(detail) }], details: { key, url: detail.url, state: detail.state ?? null } }
            },
          }),
          defineTool({
            name: ATTACH_TOOL,
            description: "Attach a GitHub pull request to this thread by its URL, when the user says it's this thread's (one opened by `gh pr create` here is attached by itself). Its state then shows on the thread.",
            parameters: obj({ url: str({ description: "the pull request's URL" }) }),
            async execute({ url }, api) {
              const thread = threadOfCall(api.conversationId)
              const summary = await attach(thread, url, 'agent')
              return { output: [{ type: 'text', text: `Attached ${summary.repo}#${summary.number} to this thread.` }], details: { key: summary.key, url: summary.url } }
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
        sections: [section(PROMPT_SECTION, async ({ conversationId }) => {
          const id = superego.threads.of(conversationId)
          const kept = id ? await keptOf(id) : undefined
          if (!kept?.prs.length) return undefined
          return promptLine([...kept.prs].sort((a, b) => b.at - a.at).map((p) => {
            const detail = entries.get(p.key)?.detail
            return { summary: kept.summaries[p.key] ?? summaryOf(p.key, entries.get(p.key), ghProblem), ...(detail ? { detail } : {}) }
          }))
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
          await lookAtBranch(thread.id).catch((error: unknown) => console.error(`github: thread ${thread.id}'s branch:`, error))
        }
      })().catch((error: unknown) => { if (!signal.aborted) console.error('github: starting failed:', error) })

      return async () => {
        clearTimeout(timer)
        for (const t of settling.values()) clearTimeout(t)
        await ticking
        if (saving) await flush()
      }
    },
  })
}

export default githubExtension()
