// @vitest-environment happy-dom
// `/clear` in the composer of a thread in a worktree of its own, in the window over a real daemon: the new thread gets a
// worktree of its own too, from the same checkout, and the old one's goes with it as it's archived (left clean).
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import type { ThreadInfo } from '@superego/protocol'
import { mountUi, testDaemon, type TestDaemon, type TestWindow } from '@superego/sdk/testing'
import worktrees from '../src/daemon.ts'
import worktreesUi from '../src/ui.tsx'
import type { Worktree } from '../src/shared.ts'

let repo: string
let data: string
let daemon: TestDaemon
let ui: TestWindow | undefined
beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'superego-clear-repo-'))
  data = await mkdtemp(join(tmpdir(), 'superego-clear-data-'))
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { encoding: 'utf8' })
  execFileSync('git', ['init', '-q', repo])
  await writeFile(join(repo, 'readme.md'), 'hi\n')
  git('add', '.'); git('commit', '-q', '-m', 'start')
  daemon = await testDaemon({ extensions: [worktrees], dataDir: data, model: 'echo' })
})
afterEach(async () => {
  await ui?.unmount(); ui = undefined
  await daemon.close()
  await Promise.all([repo, data].map((d) => rm(d, { recursive: true, force: true })))
})

const treeOf = (thread: ThreadInfo | undefined) => thread?.facts?.worktrees as Worktree | undefined

it('starts the new thread in a worktree of its own, from the same checkout, and removes the old one’s', async () => {
  const old = await daemon.call<ThreadInfo>('thread.start', { cwd: repo, title: 'In a tree', options: { worktrees: true } })
  const tree = treeOf(old)!
  expect(old.cwd).toBe(tree.path)
  ui = await mountUi({ window: true, extensions: [worktreesUi], machines: [daemon], select: { thread: old.id } })
  await ui.until(() => document.querySelector('.thread__title')?.textContent === 'In a tree', 'the thread shown')
  await ui.type('.composer textarea', '/clear')
  await ui.key('enter')

  let next: ThreadInfo | undefined
  await ui.until(async () => {
    next = (await daemon.call<ThreadInfo[]>('thread.list', {})).find((t) => t.id !== old.id)
    return Boolean(next && treeOf(next)) && ui!.registry.window.selection?.thread === next!.id
  }, 'the new thread, in a worktree, shown')
  expect(next!.project).toEqual({ root: await realpath(repo), name: old.project.name })
  expect(treeOf(next)!.path).not.toBe(tree.path)
  expect(next!.cwd).toBe(treeOf(next)!.path)
  await ui.until(async () => (await daemon.call<ThreadInfo[]>('thread.list', { archived: true })).some((t) => t.id === old.id), 'the old one archived')
  expect(existsSync(tree.path)).toBe(false)
})
