// github, daemon half: GitHub through this machine's own `gh`, its one sign-in. Found on the login shell's PATH (a daemon
// started from the Dock lacks mise's and Homebrew's), run with no prompts, no terminal and a time limit. What it asks:
// who it's signed in as (`gh auth status`), the pull requests a branch has (`gh pr list`), and many pull requests at
// once (`gh api graphql`, every one aliased in one query per host), with the rate limit it reports. The same query, for
// the pane and `pr_view`, with the description and conversation too: the poll leaves those out, to stay small.
import { execFile } from 'node:child_process'
import { access, constants } from 'node:fs/promises'
import { delimiter, join } from 'node:path'
import { CONVERSATION, type Check, type Conversation, type GhProblem, type GhStatus, type Mergeable, type PrDetail, type PrRef, type Remark, type ReviewBy, type ReviewComment } from './shared.ts'

/** A finished `gh`: its exit code (null: it didn't start, or was killed) and what it wrote. */
export type GhRun = { code: number | null; stdout: string; stderr: string }
/** Runs `gh` with these arguments, in `cwd` if given. Throws a `GhError` of kind `missing` when there's no gh. */
export type Gh = (args: string[], options?: { cwd?: string; signal?: AbortSignal }) => Promise<GhRun>

/** A failure with what kind it is, and for a rate limit, when to try again (ms since the epoch). */
export class GhError extends Error {
  readonly problem: GhProblem
  readonly retryAt: number | undefined
  constructor(problem: GhProblem, retryAt?: number) {
    super(problem.message)
    this.problem = problem
    this.retryAt = retryAt
  }
}

/** How long one `gh` may take. */
const TIMEOUT = 20_000

/** `gh`'s path in a PATH, or undefined when it isn't on it. */
export async function findGh(path: string | undefined): Promise<string | undefined> {
  for (const dir of (path ?? '').split(delimiter).filter(Boolean)) {
    const file = join(dir, process.platform === 'win32' ? 'gh.exe' : 'gh')
    if (await access(file, constants.X_OK).then(() => true, () => false)) return file
  }
  return undefined
}

/** A `gh` runner over an environment (the login shell's): found again on each call while it isn't there. */
export function ghRunner(env: () => Promise<NodeJS.ProcessEnv>): Gh {
  return async (args, { cwd, signal } = {}) => {
    const vars = await env()
    const gh = await findGh(vars.PATH)
    if (!gh) throw new GhError({ kind: 'missing', message: "gh isn't installed" })
    return new Promise((done) => {
      execFile(gh, args, {
        cwd, signal, timeout: TIMEOUT, maxBuffer: 32 * 1024 * 1024,
        env: { ...vars, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', NO_COLOR: '1', GH_SPINNER_DISABLED: '1', CLICOLOR: '0' },
      }, (error, stdout, stderr) => {
        const code = error ? (typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : null) : 0
        done({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') || (code === null && error ? error.message : '') })
      }).stdin?.end()
    })
  }
}

/** What a failed `gh` said, as a problem: not signed in, rate-limited, or plainly failed. */
export function problemOf(run: GhRun, headers: Record<string, string> = {}): GhError {
  const said = (run.stderr.trim() || run.stdout.trim()).split('\n').filter(Boolean).slice(-3).join(' ').replace(/^gh: /, '') || `gh exited with ${run.code}`
  if (/gh auth login|not logged in|authentication required|HTTP 401|Bad credentials/i.test(said)) return new GhError({ kind: 'signed-out', message: said })
  if (/rate limit|HTTP 429|abuse|secondary/i.test(said) || headers['x-ratelimit-remaining'] === '0') {
    const retry = Number(headers['retry-after'])
    const reset = Number(headers['x-ratelimit-reset'])
    const retryAt = retry ? Date.now() + retry * 1000 : reset ? reset * 1000 : undefined
    return new GhError({ kind: 'rate-limited', message: said }, retryAt)
  }
  return new GhError({ kind: 'failed', message: said })
}

/** `gh api -i`'s output taken apart: the headers (lowercased) and the body. */
export function splitResponse(out: string): { status?: number; headers: Record<string, string>; body: string } {
  if (!out.startsWith('HTTP/')) return { headers: {}, body: out }
  const end = out.search(/\r?\n\r?\n/)
  const head = end < 0 ? out : out.slice(0, end)
  const body = end < 0 ? '' : out.slice(end).replace(/^\r?\n\r?\n/, '')
  const [status, ...lines] = head.split(/\r?\n/)
  const headers: Record<string, string> = {}
  for (const line of lines) {
    const at = line.indexOf(':')
    if (at > 0) headers[line.slice(0, at).trim().toLowerCase()] = line.slice(at + 1).trim()
  }
  return { status: Number(/^HTTP\/[\d.]+ (\d+)/.exec(status ?? '')?.[1]) || undefined, headers, body }
}

// ── Who it's signed in as ────────────────────────────────────────────────────────────────────────────────────────
/** This machine's gh, as Settings says it. Never throws: what went wrong is its `problem`. */
export async function ghStatus(gh: Gh, now = Date.now()): Promise<GhStatus> {
  let version: string | undefined
  try {
    version = /gh version ([^\s]+)/.exec((await gh(['--version'])).stdout)?.[1]
  } catch (error) {
    if (error instanceof GhError && error.problem.kind === 'missing') return { installed: false, hosts: [], problem: "gh isn't installed", checkedAt: now }
    return { installed: false, hosts: [], problem: (error as Error).message, checkedAt: now }
  }
  // `--json` is a newer gh's; an older one says it in words.
  const json = await gh(['auth', 'status', '--json', 'hosts'])
  try {
    const parsed = JSON.parse(json.stdout) as { hosts: Record<string, { host: string; login?: string; state: string; active?: boolean; error?: string }[]> }
    const hosts = Object.entries(parsed.hosts).flatMap(([host, accounts]) => {
      const account = accounts.find((a) => a.active) ?? accounts[0]
      return account ? [{ host, ...(account.login ? { login: account.login } : {}), ok: account.state === 'success', ...(account.error ? { error: account.error } : {}) }] : []
    })
    return { installed: true, ...(version ? { version } : {}), hosts, ...(hosts.some((h) => h.ok) ? {} : { problem: "gh isn't signed in: run `gh auth login`" }), checkedAt: now }
  } catch {
    const text = await gh(['auth', 'status'])
    const said = `${text.stdout}\n${text.stderr}`
    const hosts = [...said.matchAll(/Logged in to (\S+) (?:account|as) (\S+)/g)].map(([, host, login]) => ({ host: host!, login: login!, ok: true }))
    return { installed: true, ...(version ? { version } : {}), hosts, ...(hosts.length ? {} : { problem: "gh isn't signed in: run `gh auth login`" }), checkedAt: now }
  }
}

// ── A branch's pull requests ─────────────────────────────────────────────────────────────────────────────────────
/** The URLs of the pull requests from `branch` of the repository in `cwd`, any state, newest first. */
export async function prsOfBranch(gh: Gh, cwd: string, branch: string, signal?: AbortSignal): Promise<string[]> {
  const run = await gh(['pr', 'list', '--head', branch, '--state', 'all', '--json', 'url,createdAt', '--limit', '10'], { cwd, ...(signal ? { signal } : {}) })
  if (run.code !== 0) throw problemOf(run)
  const list = JSON.parse(run.stdout || '[]') as { url: string; createdAt?: string }[]
  return list.sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? '')).map((p) => p.url)
}

// ── Many pull requests at once ───────────────────────────────────────────────────────────────────────────────────
const FIELDS = `number title url state isDraft mergeable reviewDecision headRefName baseRefName headRefOid
  author { login }
  latestReviews(first: 30) { nodes { author { login } state submittedAt url } }
  reviewThreads(first: 100) { nodes { isResolved isOutdated path line originalLine comments(first: 1) { nodes { author { login } body url } } } }
  commits(last: 1) { nodes { commit { statusCheckRollup { state contexts(first: 100) { nodes {
    __typename
    ... on CheckRun { name status conclusion startedAt completedAt detailsUrl }
    ... on StatusContext { context state targetUrl createdAt }
  } } } } } }`

/** The description and conversation: the latest top-level comments and reviews, and how many there are in all. */
const CONVERSATION_FIELDS = `body
  comments(last: ${CONVERSATION}) { totalCount nodes { author { login } body createdAt url isMinimized minimizedReason } }
  reviews(last: ${CONVERSATION}) { totalCount nodes { author { login } body state submittedAt url isMinimized minimizedReason } }`

/**
 * The query for these pull requests (all on one host), each aliased `p<i>`, with the rate limit; with `conversation`,
 * their descriptions and conversations too.
 */
export function prQuery(prs: PrRef[], { conversation = false }: { conversation?: boolean } = {}): string {
  const each = prs.map((p, i) => `p${i}: repository(owner: ${JSON.stringify(p.owner)}, name: ${JSON.stringify(p.repo)}) { pullRequest(number: ${p.number}) { ...pr } }`)
  return `query {\n  rateLimit { remaining resetAt }\n  ${each.join('\n  ')}\n}\nfragment pr on PullRequest { ${FIELDS}${conversation ? `\n  ${CONVERSATION_FIELDS}` : ''} }`
}

type Node = Record<string, any>
const time = (value: unknown) => typeof value === 'string' && value ? Date.parse(value) || undefined : undefined

/** A check run's or status's result. */
function checkOf(node: Node): Check {
  if (node.__typename === 'StatusContext') {
    const state = String(node.state)
    const result = state === 'SUCCESS' ? 'pass' : state === 'FAILURE' || state === 'ERROR' ? 'fail' : 'pending'
    return { name: String(node.context), result, ...(node.targetUrl ? { url: String(node.targetUrl) } : {}), ...(time(node.createdAt) ? { startedAt: time(node.createdAt)! } : {}) }
  }
  const conclusion = String(node.conclusion ?? '')
  const result: Check['result'] = node.status !== 'COMPLETED' ? 'pending'
    : conclusion === 'SUCCESS' || conclusion === 'NEUTRAL' ? 'pass'
    : conclusion === 'SKIPPED' ? 'skipped'
    : 'fail'
  const url = node.detailsUrl ? String(node.detailsUrl) : undefined
  const runId = url ? Number(/\/actions\/runs\/(\d+)/.exec(url)?.[1]) || undefined : undefined
  return {
    name: String(node.name), result, ...(url ? { url } : {}), ...(runId ? { runId } : {}),
    ...(time(node.startedAt) ? { startedAt: time(node.startedAt)! } : {}), ...(time(node.completedAt) && result !== 'pending' ? { completedAt: time(node.completedAt)! } : {}),
  }
}

const VERDICT: Record<string, ReviewBy['verdict']> = { APPROVED: 'approved', CHANGES_REQUESTED: 'changes', COMMENTED: 'commented', DISMISSED: 'dismissed', PENDING: 'pending' }

/** A pull request as GraphQL gave it, as the pane shows it. */
export function detailOf(ref: PrRef, node: Node, now: number): PrDetail {
  const rollup = node.commits?.nodes?.[0]?.commit?.statusCheckRollup
  const checkList: Check[] = (rollup?.contexts?.nodes ?? []).filter(Boolean).map(checkOf)
  // A check run again (a re-run) is listed once per run: the newest stands.
  const latest = new Map<string, Check>()
  for (const check of checkList) {
    const was = latest.get(check.name)
    if (!was || (check.startedAt ?? 0) >= (was.startedAt ?? 0)) latest.set(check.name, check)
  }
  const checks = [...latest.values()]
  const failing = checks.filter((c) => c.result === 'fail').length
  const comments: ReviewComment[] = (node.reviewThreads?.nodes ?? []).filter((t: Node) => t && !t.isResolved).map((t: Node) => {
    const first = t.comments?.nodes?.[0] ?? {}
    const line = t.line ?? t.originalLine
    return { path: String(t.path ?? ''), ...(line ? { line: Number(line) } : {}), body: String(first.body ?? ''), who: String(first.author?.login ?? 'someone'), ...(first.url ? { url: String(first.url) } : {}), outdated: Boolean(t.isOutdated) }
  })
  const reviews: ReviewBy[] = (node.latestReviews?.nodes ?? []).filter(Boolean).map((r: Node) => ({
    who: String(r.author?.login ?? 'someone'), verdict: VERDICT[String(r.state)] ?? 'commented',
    ...(time(r.submittedAt) ? { at: time(r.submittedAt)! } : {}), ...(r.url ? { url: String(r.url) } : {}),
  }))
  const state = node.state === 'MERGED' ? 'merged' : node.state === 'CLOSED' ? 'closed' : node.isDraft ? 'draft' : 'open'
  const decision = String(node.reviewDecision ?? '')
  return {
    key: ref.key, url: String(node.url ?? ref.url), number: ref.number, repo: `${ref.owner}/${ref.repo}`,
    title: String(node.title ?? ''), state,
    checks: failing ? 'failing' : checks.some((c) => c.result === 'pending') ? 'pending' : checks.length ? 'passing' : 'none', failing,
    review: decision === 'APPROVED' ? 'approved' : decision === 'CHANGES_REQUESTED' ? 'changes' : decision === 'REVIEW_REQUIRED' ? 'required' : 'none',
    unresolved: comments.length,
    mergeable: ({ MERGEABLE: 'mergeable', CONFLICTING: 'conflicting' } as Record<string, Mergeable>)[String(node.mergeable)] ?? 'unknown',
    ...(node.headRefName ? { branch: String(node.headRefName) } : {}), ...(node.baseRefName ? { base: String(node.baseRefName) } : {}),
    ...(node.headRefOid ? { head: String(node.headRefOid) } : {}), ...(node.author?.login ? { author: String(node.author.login) } : {}),
    checkList: checks, reviews, comments, polledAt: now,
  }
}

/**
 * A pull request's description and conversation, as GraphQL gave them: its comments and the reviews with words (a review
 * without any is its verdict, in `PrDetail.reviews`; a draft review isn't said yet), oldest first.
 */
export function conversationOf(node: Node, now: number): Conversation {
  // GitHub's reason is a word of its own (SPAM, OFF_TOPIC, OUTDATED…): kept to letters, said as words.
  const hidden = (n: Node) => n.isMinimized ? { hidden: String(n.minimizedReason ?? '').toLowerCase().replace(/_/g, ' ').replace(/[^a-z ]/g, '').trim() || 'hidden' } : {}
  const remark = (n: Node, at: unknown): Remark => ({
    who: String(n.author?.login ?? 'someone'), body: n.isMinimized ? '' : String(n.body ?? ''),
    ...(time(at) ? { at: time(at)! } : {}), ...(n.url ? { url: String(n.url) } : {}), ...hidden(n),
  })
  const comments: Node[] = (node.comments?.nodes ?? []).filter(Boolean)
  const reviews: Node[] = (node.reviews?.nodes ?? []).filter(Boolean)
  const remarks = [
    ...comments.map((c) => remark(c, c.createdAt)),
    ...reviews.filter((r) => r.state !== 'PENDING' && String(r.body ?? '').trim())
      .map((r) => ({ ...remark(r, r.submittedAt), verdict: VERDICT[String(r.state)] ?? 'commented' })),
  ].map((r, i) => ({ r, i })).sort((a, b) => (a.r.at ?? 0) - (b.r.at ?? 0) || a.i - b.i).map(({ r }) => r)
  const left = (connection: Node | undefined, got: number) => Math.max(0, Number(connection?.totalCount ?? got) - got)
  return { body: String(node.body ?? ''), remarks, earlier: left(node.comments, comments.length) + left(node.reviews, reviews.length), fetchedAt: now }
}

/**
 * What one query answered: each pull request (or why it couldn't be had), its conversation when asked for, and how much
 * of the rate limit is left.
 */
export type Fetched = { prs: Map<string, PrDetail | GhProblem>; conversations: Map<string, Conversation>; remaining?: number; resetAt?: number }

/**
 * These pull requests (all on `host`), in one `gh api graphql`. Throws a `GhError` when the query as a whole failed
 * (gh missing or signed out, a rate limit, no network); a pull request that isn't there, or isn't visible, is its own
 * `not-found` problem.
 */
export async function fetchPrs(gh: Gh, host: string, prs: PrRef[], now: number, { signal, conversation = false }: { signal?: AbortSignal; conversation?: boolean } = {}): Promise<Fetched> {
  const run = await gh(['api', 'graphql', '-i', '--hostname', host, '-f', `query=${prQuery(prs, { conversation })}`], signal ? { signal } : {})
  const { headers, body } = splitResponse(run.stdout)
  let parsed: { data?: Record<string, any>; errors?: { type?: string; path?: string[]; message: string }[] } | undefined
  try { parsed = body.trim() ? JSON.parse(body) : undefined } catch { parsed = undefined }
  if (!parsed?.data) {
    if (parsed?.errors?.some((e) => e.type === 'RATE_LIMITED')) throw new GhError({ kind: 'rate-limited', message: parsed.errors[0]!.message }, Number(headers['x-ratelimit-reset']) * 1000 || undefined)
    throw problemOf(run.code === 0 && parsed?.errors ? { ...run, stderr: parsed.errors.map((e) => e.message).join('; ') } : run, headers)
  }
  const errors = new Map((parsed.errors ?? []).map((e) => [e.path?.[0], e.message]))
  const found = new Map<string, PrDetail | GhProblem>()
  const conversations = new Map<string, Conversation>()
  prs.forEach((ref, i) => {
    const node = parsed!.data![`p${i}`]?.pullRequest
    found.set(ref.key, node ? detailOf(ref, node, now) : { kind: 'not-found', message: errors.get(`p${i}`) ?? `No pull request ${ref.owner}/${ref.repo}#${ref.number}, or no access to it` })
    if (node && conversation) conversations.set(ref.key, conversationOf(node, now))
  })
  const rate = parsed.data.rateLimit as { remaining?: number; resetAt?: string } | undefined
  return { prs: found, conversations, ...(typeof rate?.remaining === 'number' ? { remaining: rate.remaining } : {}), ...(time(rate?.resetAt) ? { resetAt: time(rate?.resetAt)! } : {}) }
}
