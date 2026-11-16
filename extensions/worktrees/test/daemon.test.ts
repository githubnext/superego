// worktrees against a real daemon: a thread's own worktree made, removed when archived clean, kept with changes, put
// back when unarchived; its branch deleted when merged and made again, kept when not; and what a previous process left
// half done (folders half-deleted, merged branches kept) swept.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { defineDaemonExtension, type DaemonExtension } from '@superego/daemon'
import { RpcError, type ThreadInfo } from '@superego/protocol'
import { callTool, say, testDaemon, type TestDaemon } from '@superego/sdk/testing'
import worktrees from '../src/daemon.ts'
import type { Worktree } from '../src/shared.ts'

// The test's folder: the daemon's data, and (most tests) the repository too.
let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'superego-worktrees-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

const open = (more: DaemonExtension[] = [], options: Parameters<typeof testDaemon>[0] = {}) => testDaemon({ extensions: [worktrees, ...more], dataDir: dir, ...options })
const listed = async (daemon: TestDaemon, archived = false) => daemon.call<ThreadInfo[]>('thread.list', { archived })
const find = async (daemon: TestDaemon, id: string) => [...await listed(daemon), ...await listed(daemon, true)].find((t) => t.id === id)
const start = (daemon: TestDaemon, params: Record<string, unknown>) => daemon.call<ThreadInfo>('thread.start', params)
/** A thread's worktree, as clients see it: the extension's fact. */
const treeOf = (thread: ThreadInfo | undefined) => thread?.facts?.worktrees as Worktree | undefined
/** Archive a thread: what `thread.archive` says (`notes`). */
const archive = (daemon: TestDaemon, id: string) => daemon.call<{ notes: Record<string, string> }>('thread.archive', { thread: id })
/** A repository in the test's folder, with a first commit; what the daemon keeps there ignored. */
function repository() {
  const git = (...args: string[]) => execFileSync('git', ['-C', dir, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { encoding: 'utf8' }).trim()
  execFileSync('git', ['init', '-q', dir])
  writeFileSync(join(dir, 'readme.md'), 'hi\n')
  git('add', '.'); git('commit', '-q', '-m', 'start')
  return git
}

it('is required, and announced', async () => {
  const daemon = await open()
  expect(daemon.extensions.map((e) => e.name)).toContain('worktrees')
  await daemon.close()
})

it('gives a thread in a repository a worktree of its own when asked, in the same project, removed when archived clean', async () => {
  const git = (...args: string[]) => execFileSync('git', ['-C', dir, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { encoding: 'utf8' }).trim()
  execFileSync('git', ['init', '-q', dir])
  await mkdir(join(dir, 'app'))
  await writeFile(join(dir, 'app/readme.md'), 'hi\n')
  git('add', '.'); git('commit', '-q', '-m', 'start')
  const root = await realpath(dir)
  const daemon = await open()
  // Started in a folder below the top: the same folder, in its own worktree.
  const thread = await start(daemon, { cwd: join(dir, 'app'), title: 'Fix the login flow', options: { worktrees: true } })
  const tree = treeOf(thread)!
  expect(tree.branch).toMatch(new RegExp(`^${daemon.app.id}/fix-the-login-flow-[0-9a-f]{6}$`))
  expect(thread.cwd).toBe(join(tree.path, 'app'))
  expect(thread.project).toEqual({ root, name: basename(root) })
  expect(git('branch', '--list', tree.branch)).toContain(tree.branch)
  // Otherwise in place: the same project.
  const here = await start(daemon, { cwd: dir })
  expect(treeOf(here)).toBeUndefined()
  expect(here.project.root).toBe(root)
  // Archived with nothing uncommitted: the worktree goes, and its branch, merged (nothing on it); unarchived, both are back.
  expect(await archive(daemon, thread.id)).toEqual({ notes: { worktrees: `Removed the worktree ${tree.path}; branch ${tree.branch} deleted (merged).` } })
  expect(existsSync(tree.path)).toBe(false)
  expect(git('branch', '--list', tree.branch)).toBe('')
  // Let go of by git at once; its files deleted after.
  expect(git('worktree', 'list')).not.toContain(tree.path)
  await daemon.until(async () => (await readdir(dirname(tree.path))).length === 0, 'its files deleted')
  await daemon.call('thread.unarchive', { thread: thread.id })
  expect(existsSync(join(tree.path, 'app/readme.md'))).toBe(true)
  // With changes in it, archiving leaves it be.
  await writeFile(join(tree.path, 'app/wip.md'), 'wip\n')
  expect(await archive(daemon, thread.id)).toEqual({ notes: { worktrees: `Kept the worktree ${tree.path}: it has uncommitted changes.` } })
  expect(existsSync(join(tree.path, 'app/wip.md'))).toBe(true)
  // Gone already (deleted by hand): said so, not that it was removed.
  await daemon.call('thread.unarchive', { thread: thread.id })
  await rm(tree.path, { recursive: true, force: true })
  expect((await archive(daemon, thread.id)).notes).toEqual({ worktrees: `Its worktree ${tree.path} was already gone; branch ${tree.branch} deleted (merged).` })
  await daemon.close()
})

it('deletes the worktrees a previous process was deleting when it ended, and says when it can\'t', async () => {
  const repo = join(dir, 'worktrees', 'app')
  await mkdir(join(repo, '.fix-a1b2c3.removing-0badf00d', 'node_modules'), { recursive: true })
  await mkdir(join(repo, 'in-use-d4e5f6'), { recursive: true })
  // One it can't delete: a folder in it that can't be written to.
  const stuck = join(repo, '.stuck-f00f00.removing-12345678')
  await mkdir(join(stuck, 'locked'), { recursive: true })
  await writeFile(join(stuck, 'locked', 'file'), 'x')
  await chmod(join(stuck, 'locked'), 0o555)
  const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
  let daemon: TestDaemon
  try {
    daemon = await open()
    await daemon.until(async () => !existsSync(join(repo, '.fix-a1b2c3.removing-0badf00d')), 'the one half deleted')
    await daemon.until(() => logged.mock.calls.some((call) => String(call[0]).includes(`deleting ${stuck} failed`)), 'the stuck one logged')
    expect(existsSync(join(repo, 'in-use-d4e5f6'))).toBe(true)
  } finally {
    logged.mockRestore()
    await chmod(join(stuck, 'locked'), 0o755)
  }
  // Tried again the next time.
  const again = await daemon.restart()
  await again.until(async () => !existsSync(stuck), 'the stuck one deleted')
  await again.close()
})

it("deletes a merged branch when archiving removes its worktree, and makes it again where it was when unarchived", async () => {
  const git = repository()
  const daemon = await open()
  const thread = await start(daemon, { cwd: dir, title: 'Merged', options: { worktrees: true } })
  const tree = treeOf(thread)!
  writeFileSync(join(tree.path, 'work.md'), 'work\n')
  execFileSync('git', ['-C', tree.path, 'add', 'work.md'])
  execFileSync('git', ['-C', tree.path, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'work'])
  const tip = execFileSync('git', ['-C', tree.path, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  // Merged into main, and main moved on since.
  git('merge', '-q', '--ff-only', tree.branch)
  writeFileSync(join(dir, 'later.md'), 'later\n')
  git('add', 'later.md'); git('commit', '-q', '-m', 'later')
  expect(await archive(daemon, thread.id)).toEqual({ notes: { worktrees: `Removed the worktree ${tree.path}; branch ${tree.branch} deleted (merged).` } })
  expect(git('branch', '--list', tree.branch)).toBe('')
  expect(treeOf(await find(daemon, thread.id))).toMatchObject({ removed: true, commit: tip })
  await daemon.call('thread.unarchive', { thread: thread.id })
  expect(git('rev-parse', tree.branch)).toBe(tip)
  expect(existsSync(join(tree.path, 'work.md'))).toBe(true)
  expect(treeOf(await find(daemon, thread.id))).toEqual({ path: tree.path, branch: tree.branch, root: tree.root })
  await daemon.close()
})

it("keeps an unmerged branch when archiving removes its worktree, and deletes it as the daemon starts once it's merged", async () => {
  const git = repository()
  const first = await open()
  const thread = await start(first, { cwd: dir, title: 'Unfinished', options: { worktrees: true } })
  const tree = treeOf(thread)!
  writeFileSync(join(tree.path, 'wip.md'), 'wip\n')
  execFileSync('git', ['-C', tree.path, 'add', 'wip.md'])
  execFileSync('git', ['-C', tree.path, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'wip'])
  expect(await archive(first, thread.id)).toEqual({ notes: { worktrees: `Removed the worktree ${tree.path}; branch ${tree.branch} kept: not merged.` } })
  expect(git('branch', '--list', tree.branch)).toContain(tree.branch)
  // Merged later, by hand, while the daemon is stopped: gone the next time it starts.
  const daemon = await first.restart({ whileStopped: () => git('merge', '-q', '--ff-only', tree.branch) })
  await daemon.until(() => git('branch', '--list', tree.branch) === '', 'the merged branch deleted')
  await daemon.close()
})

it("takes its worktree and branch back when a later extension refuses the thread", async () => {
  const git = repository()
  const refuses = defineDaemonExtension({ name: 'refuses', setup(superego) { superego.thread({ starting() { throw new RpcError('refused', 'Not today') } }) } })
  const daemon = await open([refuses])
  await expect(start(daemon, { cwd: dir, title: 'Doomed', options: { worktrees: true } })).rejects.toThrow(/Not today/)
  expect(await listed(daemon)).toEqual([])
  expect(git('branch', '--list', `${daemon.app.id}/*`)).toBe('')
  expect(git('worktree', 'list').split('\n')).toHaveLength(1)
  await daemon.close()
})

it("gives a profile's threads worktrees through its options, unless a thread is started otherwise", async () => {
  repository()
  mkdirSync(join(dir, '.superego', 'profiles', 'default'), { recursive: true })
  writeFileSync(join(dir, '.superego', 'profiles', 'default', 'profile.ts'), "export default { options: { worktrees: true } }\n")
  const daemon = await open([], { dataDir: join(dir, 'data') })
  await daemon.call('profile.allow', { cwd: dir })
  expect(treeOf(await start(daemon, { cwd: dir, title: 'From the profile' }))?.branch).toMatch(new RegExp(`^${daemon.app.id}/from-the-profile-`))
  expect(treeOf(await start(daemon, { cwd: dir, title: 'In place', options: { worktrees: false } }))).toBeUndefined()
  await daemon.close()
})

it("brings a thread back without its worktree when there's no checkout to restore it from", async () => {
  repository()
  const daemon = await open()
  const thread = await start(daemon, { cwd: dir, title: 'Orphan', options: { worktrees: true } })
  expect(Object.values((await archive(daemon, thread.id)).notes)[0]).toMatch(/^Removed the worktree/)
  // Its main checkout is no repository any more: nothing to put it back from, so it comes back without rather than refusing.
  rmSync(join(dir, '.git'), { recursive: true, force: true })
  await daemon.call('thread.unarchive', { thread: thread.id })
  expect((await find(daemon, thread.id))!.archived).toBeUndefined()
  expect(treeOf(await find(daemon, thread.id))).toMatchObject({ removed: true })
  await daemon.close()
})

it('stops what still runs from a worktree before archiving removes it, but leaves the daemon be', async () => {
  repository()
  const { spawn } = await import('node:child_process')
  const daemon = await open()
  const thread = await start(daemon, { cwd: dir, title: 'Busy', options: { worktrees: true } })
  const tree = treeOf(thread)!
  // One working in it (a shell left there), one run from a file in it (a dev server), each in a group of its own.
  const working = spawn('sleep', ['60'], { cwd: tree.path, detached: true, stdio: 'ignore' })
  const serving = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', join(tree.path, 'server.js')], { cwd: dir, detached: true, stdio: 'ignore' })
  const exited = (child: typeof working) => new Promise<void>((resolve) => child.once('exit', () => resolve()))
  const ended = Promise.all([exited(working), exited(serving)])
  await Promise.all([working, serving].map((child) => new Promise((resolve) => child.once('spawn', resolve))))
  expect(Object.values((await archive(daemon, thread.id)).notes)[0]).toMatch(/^Removed the worktree/)
  await ended
  expect(existsSync(tree.path)).toBe(false)
  await daemon.close()
})

it("is removed when the thread tools archive a thread, a thread's own only once its turn ends", async () => {
  const git = repository()
  writeFileSync(join(dir, '.gitignore'), '*\n!readme.md\n!.gitignore\n')
  git('add', '.'); git('commit', '-q', '-m', 'ignore')
  const { default: threadTools } = await import('@superego/thread-tools/daemon')
  const first = await open([threadTools])
  const child = await start(first, { cwd: dir, title: 'Child', options: { worktrees: true } })
  // The child archived, then itself; and it carries on in its worktree to the end of its turn.
  const daemon = await first.restart({ model: [
    callTool('thread_archive', { thread: child.id }), callTool('thread_archive'), callTool('bash', { command: 'ls' }), say('Done.'),
  ] })
  const self = await start(daemon, { cwd: dir, title: 'Self', options: { worktrees: true }, prompt: 'tidy up' })
  const selfTree = treeOf(self)!
  // What archiving itself did is said in it, as Superego's note.
  await daemon.until(async () => (await daemon.transcript(self.id)).includes(`Archived. Removed the worktree ${selfTree.path}; branch ${selfTree.branch} deleted (merged).`), 'its own archiving noted')
  const entries = await daemon.transcript(self.id)
  const childTree = treeOf(child)!
  expect(entries).toContain(`Archived [Child](thread:${child.id}). Removed the worktree ${childTree.path}; branch ${childTree.branch} deleted (merged).`)
  expect(entries).toContain('readme.md') // its worktree was still there for the rest of the turn
  expect(entries).toContain('Done.')
  // Both worktrees gone, and both branches, merged (nothing on them).
  for (const t of [child, self]) {
    expect(existsSync(treeOf(t)!.path)).toBe(false)
    expect(git('branch', '--list', treeOf(t)!.branch)).toBe('')
  }
  await daemon.close()
})
