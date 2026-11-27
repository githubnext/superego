// github's daemon half against a real daemon and a fake gh on a PATH of its own: pull requests attached by hand, by
// `gh pr create`, by a worktree thread's branch; detached for good; followed by the poller (facts, the pane's read),
// told to the agent (its prompt, pr_view); and what it does without gh, signed out, or rate-limited.
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import type { ThreadInfo } from '@superego/protocol'
import { callTool, say, testDaemon, type TestDaemon } from '@superego/sdk/testing'
import worktrees from '@superego/worktrees/daemon'
import { githubExtension } from '../src/daemon.ts'
import { ATTACH, DETACH, PR, REFRESH, STATUS, type GhStatus, type GithubFacts, type PrView } from '../src/shared.ts'
import { failedCheck, fakeGh, prNode } from './fake-gh.ts'

const URL = 'https://github.com/acme/app/pull/7'
const KEY = 'github.com/acme/app#7'
// Fast enough for a test: every pull request due at once, failures waited out briefly.
const FAST = { tick: 50, fast: 100, slow: 100, settle: 50, backoff: 400, maxBackoff: 400, recheck: 200 }

let dir: string
let daemon: TestDaemon | undefined
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'superego-github-')) })
afterEach(async () => { await daemon?.close(); daemon = undefined; await rm(dir, { recursive: true, force: true }) })

const factsOf = async (thread: ThreadInfo) => (await daemon!.facts(thread)).github as GithubFacts | undefined
const until = (what: string, check: (facts: GithubFacts | undefined) => boolean, thread: ThreadInfo) =>
  daemon!.until(async () => check(await factsOf(thread)), what, 10_000)

it('attaches a pull request by hand, follows it, and detaches it', async () => {
  const gh = await fakeGh(dir, { login: 'octocat', prs: { 'acme/app#7': prNode('acme', 'app', 7, { title: 'Mentions' }) } })
  daemon = await testDaemon({ extensions: [githubExtension({ env: gh.env, intervals: FAST })] })
  const thread = await daemon.thread()
  expect(await factsOf(thread)).toBeUndefined()
  await daemon.dispatch(ATTACH, { thread: thread.id, url: `${URL}/files` })
  await until('its state', (f) => f?.prs[0]?.state === 'open', thread)
  expect((await factsOf(thread))!.prs).toEqual([expect.objectContaining({
    key: KEY, url: URL, number: 7, repo: 'acme/app', title: 'Mentions', state: 'open', checks: 'passing', failing: 0, review: 'required', unresolved: 0, mergeable: 'mergeable', how: 'hand',
  })])
  // gh asked without prompts, with the host.
  const asked = (await gh.calls()).find((c) => c.args[1] === 'graphql')!
  expect(asked.prompt).toBe('1')
  expect(asked.args).toContain('--hostname')

  // Changed on GitHub: followed.
  await gh.set({ login: 'octocat', prs: { 'acme/app#7': prNode('acme', 'app', 7, { title: 'Mentions', state: 'MERGED' }) } })
  await until('merged', (f) => f?.prs[0]?.state === 'merged', thread)

  await daemon.dispatch(DETACH, { thread: thread.id, pr: URL })
  expect(await factsOf(thread)).toBeUndefined()
  await expect(daemon.dispatch(DETACH, { thread: thread.id, pr: URL })).rejects.toThrow(/no pull request/)
  await expect(daemon.dispatch(ATTACH, { thread: thread.id, url: 'https://example.com/nope' })).rejects.toThrow(/Not a pull request/)
})

it("attaches the pull request the agent's `gh pr create` opened, and tells the agent of it", async () => {
  const gh = await fakeGh(dir, { login: 'octocat', prs: { 'acme/app#7': prNode('acme', 'app', 7, {
    title: 'Mentions', reviewDecision: 'CHANGES_REQUESTED',
    latestReviews: { nodes: [{ author: { login: 'alice' }, state: 'CHANGES_REQUESTED', submittedAt: '2026-01-01T11:00:00Z' }] },
    reviewThreads: { nodes: [
      { isResolved: false, isOutdated: false, path: 'src/mentions.tsx', line: 84, comments: { nodes: [{ author: { login: 'alice' }, body: 'This refetches on every keystroke.', url: `${URL}#r1` }] } },
      { isResolved: true, path: 'src/old.ts', line: 1, comments: { nodes: [{ author: { login: 'bo' }, body: 'Fixed', url: `${URL}#r2` }] } },
    ] },
    commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: [failedCheck('acme', 'app', 'lint', 42)] } } } }] },
  }) } })
  daemon = await testDaemon({
    extensions: [githubExtension({ env: gh.env, intervals: FAST })],
    // The command says `gh pr create`, and prints what it would: the URL (a real gh would need a repository and a network).
    model: [callTool('bash', { command: `echo 'Creating pull request for feature into main' && echo ${URL} # gh pr create --fill` }), say('Opened.'), callTool('pr_view', {}), say('Seen.')],
  })
  const thread = await daemon.thread('Open a PR')
  await until('attached, as created', (f) => f?.prs[0]?.how === 'created' && f.prs[0].checks === 'failing', thread)
  expect((await factsOf(thread))!.prs[0]).toMatchObject({ key: KEY, failing: 1, review: 'changes', unresolved: 1 })

  await daemon.send(thread, 'How is it?')
  // Its prompt says it, and pr_view has the details.
  const transcript = await daemon.transcript(thread)
  expect(transcript).toContain('This thread\'s pull request: acme/app#7 \\"Mentions\\" (open; checks: 1 failing: lint; review: changes requested by alice, 1 unresolved comment)')
  const view = (await daemon.toolCalls(thread)).find((c) => c.name === 'pr_view')!
  expect(view.result?.isError).toBe(false)
  expect(view.result?.text).toContain('✗ lint https://github.com/acme/app/actions/runs/42/job/2 (logs: gh run view 42 --log-failed)')
  expect(view.result?.text).toContain('src/mentions.tsx:84 alice: This refetches on every keystroke.')
  expect(view.result?.text).not.toContain('src/old.ts')

  // The pane's read: everything, and the threads that have it.
  const read = await daemon.call<PrView>(PR, { url: URL })
  expect(read.threads).toEqual([{ id: thread.id, title: thread.title, archived: false }])
  expect(read.pr).toMatchObject({ branch: 'feature', base: 'main', comments: [{ path: 'src/mentions.tsx', line: 84, who: 'alice' }], reviews: [{ who: 'alice', verdict: 'changes' }] })
  expect(read.pr.checkList).toEqual([expect.objectContaining({ name: 'lint', result: 'fail', runId: 42, startedAt: Date.parse('2026-01-01T10:00:00Z'), completedAt: Date.parse('2026-01-01T10:07:55Z') })])
})

it("attaches a worktree thread's branch's pull request once it's pushed, but never one detached there", async () => {
  const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { encoding: 'utf8' }).trim()
  const repo = join(dir, 'repo')
  execFileSync('git', ['init', '-q', '-b', 'main', repo])
  await writeFile(join(repo, 'readme.md'), 'hi\n')
  git(repo, 'add', '.'); git(repo, 'commit', '-q', '-m', 'start')
  execFileSync('git', ['init', '-q', '--bare', join(dir, 'origin.git')])
  git(repo, 'remote', 'add', 'origin', join(dir, 'origin.git'))
  const gh = await fakeGh(dir, { login: 'octocat', prs: { 'acme/app#7': prNode('acme', 'app', 7) } })
  daemon = await testDaemon({ extensions: [worktrees, githubExtension({ env: gh.env, intervals: FAST })], dataDir: join(dir, 'data') })
  const thread = await daemon.call<ThreadInfo>('thread.start', { cwd: repo, title: 'Mentions', options: { worktrees: true } })
  const { branch } = thread.facts!.worktrees as { branch: string }
  await gh.set({ login: 'octocat', prs: { 'acme/app#7': prNode('acme', 'app', 7) }, branches: { [branch]: [URL] } })
  // Not pushed: not looked for.
  await daemon.dispatch(REFRESH, { thread: thread.id })
  expect(await factsOf(thread)).toBeUndefined()
  expect((await gh.calls()).some((c) => c.args[1] === 'list')).toBe(false)

  git(thread.cwd, 'push', '-q', '-u', 'origin', branch)
  await daemon.dispatch(REFRESH, { thread: thread.id })
  await until("its branch's", (f) => f?.prs[0]?.how === 'branch', thread)
  expect((await gh.calls()).find((c) => c.args[1] === 'list')?.cwd).toContain(branch.split('/').pop())

  await daemon.dispatch(DETACH, { thread: thread.id, pr: KEY })
  // Pushed again: looked at again, and not attached.
  await writeFile(join(thread.cwd, 'more.md'), 'more\n')
  git(thread.cwd, 'add', '.'); git(thread.cwd, 'commit', '-q', '-m', 'more'); git(thread.cwd, 'push', '-q')
  const before = (await gh.calls()).filter((c) => c.args[1] === 'list').length
  await daemon.dispatch(REFRESH, { thread: thread.id })
  await daemon.until(async () => (await gh.calls()).filter((c) => c.args[1] === 'list').length > before, 'looked again', 10_000)
  expect(await factsOf(thread)).toBeUndefined()
  // By hand, it comes back.
  await daemon.dispatch(ATTACH, { thread: thread.id, url: URL })
  expect((await factsOf(thread))?.prs[0]?.how).toBe('hand')
})

it("without gh: says so in Settings and on a pull request attached by hand, and picks up once it's there", async () => {
  const gh = await fakeGh(dir, { login: 'octocat', prs: { 'acme/app#7': prNode('acme', 'app', 7) } })
  let path = join(dir, 'nowhere')
  daemon = await testDaemon({ extensions: [githubExtension({ env: () => ({ ...process.env, PATH: path }), intervals: FAST })] })
  const status = await daemon.watch<GhStatus | null>(STATUS)
  await status.until((s) => s?.installed === false, 'not installed')
  const thread = await daemon.thread()
  await daemon.dispatch(ATTACH, { thread: thread.id, url: URL })
  await until('its problem', (f) => f?.prs[0]?.error?.kind === 'missing', thread)
  expect((await factsOf(thread))!.prs[0]!.state).toBeUndefined()

  path = gh.bin
  await daemon.dispatch(REFRESH, {})
  await status.until((s) => s?.installed === true && s.hosts[0]?.login === 'octocat', 'signed in')
  await until('its state', (f) => f?.prs[0]?.state === 'open' && !f.prs[0].error, thread)

  // Signed out: said, and the state kept.
  await gh.set({ login: null })
  await daemon.dispatch(REFRESH, {})
  await until('signed out', (f) => f?.prs[0]?.error?.kind === 'signed-out' && f.prs[0].state === 'open', thread)
  expect(status.value?.problem).toMatch(/gh auth login/)
})

it('backs off a rate-limited host until it resets, and says why on its pull requests', async () => {
  const gh = await fakeGh(dir, { login: 'octocat', prs: { 'acme/app#7': prNode('acme', 'app', 7) } })
  daemon = await testDaemon({ extensions: [githubExtension({ env: gh.env, intervals: FAST })] })
  const thread = await daemon.thread()
  await daemon.dispatch(ATTACH, { thread: thread.id, url: URL })
  await until('its state', (f) => f?.prs[0]?.state === 'open', thread)
  const reset = Math.ceil(Date.now() / 1000) + 2
  await gh.set({ login: 'octocat', prs: { 'acme/app#7': prNode('acme', 'app', 7) }, rateLimitedUntil: reset })
  await until('rate-limited', (f) => f?.prs[0]?.error?.kind === 'rate-limited', thread)
  const asked = (await gh.calls()).filter((c) => c.args[1] === 'graphql').length
  // Held until the reset: nothing asked meanwhile, though everything's due every 100ms (a second, waited out).
  await new Promise((resolve) => setTimeout(resolve, 1000))
  expect((await gh.calls()).filter((c) => c.args[1] === 'graphql').length).toBe(asked)
  await until('asked again after the reset', (f) => f?.prs[0]?.state === 'open' && !f.prs[0].error, thread)
})

it("says a pull request that isn't there is not found, and pr_attach attaches one for the agent", async () => {
  const gh = await fakeGh(dir, { login: 'octocat', prs: {} })
  daemon = await testDaemon({
    extensions: [githubExtension({ env: gh.env, intervals: FAST })],
    model: [callTool('pr_attach', { url: URL }), say('Attached.')],
  })
  const thread = await daemon.thread('This is the PR for it')
  await until('not found', (f) => f?.prs[0]?.how === 'agent' && f.prs[0].error?.kind === 'not-found', thread)
})
