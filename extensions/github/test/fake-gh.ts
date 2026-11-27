// A stand-in for `gh` on a PATH of its own, for tests: fake-gh.cjs, answering from a JSON file the test writes (who's
// signed in, the pull requests GitHub has, each branch's, whether it's rate-limited), and logging each call it gets.
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** What the fake GitHub holds. `prs`: GraphQL pull request nodes by `owner/repo#number`. */
export type FakeGitHub = {
  login?: string | null
  prs?: Record<string, Record<string, unknown>>
  branches?: Record<string, string[]>
  /** Every API call fails with a rate limit until this time (seconds since the epoch). */
  rateLimitedUntil?: number
  /** Every API call fails with this. */
  failing?: string
}

/** A fake gh in `dir/bin`: `env()` is an environment with only it on PATH; `set` changes what GitHub holds; `calls` what it was asked. */
export async function fakeGh(dir: string, world: FakeGitHub = { login: 'octocat' }) {
  const bin = join(dir, 'bin')
  await mkdir(bin, { recursive: true })
  await writeFile(join(dir, 'github.json'), JSON.stringify(world))
  await writeFile(join(bin, 'gh'), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(join(import.meta.dirname, 'fake-gh.cjs'))} ${JSON.stringify(dir)} "$@"\n`)
  await chmod(join(bin, 'gh'), 0o755)
  return {
    bin,
    env: (): NodeJS.ProcessEnv => ({ ...process.env, PATH: bin }),
    async set(next: FakeGitHub) { await writeFile(join(dir, 'github.json'), JSON.stringify(next)) },
    async calls(): Promise<{ args: string[]; cwd: string; prompt?: string }[]> {
      return (await readFile(join(dir, 'calls.jsonl'), 'utf8').catch(() => '')).split('\n').filter(Boolean).map((l) => JSON.parse(l))
    },
  }
}

/** A pull request as GitHub's GraphQL gives it (the fields the poller asks for), open with checks passing unless changed. */
export function prNode(owner: string, repo: string, number: number, more: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    number, title: `Pull request ${number}`, url: `https://github.com/${owner}/${repo}/pull/${number}`, state: 'OPEN', isDraft: false,
    mergeable: 'MERGEABLE', reviewDecision: 'REVIEW_REQUIRED', headRefName: 'feature', baseRefName: 'main', headRefOid: 'a1f3c9e0000000000000000000000000000000ff',
    author: { login: 'octocat' }, latestReviews: { nodes: [] }, reviewThreads: { nodes: [] },
    commits: { nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS', contexts: { nodes: [
      { __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS', startedAt: '2026-01-01T10:00:00Z', completedAt: '2026-01-01T10:04:41Z', detailsUrl: `https://github.com/${owner}/${repo}/actions/runs/11/job/1` },
    ] } } } }] },
    ...more,
  }
}

/** A failing check run, as the rollup lists it. */
export const failedCheck = (owner: string, repo: string, name: string, run: number) => ({
  __typename: 'CheckRun', name, status: 'COMPLETED', conclusion: 'FAILURE', startedAt: '2026-01-01T10:00:00Z', completedAt: '2026-01-01T10:07:55Z',
  detailsUrl: `https://github.com/${owner}/${repo}/actions/runs/${run}/job/2`,
})
