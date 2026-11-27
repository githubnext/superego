// What both halves of github agree on: what it is, how a pull request is named (its key, from its URL), what a thread
// keeps of its pull requests (state) and shows (facts), what the pane reads, and the words and marks a pull request's
// state is said with, in the window and to the agent alike.
import type { ExtensionAbout } from '@superego/protocol'

/** The kind of pane that shows one pull request: `{ url }`. */
export const PANE = 'pull-request'

export const about = {
  name: 'github', version: '1.0.0', api: '^5.21', title: 'GitHub',
  description: "A thread's pull requests: their state in the title bar and sidebar, checks and reviews beside it. Uses this machine's gh.",
  panes: { [PANE]: 'a GitHub pull request: its state, checks, reviews and unresolved review comments. Params: { url }' },
} satisfies ExtensionAbout

// ── Names ────────────────────────────────────────────────────────────────────────────────────────────────────────
/** Actions: attach a pull request to a thread by its URL, detach one (by key), poll now (a thread's, one, or all). */
export const ATTACH = 'github.attach'
export const DETACH = 'github.detach'
export const REFRESH = 'github.refresh'
/** Actions: watch a thread's pull request (its agent woken when its checks finish or it's reviewed), or stop. */
export const WATCH = 'github.watch'
export const UNWATCH = 'github.unwatch'
/** A read: one pull request as the pane shows it, and the threads on this machine that have it (`PrView`). */
export const PR = 'github.pr'
/** A live value: this machine's `gh`, as Settings says it (`GhStatus`). */
export const STATUS = 'github.status'
/** Its settings section, drawn by the UI half. */
export const SECTION = 'github'
/** The agent's tools. */
export const VIEW_TOOL = 'pr_view'
export const ATTACH_TOOL = 'pr_attach'
export const DETACH_TOOL = 'pr_detach'
export const WATCH_TOOL = 'pr_watch'
/** The kind of the notices it tells a thread (`NoticeData`), drawn by the UI half. */
export const NOTICE = 'github.event'
/** The prompt section about the thread's pull request. */
export const PROMPT_SECTION = 'pull_request'

// ── Naming a pull request ────────────────────────────────────────────────────────────────────────────────────────
/** A pull request, by host, repository and number: `github.com/owner/repo#123`. */
export type PrKey = string
export type PrRef = { key: PrKey; url: string; host: string; owner: string; repo: string; number: number }

/**
 * A pull request's URL, anywhere in a text (GitHub Enterprise's too: any host). Only a host gh is signed in to is asked
 * about (`unknown-host` otherwise): a URL is anyone's to write.
 */
export const PR_URL = /https?:\/\/([\w.-]+(?::\d+)?)\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/g

/** A pull request's URL taken apart, or undefined when it isn't one. Anything after its number (`/files`, `#…`) is left off. */
export function parsePr(url: string): PrRef | undefined {
  const m = new RegExp(PR_URL.source).exec(url.trim())
  if (!m || m.index !== 0) return undefined
  const [, host, owner, repo, number] = m as unknown as [string, string, string, string, string]
  const key = `${host.toLowerCase()}/${owner}/${repo}#${Number(number)}`
  return { key, url: `https://${host}/${owner}/${repo}/pull/${Number(number)}`, host: host.toLowerCase(), owner, repo, number: Number(number) }
}

/** Every pull request a text names, each once, in order. */
export function prsIn(text: string): PrRef[] {
  const found = new Map<string, PrRef>()
  for (const m of text.matchAll(PR_URL)) {
    const ref = parsePr(m[0])
    if (ref && !found.has(ref.key)) found.set(ref.key, ref)
  }
  return [...found.values()]
}

/** A key taken apart (it holds all a URL does). */
export function refOf(key: PrKey): PrRef | undefined {
  const m = /^([^/]+)\/([^/]+)\/([^#]+)#(\d+)$/.exec(key)
  return m ? parsePr(`https://${m[1]}/${m[2]}/${m[3]}/pull/${m[4]}`) : undefined
}

// ── What a thread keeps and shows ────────────────────────────────────────────────────────────────────────────────
/**
 * How a pull request came to a thread: its agent ran `gh pr create` (`created`), the thread's own branch has it
 * (`branch`), the user attached it (`hand`), or the agent did (`agent`, `pr_attach`).
 */
export type How = 'created' | 'branch' | 'hand' | 'agent'
/**
 * A watch on a thread's pull request: its agent is woken when its checks finish (`checks`) or it's reviewed (`reviews`,
 * new review comments too); both unless said. `until: 'checks'`: once, when its checks next finish. Over once merged or
 * closed.
 */
export type Watch = { checks?: boolean; reviews?: boolean; until?: 'checks' }
export type PrLink = { key: PrKey; url: string; how: How; at: number; watch?: Watch }

export type PrState = 'open' | 'draft' | 'merged' | 'closed'
export type Checks = 'passing' | 'failing' | 'pending' | 'none'
export type Review = 'approved' | 'changes' | 'required' | 'none'
export type Mergeable = 'mergeable' | 'conflicting' | 'unknown'

/**
 * Why a pull request's state isn't known (or isn't current): `gh` isn't installed (`missing`) or signed in
 * (`signed-out`) on the thread's machine, or not to its host (`unknown-host`: it isn't asked), GitHub says there's no
 * such pull request or no access (`not-found`), it's rate-limited, or the call failed. `message` is what went wrong, as
 * said.
 */
export type GhProblem = { kind: 'missing' | 'signed-out' | 'unknown-host' | 'not-found' | 'rate-limited' | 'failed'; message: string }

/**
 * What the marks and the card need of a pull request: small. `title` and `state` are unknown until it was first
 * fetched (with `gh` missing, say: then `error` says why).
 */
export type PrSummary = {
  key: PrKey; url: string; number: number; repo: string
  title?: string
  state?: PrState
  checks: Checks; failing: number
  review: Review; unresolved: number
  mergeable?: Mergeable
  error?: GhProblem
}

/** A thread's pull request as clients see it (`facts.github.prs`): its summary and how it came. */
export type PrFact = PrSummary & { how: How; at: number; watch?: Watch }
/** `facts.github`: the thread's pull requests, newest first. Absent while it has none. */
export type GithubFacts = { prs: PrFact[] }

/**
 * What the daemon half keeps with each thread: its pull requests, those detached by hand (never attached again by
 * itself), their summaries, and the tip of the thread's branch's upstream when it last looked for a pull request there.
 */
export type GithubState = { prs: PrLink[]; detached: PrKey[]; summaries: Record<PrKey, PrSummary>; looked?: string }

/**
 * A notice's data (`NOTICE`): what happened (an event's kind: `checks-failed`, `checks-passed`, `changes`, `approved`,
 * `comments`, `merged`, `closed`) to which pull request, said in a headline and a line of detail. `watched`: it's for the
 * agent watching it, and wakes it (unless the thread's wake budget held it: the notice says so).
 */
export type NoticeData = { event: string; key: PrKey; url: string; number: number; headline: string; detail?: string; watched?: boolean }

/** What a watch wakes the agent for, in words: "checks and reviews", "checks, once". */
export function watchWord(watch: Watch): string {
  if (watch.until === 'checks') return 'checks, once'
  const what = [watch.checks !== false && 'checks', watch.reviews !== false && 'reviews'].filter(Boolean)
  return what.join(' and ') || 'nothing'
}

// ── What the pane reads ──────────────────────────────────────────────────────────────────────────────────────────
/** A check on the pull request's head: its result, where its run is, and when it started and finished (ms). */
export type Check = { name: string; result: 'pass' | 'fail' | 'pending' | 'skipped'; url?: string; runId?: number; startedAt?: number; completedAt?: number }
/** A reviewer's latest review. */
export type ReviewBy = { who: string; verdict: 'approved' | 'changes' | 'commented' | 'dismissed' | 'pending'; at?: number; url?: string }
/** An unresolved review thread: where, its first comment and who wrote it. `outdated`: on lines changed since. */
export type ReviewComment = { path: string; line?: number; body: string; who: string; url?: string; outdated: boolean }

/** A pull request, all the pane and `pr_view` show of it, as last fetched (`polledAt`). */
export type PrDetail = PrSummary & {
  branch?: string; base?: string; head?: string; author?: string
  checkList: Check[]; reviews: ReviewBy[]; comments: ReviewComment[]
  polledAt?: number
}

/** `github.pr`'s answer: the pull request, and the threads on this machine that have it (archived ones too). */
export type PrView = { pr: PrDetail; threads: { id: string; title: string; archived: boolean }[] }

/** This machine's `gh`: whether it's there, and who it's signed in as where. */
export type GhStatus = {
  installed: boolean
  version?: string
  hosts: { host: string; login?: string; ok: boolean; error?: string }[]
  /** What's wrong, when something is: not installed, not signed in, or it couldn't be asked. */
  problem?: string
  /** What else went wrong lately (saving what it knows, a poll, looking at a thread's branch), until it goes right. */
  troubles?: string[]
  checkedAt: number
}

// ── Saying it ────────────────────────────────────────────────────────────────────────────────────────────────────
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/** The pull request that leads a list (the chip, the row): the newest open (or draft), else the newest. */
export const lead = <T extends PrSummary>(prs: readonly T[]): T | undefined =>
  prs.find((p) => p.state === 'open' || p.state === 'draft') ?? prs[0]

/** Its state in a word: "open", "draft", "merged", "closed"; "state unknown" before it was fetched. */
export const stateWord = (pr: PrSummary) => pr.state ?? 'state unknown'

/** What most needs saying of it, in a few words: "2 checks failing", "Changes requested", "Approved", "Merged"… */
export function word(pr: PrSummary): string {
  if (!pr.state) return pr.error ? 'Unknown' : 'Loading'
  if (pr.state === 'merged') return 'Merged'
  if (pr.state === 'closed') return 'Closed'
  if (pr.state === 'draft') return 'Draft'
  if (pr.checks === 'failing') return `${plural(pr.failing, 'check')} failing`
  if (pr.review === 'changes') return 'Changes requested'
  if (pr.mergeable === 'conflicting') return 'Conflicts'
  if (pr.checks === 'pending') return 'Checks running'
  if (pr.review === 'approved') return 'Approved'
  return 'Waiting for review'
}

/** It spelled out, in a line: "PR #123 open, checks failing, changes requested, 3 unresolved comments". */
export function spell(pr: PrSummary): string {
  const bits = [`PR #${pr.number} ${stateWord(pr)}`]
  if (pr.state === 'open' || pr.state === 'draft') {
    if (pr.checks !== 'none') bits.push(`checks ${pr.checks === 'failing' ? `failing (${pr.failing})` : pr.checks}`)
    if (pr.review === 'changes') bits.push('changes requested')
    else if (pr.review === 'approved') bits.push('approved')
    else if (pr.review === 'required') bits.push('review required')
    if (pr.unresolved) bits.push(plural(pr.unresolved, 'unresolved comment'))
    if (pr.mergeable === 'conflicting') bits.push('conflicts')
  }
  return bits.join(', ')
}

/**
 * The road to merge: three segments, checks · review · merge, each how far along it is. All `merged` once merged;
 * none for a closed one. Merge is `ready` once checks pass and it's approved, `fail` with conflicts.
 */
export type Segment = 'pass' | 'fail' | 'pending' | 'changes' | 'ready' | 'merged' | 'todo'
export function road(pr: PrSummary): Segment[] {
  if (pr.state === 'merged') return ['merged', 'merged', 'merged']
  if (pr.state === 'closed' || !pr.state) return []
  const checks: Segment = pr.checks === 'passing' ? 'pass' : pr.checks === 'failing' ? 'fail' : pr.checks === 'pending' ? 'pending' : 'todo'
  const review: Segment = pr.review === 'approved' ? 'pass' : pr.review === 'changes' ? 'changes' : 'todo'
  const merge: Segment = pr.state === 'draft' ? 'todo' : pr.mergeable === 'conflicting' ? 'fail' : checks === 'pass' && review === 'pass' ? 'ready' : 'todo'
  return [checks, review, merge]
}

/** How it came to the thread, as the details say it. */
export const howWord: Record<How, string> = { created: 'opened by this thread', branch: "its branch's", hand: 'attached by you', agent: 'attached by the agent' }

/** What a problem with `gh` means for the user, and how to fix it, on machine `where`. */
export function problemText(problem: GhProblem, where = 'this machine'): string {
  if (problem.kind === 'missing') return `gh isn't installed on ${where}: install it (cli.github.com) and run \`gh auth login\`.`
  if (problem.kind === 'signed-out') return `gh isn't signed in on ${where}: run \`gh auth login\`.`
  return problem.message
}
