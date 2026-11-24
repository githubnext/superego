// git's daemon half against a real daemon: the changes in a thread's folder as a read, and Changes told to the agent
// while the machine has git on.
import { execFileSync } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ActionInfo, Pane, ThreadInfo } from '@superego/protocol'
import { callTool, say, testDaemon, type TestDaemon } from '@superego/sdk/testing'
import git from '../src/daemon.ts'
import { baseLabel, DIFF, type Base, type Changes } from '../src/shared.ts'

describe("a thread's changes, by git, from the base asked for", () => {
  // One repository for these: main, then a branch off it with one commit pushed to its upstream and one not, a staged
  // edit, an unstaged one and a new file; and main checked out in a worktree beside it, with an edit.
  let daemon: TestDaemon
  let repo: string
  let thread: ThreadInfo
  const run = (...args: string[]) => execFileSync('git', ['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args])
  const at = (ref: string) => run('rev-parse', ref).toString().trim()
  const changes = async (base?: Base, id = thread.id) => {
    const got = await daemon.call<Changes>(DIFF, { thread: id, ...(base ? { base } : {}) })
    if (!got.repo) throw new Error('not a repository')
    return got
  }
  beforeAll(async () => {
    daemon = await testDaemon({ extensions: [git] })
    repo = join(daemon.dataDir, 'repo')
    await mkdir(repo)
    const commit = async (file: string, text: string) => { await writeFile(join(repo, file), text); run('add', file); run('commit', '-q', '-m', file) }
    run('init', '-q', '-b', 'main')
    await commit('main.md', 'main\n')
    run('checkout', '-q', '-b', 'feature')
    await commit('pushed.md', 'pushed\n')
    run('remote', 'add', 'origin', join(daemon.dataDir, 'nowhere'))
    run('update-ref', 'refs/remotes/origin/feature', 'HEAD')
    run('branch', '-q', '--set-upstream-to', 'origin/feature')
    await commit('unpushed.md', 'unpushed\n')
    await writeFile(join(repo, 'main.md'), 'staged\n'); run('add', 'main.md')
    await writeFile(join(repo, 'pushed.md'), 'unstaged\n')
    await writeFile(join(repo, 'new.md'), 'new\n')
    thread = await daemon.thread(undefined, { cwd: repo })
  }, 20_000) // As long as a test has: a daemon to start, a dozen git commands
  afterAll(async () => { await daemon.close() })

  it("off main, the branch's work by default: every commit since main, and what isn't committed yet", async () => {
    const branch = await changes()
    expect(branch).toMatchObject({ base: 'branch', ref: at('main'), untracked: ['new.md'] })
    expect(branch.bases).toEqual([{ base: 'uncommitted' }, { base: 'staged' }, { base: 'branch', branch: 'main' }, { base: 'upstream', branch: 'origin/feature' }])
    expect(branch.bases.map(baseLabel)).toEqual(['Uncommitted', 'Staged', 'Since main', 'Since origin/feature'])
    for (const line of ['+++ b/pushed.md', '+unpushed', '+staged', '+unstaged']) expect(branch.diff).toContain(line)
    expect(await changes('branch')).toEqual(branch)
  })

  it('the uncommitted, the staged, and since the upstream', async () => {
    const uncommitted = await changes('uncommitted')
    expect(uncommitted).toMatchObject({ base: 'uncommitted', ref: at('HEAD'), untracked: ['new.md'] })
    for (const line of ['-main', '+staged', '-pushed', '+unstaged']) expect(uncommitted.diff).toContain(line)
    expect(uncommitted.diff).not.toContain('unpushed')

    const staged = await changes('staged')
    expect(staged).toMatchObject({ base: 'staged', ref: at('HEAD'), untracked: [] })
    expect(staged.diff).toContain('+staged')
    expect(staged.diff).not.toContain('unstaged')

    const upstream = await changes('upstream')
    expect(upstream).toMatchObject({ base: 'upstream', ref: at('origin/feature'), untracked: ['new.md'] })
    for (const line of ['+unpushed', '+staged', '-pushed', '+unstaged']) expect(upstream.diff).toContain(line)
    expect(upstream.diff).not.toContain('+pushed')
  })

  it('on main, the uncommitted by default, and neither a branch nor an upstream to offer: asked for one, the default', async () => {
    const main = join(daemon.dataDir, 'main')
    run('worktree', 'add', '-q', main, 'main')
    await writeFile(join(main, 'main.md'), 'edited\n')
    const onMain = await daemon.thread(undefined, { cwd: main })
    for (const base of [undefined, 'branch', 'upstream'] as const) {
      const got = await changes(base, onMain.id)
      expect(got).toMatchObject({ base: 'uncommitted', bases: [{ base: 'uncommitted' }, { base: 'staged' }] })
      expect(got.diff).toContain('+edited')
    }
  })

  it("is a read, not an action; a folder that isn't a repository says so, and a base there isn't is refused", async () => {
    expect(daemon.extensions.map((e) => e.name)).toContain('git')
    expect((await daemon.call<ActionInfo[]>('action.list')).map((a) => a.id)).not.toContain(DIFF)
    const plain = await daemon.thread()
    expect(await daemon.call<Changes>(DIFF, { thread: plain.id })).toEqual({ repo: false })
    await expect(daemon.call(DIFF, { thread: thread.id, base: 'yesterday' })).rejects.toThrow()
  })
})

it('measures a repository with no commits yet from nothing', async () => {
  const daemon = await testDaemon({ extensions: [git] })
  const repo = join(daemon.dataDir, 'fresh')
  await mkdir(repo)
  execFileSync('git', ['-C', repo, 'init', '-q', '-b', 'main'])
  await writeFile(join(repo, 'first.md'), 'first\n')
  execFileSync('git', ['-C', repo, 'add', 'first.md'])
  await writeFile(join(repo, 'first.md'), 'second\n')
  const thread = await daemon.thread(undefined, { cwd: repo })
  const staged = await daemon.call<Changes>(DIFF, { thread: thread.id, base: 'staged' })
  expect(staged).toMatchObject({ repo: true, base: 'staged', bases: [{ base: 'uncommitted' }, { base: 'staged' }] })
  expect(staged.repo && staged.diff).toContain('+first')
  const uncommitted = await daemon.call<Changes>(DIFF, { thread: thread.id })
  expect(uncommitted).toMatchObject({ repo: true, base: 'uncommitted' })
  expect(uncommitted.repo && uncommitted.diff).toContain('+second')
  await daemon.close()
})

type Result = { role?: string; toolCallId?: string; isError?: boolean; content?: { text?: string }[] }
/** A thread's tool result for the call `id`. */
const result = async (daemon: TestDaemon, thread: string, id: string) => (JSON.parse(await daemon.transcript(thread)) as { model?: Result[] }[])
  .map((entry) => entry.model?.[0]).find((message) => message?.role === 'toolResult' && message.toolCallId === id)!
const panes = async (daemon: TestDaemon, thread: string) => ((await daemon.call<ThreadInfo[]>('thread.list')).find((t) => t.id === thread)!.panes ?? []) as Pane[]

it('tells the agent it can open Changes and opens it, unless the machine has git off', async () => {
  const open = (id: string) => callTool('pane_open', { kind: 'diff' }, id)
  const daemon = await testDaemon({ extensions: [git], model: [open('on'), say('There.'), open('off'), say('There.')] })
  const on = await daemon.thread('show me')
  expect(await daemon.transcript(on.id)).toContain('\\"diff\\": the changes in the working folder')
  expect((await result(daemon, on.id, 'on')).isError).toBeFalsy()
  expect((await panes(daemon, on.id)).map((p) => p.kind)).toEqual(['diff'])

  await daemon.call('settings.set', { key: 'extensions.git', value: false })
  const off = await daemon.thread('show me')
  expect(await daemon.transcript(off.id)).not.toContain('\\"diff\\": the changes')
  // Refused, naming the kinds there are.
  const refused = await result(daemon, off.id, 'off')
  expect(refused.isError).toBe(true)
  expect(refused.content?.[0]?.text).toContain('no "diff" pane')
  expect(refused.content?.[0]?.text).toContain('"editor"')
  expect(await panes(daemon, off.id)).toEqual([])
  await daemon.close()
})
