// github, daemon half: what happened to a pull request between two polls, and how it's said. Checks finished (failed,
// or all passed) on a head commit, a review submitted (changes requested, approved), review comments new since, merged,
// closed. Each event has keys, remembered once it's told, so it's told once (a restart, a re-run of the same checks on
// the same commit, never repeat it). Said three ways: a notice to the user (a headline, a line of detail, the thread's
// status line too), the message "Fix it" sends the agent, and what a watching agent is told as it's woken. What the
// agent is told (and Fix it sends, as the user's words) is facts only: which pull request, what happened, counts, who,
// run ids. Never others' words (its title, a check's name, a comment's body): anyone who can comment writes those, and
// a wake runs unattended. pr_view hands them over, quoted.
import type { Check, PrDetail, PrLink, ReviewComment } from './shared.ts'

export type PrEvent =
  | { kind: 'checks-failed'; keys: string[]; failed: Check[] }
  | { kind: 'checks-passed'; keys: string[] }
  | { kind: 'changes'; keys: string[]; who: string[]; comments: ReviewComment[] }
  | { kind: 'approved'; keys: string[]; who: string[] }
  | { kind: 'comments'; keys: string[]; comments: ReviewComment[] }
  | { kind: 'merged'; keys: string[] }
  | { kind: 'closed'; keys: string[] }
export type EventKind = PrEvent['kind']

/** The events the user is told of by a notice, watched or not; the rest only wake an agent that watches for them. */
export const NOTICED: ReadonlySet<EventKind> = new Set(['checks-failed', 'changes', 'approved', 'merged'])

/** Whether the checks on its head have all finished: some, and none still running. */
const finished = (pr: PrDetail) => pr.checkList.length > 0 && pr.checkList.every((c) => c.result !== 'pending')
const failedOf = (pr: PrDetail) => pr.checkList.filter((c) => c.result === 'fail')
const commentKey = (c: ReviewComment) => `comment@${c.url ?? `${c.path}:${c.line ?? ''}:${c.who}:${c.body.slice(0, 80)}`}`

/**
 * What happened between `was` and `now`, less what was told already (`told`, the keys of events told). Nothing the
 * first time a pull request is seen (`was` undefined): how it stood when attached isn't news.
 */
export function eventsOf(was: PrDetail | undefined, now: PrDetail, told: ReadonlySet<string>): PrEvent[] {
  if (!was) return []
  const events: PrEvent[] = []
  const fresh = (keys: string[]) => keys.filter((k) => !told.has(k))
  const live = now.state === 'open' || now.state === 'draft'

  // Checks: once all have finished on a head, failed or passed, unless they had already on it the same way.
  if (live && finished(now)) {
    const failed = failedOf(now)
    const outcome = failed.length ? 'failed' : 'passed'
    const before = finished(was) ? (failedOf(was).length ? 'failed' : 'passed') : undefined
    if (was.head !== now.head || before !== outcome) {
      const keys = fresh([`checks-${outcome}@${now.head ?? ''}`])
      if (keys.length) events.push(failed.length ? { kind: 'checks-failed', keys, failed } : { kind: 'checks-passed', keys })
    }
  }

  // Reviews: each reviewer's latest, new since (by who and when).
  const seen = new Set(was.reviews.map((r) => `${r.who}@${r.at ?? r.verdict}`))
  const reviews = live ? now.reviews.filter((r) => !seen.has(`${r.who}@${r.at ?? r.verdict}`)) : []
  const reviewKeys = (verdict: string) => reviews.filter((r) => r.verdict === verdict).map((r) => ({ who: r.who, key: `review@${r.who}@${r.at ?? verdict}` })).filter((r) => !told.has(r.key))
  const known = new Set(was.comments.map(commentKey))
  const comments = live ? now.comments.filter((c) => !known.has(commentKey(c)) && !told.has(commentKey(c))) : []
  const changes = reviewKeys('changes')
  if (changes.length) events.push({ kind: 'changes', keys: [...changes.map((r) => r.key), ...comments.map(commentKey)], who: changes.map((r) => r.who), comments })
  else if (comments.length) events.push({ kind: 'comments', keys: comments.map(commentKey), comments })
  const approved = reviewKeys('approved')
  if (approved.length) events.push({ kind: 'approved', keys: approved.map((r) => r.key), who: approved.map((r) => r.who) })

  if (now.state === 'merged' && was.state !== 'merged') { const keys = fresh(['merged']); if (keys.length) events.push({ kind: 'merged', keys }) }
  if (now.state === 'closed' && was.state !== 'closed') { const keys = fresh([`closed@${now.head ?? ''}`]); if (keys.length) events.push({ kind: 'closed', keys }) }
  return events
}

/** Whether a watch wakes its agent for an event: checks for checks, reviews for reviews and comments. */
export function wakes(watch: NonNullable<PrLink['watch']>, event: PrEvent): boolean {
  if (event.kind === 'checks-failed' || event.kind === 'checks-passed') return watch.checks !== false
  if (event.kind === 'changes' || event.kind === 'approved' || event.kind === 'comments') return watch.reviews !== false && watch.until !== 'checks'
  return false
}

// ── Saying it ────────────────────────────────────────────────────────────────────────────────────────────────────
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
const names = (who: string[]) => who.length <= 2 ? who.join(' and ') : `${who.slice(0, -1).join(', ')} and ${who.at(-1)}`

/** What a notice says of an event: its headline and a line of detail. */
export function said(pr: PrDetail, event: PrEvent): { headline: string; detail?: string } {
  const n = `#${pr.number}`
  switch (event.kind) {
    case 'checks-failed': return { headline: `${plural(event.failed.length, 'check')} failing on ${n}`, detail: event.failed.map((c) => c.name).join(', ') }
    case 'checks-passed': return { headline: `Checks passed on ${n}`, detail: plural(pr.checkList.filter((c) => c.result === 'pass').length, 'check') }
    case 'changes': return { headline: `${names(event.who)} requested changes`, ...(event.comments.length ? { detail: `${plural(event.comments.length, 'comment')} on ${n}` } : { detail: `on ${n}` }) }
    case 'approved': return { headline: `${names(event.who)} approved ${n}` }
    case 'comments': return { headline: `${plural(event.comments.length, 'new review comment')} on ${n}`, detail: [...new Set(event.comments.map((c) => c.who))].join(', ') }
    case 'merged': return { headline: `${n} was merged`, ...(pr.title ? { detail: pr.title } : {}) }
    case 'closed': return { headline: `${n} was closed`, ...(pr.title ? { detail: pr.title } : {}) }
  }
}

/** A login as said to the agent: GitHub's are letters, digits and hyphens (a bot's `[bot]`); anything else is dropped. */
const login = (who: string) => who.replace(/[^\w.[\]-]/g, '') || 'someone'
const logins = (who: string[]) => names(who.map(login))

/** What happened, for the agent: facts only (which, what, how many, who), none of others' words. */
export function agentSaid(pr: PrDetail, event: PrEvent): string {
  const n = `${pr.repo}#${pr.number}`
  switch (event.kind) {
    case 'checks-failed': return `${plural(event.failed.length, 'check')} failed on ${n}`
    case 'checks-passed': return `Checks passed on ${n}`
    case 'changes': return `${logins(event.who)} requested changes on ${n}${event.comments.length ? `, with ${plural(event.comments.length, 'review comment')}` : ''}`
    case 'approved': return `${logins(event.who)} approved ${n}`
    case 'comments': return `${plural(event.comments.length, 'new review comment')} on ${n}, from ${logins([...new Set(event.comments.map((c) => c.who))])}`
    case 'merged': return `${n} was merged`
    case 'closed': return `${n} was closed`
  }
}

/** What the agent's told of a notice: which pull request, what happened, and where to read it. */
export function noticeForAgent(pr: PrDetail, event: PrEvent): string {
  return `${agentSaid(pr, event)}. pr_view has the details.`
}

/** The commands for a failed check run's logs, each run once: its id is GitHub's, a number. */
const logCommands = (failed: Check[]) => [...new Set(failed.flatMap((c) => c.runId ? [c.runId] : []))].map((id) => `\`gh run view ${id} --log-failed\``)

/**
 * The message "Fix it" sends the agent (as the user's words): what failed or was asked, and how to see it; nothing for
 * an event with nothing to fix. Facts only: the checks' names and the comments are pr_view's to show.
 */
export function fixText(pr: PrDetail, event: PrEvent): string | undefined {
  const name = `${pr.repo}#${pr.number}`
  if (event.kind === 'checks-failed') {
    const logs = logCommands(event.failed)
    return `${plural(event.failed.length, 'check')} failed on ${name}. See which with pr_view${logs.length ? `, and their logs with ${logs.join(', ')}` : ''}. Find out why, fix it, and push.`
  }
  if (event.kind === 'changes' || event.kind === 'comments') {
    return `${agentSaid(pr, event)}. Read the review with pr_view, address it, and push.`
  }
  return undefined
}

/** What a watching agent is told as it's woken: what happened, what to do, and that pr_view has the rest. */
export function wakeText(pr: PrDetail, events: PrEvent[], { stopped }: { stopped: boolean }): string {
  const lines = events.map((e) => `${agentSaid(pr, e)}.`)
  const failed = events.flatMap((e) => e.kind === 'checks-failed' ? e.failed : [])
  const logs = logCommands(failed)
  const ask = failed.length ? `Fix what failed and push${logs.length ? ` (logs: ${logs.join(', ')})` : ''}.`
    : events.some((e) => e.kind === 'changes' || e.kind === 'comments') ? 'Address the review and push.' : undefined
  const watch = stopped ? "You're no longer watching it." : "You're watching it: pr_watch with stop: true stops that."
  return `${lines.join('\n')}${ask ? ` ${ask}` : ''}\npr_view has the details: its checks, reviews and review comments.\n(${watch})`
}
