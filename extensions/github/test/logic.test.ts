// github's pure parts: naming a pull request by its URL, saying its state (words, the road to merge), reading gh's
// answers, and when it's next asked about.
import { expect, it } from 'vitest'
import { detailOf, problemOf, prQuery, splitResponse } from '../src/gh.ts'
import { eventsOf, wakes } from '../src/events.ts'
import { backoff, due, INTERVALS } from '../src/schedule.ts'
import { parsePr, prsIn, refOf, road, spell, word, type PrDetail, type PrSummary } from '../src/shared.ts'
import { failedCheck, prNode } from './fake-gh.ts'

it('names a pull request by its URL, any host, whatever follows its number', () => {
  expect(parsePr('https://github.com/acme/app/pull/7/files#diff')).toEqual({ key: 'github.com/acme/app#7', url: 'https://github.com/acme/app/pull/7', host: 'github.com', owner: 'acme', repo: 'app', number: 7 })
  expect(parsePr('https://GHE.corp.example/team/svc.api/pull/12')?.key).toBe('ghe.corp.example/team/svc.api#12')
  expect(parsePr('https://github.com/acme/app/issues/7')).toBeUndefined()
  expect(parsePr('see https://github.com/acme/app/pull/7')).toBeUndefined()
  expect(prsIn('Opened https://github.com/acme/app/pull/7 (and https://github.com/acme/app/pull/7, https://github.com/x/y/pull/1).').map((p) => p.key))
    .toEqual(['github.com/acme/app#7', 'github.com/x/y#1'])
  expect(refOf('github.com/acme/app#7')?.url).toBe('https://github.com/acme/app/pull/7')
})

const pr = (more: Partial<PrSummary> = {}): PrSummary => ({ key: 'k', url: 'u', number: 7, repo: 'acme/app', state: 'open', checks: 'passing', failing: 0, review: 'required', unresolved: 0, mergeable: 'mergeable', ...more })

it('says what most needs saying, and the road to merge', () => {
  expect(word(pr({ checks: 'failing', failing: 2, review: 'changes' }))).toBe('2 checks failing')
  expect(word(pr({ review: 'changes' }))).toBe('Changes requested')
  expect(word(pr({ checks: 'pending' }))).toBe('Checks running')
  expect(word(pr({ review: 'approved' }))).toBe('Approved')
  expect(word(pr())).toBe('Waiting for review')
  expect(word(pr({ state: 'merged' }))).toBe('Merged')
  expect(word(pr({ state: undefined, error: { kind: 'missing', message: 'x' } }))).toBe('Unknown')

  expect(road(pr({ checks: 'failing' }))).toEqual(['fail', 'todo', 'todo'])
  expect(road(pr({ review: 'changes' }))).toEqual(['pass', 'changes', 'todo'])
  expect(road(pr({ review: 'approved' }))).toEqual(['pass', 'pass', 'ready'])
  expect(road(pr({ review: 'approved', mergeable: 'conflicting' }))).toEqual(['pass', 'pass', 'fail'])
  expect(road(pr({ state: 'draft', checks: 'pending' }))).toEqual(['pending', 'todo', 'todo'])
  expect(road(pr({ state: 'merged' }))).toEqual(['merged', 'merged', 'merged'])
  expect(road(pr({ state: 'closed' }))).toEqual([])

  expect(spell(pr({ checks: 'failing', failing: 2, review: 'changes', unresolved: 3 }))).toBe('PR #7 open, checks failing (2), changes requested, 3 unresolved comments')
  expect(spell(pr({ state: 'merged' }))).toBe('PR #7 merged')
})

it("reads gh api's answer: its headers, a rate limit, a sign-in wanted", () => {
  expect(splitResponse('HTTP/2.0 403 Forbidden\r\nX-Ratelimit-Reset: 1700000000\r\n\r\n{"a":1}')).toEqual({ status: 403, headers: { 'x-ratelimit-reset': '1700000000' }, body: '{"a":1}' })
  const limited = problemOf({ code: 1, stdout: '', stderr: 'gh: API rate limit exceeded (HTTP 403)' }, { 'x-ratelimit-reset': '1700000000' })
  expect(limited.problem.kind).toBe('rate-limited')
  expect(limited.retryAt).toBe(1700000000 * 1000)
  expect(problemOf({ code: 4, stdout: '', stderr: 'To get started with GitHub CLI, please run:  gh auth login' }).problem.kind).toBe('signed-out')
  expect(problemOf({ code: 1, stdout: '', stderr: 'error connecting to api.github.com' }).problem).toEqual({ kind: 'failed', message: 'error connecting to api.github.com' })
  // Each pull request aliased.
  expect(prQuery([parsePr('https://github.com/acme/app/pull/7')!])).toContain('p0: repository(owner: "acme", name: "app") { pullRequest(number: 7) { ...pr } }')
})

it("summarizes a pull request: a re-run check counted once, resolved threads left out, a draft's state", () => {
  const ref = parsePr('https://github.com/acme/app/pull/7')!
  const rerun = { ...failedCheck('acme', 'app', 'lint', 41), startedAt: '2026-01-01T09:00:00Z' }
  const passed = { ...failedCheck('acme', 'app', 'lint', 42), conclusion: 'SUCCESS' }
  const running = { __typename: 'StatusContext', context: 'ci/build', state: 'PENDING', targetUrl: 'https://ci.example/1', createdAt: '2026-01-01T10:00:00Z' }
  const detail = detailOf(ref, prNode('acme', 'app', 7, {
    isDraft: true,
    commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: [rerun, passed, running] } } } }] },
    reviewThreads: { nodes: [{ isResolved: true, path: 'a', comments: { nodes: [] } }, { isResolved: false, isOutdated: true, path: 'b.ts', originalLine: 3, comments: { nodes: [{ author: { login: 'bo' }, body: 'Hm' }] } }] },
  }), 1)
  expect(detail).toMatchObject({ state: 'draft', checks: 'pending', failing: 0, unresolved: 1, polledAt: 1, branch: 'feature', base: 'main' })
  expect(detail.checkList.map((c) => [c.name, c.result])).toEqual([['lint', 'pass'], ['ci/build', 'pending']])
  expect(detail.comments).toEqual([{ path: 'b.ts', line: 3, body: 'Hm', who: 'bo', outdated: true }])
})

it('asks often while checks run or something just happened, rarely otherwise, never once merged; backs off', () => {
  const at = 1_000_000
  const open = { detail: { ...pr(), checkList: [], reviews: [], comments: [] }, checkedAt: at }
  expect(due({}, at, INTERVALS)).toBe(true)
  expect(due(open, at + 60_000, INTERVALS)).toBe(false)
  expect(due(open, at + 5 * 60_000, INTERVALS)).toBe(true)
  expect(due({ ...open, hotUntil: at + 60_000 }, at + 30_000, INTERVALS)).toBe(true)
  expect(due({ ...open, detail: { ...open.detail, checks: 'pending' } }, at + 30_000, INTERVALS)).toBe(true)
  expect(due({ ...open, detail: { ...open.detail, state: 'merged' } }, at + 3_600_000, INTERVALS)).toBe(false)
  expect(due({ ...open, detail: { ...open.detail, state: 'merged' }, forced: true }, at, INTERVALS)).toBe(true)
  expect([1, 2, 3, 10].map((n) => backoff(n, INTERVALS))).toEqual([60_000, 120_000, 240_000, 30 * 60_000])
})

it('derives what happened between two polls, each once', () => {
  const ref = parsePr('https://github.com/acme/app/pull/7')!
  const at = (more: Record<string, unknown>) => detailOf(ref, prNode('acme', 'app', 7, more), 0)
  const checks = (head: string, ...nodes: unknown[]) => ({ headRefOid: head, commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes } } } }] } })
  const running = { __typename: 'CheckRun', name: 'test', status: 'IN_PROGRESS' }
  const kinds = (was: PrDetail | undefined, now: PrDetail, told: string[] = []) => eventsOf(was, now, new Set(told)).map((e) => e.kind)
  const failed = at(checks('a', failedCheck('acme', 'app', 'lint', 1)))
  // First seen: nothing's news.
  expect(kinds(undefined, failed)).toEqual([])
  expect(kinds(at(checks('a', running)), failed)).toEqual(['checks-failed'])
  expect(eventsOf(at(checks('a', running)), failed, new Set())[0]!.keys).toEqual(['checks-failed@a'])
  // Told already (a restart), or the same again: not again. A new head failing: again.
  expect(kinds(at(checks('a', running)), failed, ['checks-failed@a'])).toEqual([])
  expect(kinds(failed, failed)).toEqual([])
  expect(kinds(failed, at(checks('b', failedCheck('acme', 'app', 'lint', 2))))).toEqual(['checks-failed'])
  // Re-run green on the same head: passed.
  expect(kinds(failed, at(checks('a', { ...running, status: 'COMPLETED', conclusion: 'SUCCESS' })))).toEqual(['checks-passed'])

  // Comments alone, comments with a review asking for changes (one event), approved, merged, closed.
  const thread = (body: string) => ({ isResolved: false, path: 'a.ts', line: 1, comments: { nodes: [{ author: { login: 'bo' }, body, url: `u#${body}` }] } })
  const base = at({})
  expect(kinds(base, at({ reviewThreads: { nodes: [thread('x')] } }))).toEqual(['comments'])
  const asked = eventsOf(base, at({ reviewThreads: { nodes: [thread('x')] }, latestReviews: { nodes: [{ author: { login: 'bo' }, state: 'CHANGES_REQUESTED', submittedAt: '2026-01-01T00:00:00Z' }] } }), new Set())
  expect(asked).toEqual([{ kind: 'changes', who: ['bo'], comments: [expect.objectContaining({ body: 'x' })], keys: ['review@bo@1767225600000', 'comment@u#x'] }])
  expect(kinds(base, at({ latestReviews: { nodes: [{ author: { login: 'al' }, state: 'APPROVED', submittedAt: '2026-01-01T00:00:00Z' }] } }))).toEqual(['approved'])
  expect(kinds(base, at({ state: 'MERGED' }))).toEqual(['merged'])
  expect(kinds(base, at({ state: 'CLOSED' }))).toEqual(['closed'])

  // Who a watch wakes for.
  const [checksFailed] = eventsOf(at(checks('a', running)), failed, new Set())
  expect(wakes({}, checksFailed!)).toBe(true)
  expect(wakes({ checks: false }, checksFailed!)).toBe(false)
  expect(wakes({ until: 'checks', checks: true }, asked[0]!)).toBe(false)
  expect(wakes({}, asked[0]!)).toBe(true)
})
