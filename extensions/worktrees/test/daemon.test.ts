// worktrees against a real daemon: a thread's own worktree made, removed when archived clean, kept with changes, put
// back when unarchived; what a previous process left half-deleted swept; and a worktree kept before extensions had state.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { connectSocket, defineDaemonExtension, listen, openDaemon, type DaemonExtension } from '@superego/daemon'
import { defineApp, PROTOCOL_VERSION, RpcError, type Hello, type Json, type RpcPeer, type ThreadInfo } from '@superego/protocol'
import worktrees from '../src/daemon.ts'
import type { Worktree } from '../src/shared.ts'

for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_OAUTH_TOKEN', 'OPENAI_API_KEY']) delete process.env[key]
const SUPEREGO = defineApp({ name: 'superego', id: 'superego' })
let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'superego-worktrees-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

async function open(dataDir = dir, more: DaemonExtension[] = [], model = 'faux') {
  process.env.SUPEREGO_MODEL = model
  process.env.SUPEREGO_REPLAY_SPEED = '0'
  const daemon = await openDaemon({ app: SUPEREGO, dataDir, defaultCwd: dir, agentsDir: join(dir, 'agents'), extensions: [worktrees, ...more] })
  const server = await listen(daemon, join(dataDir, 'superego.sock'))
  const { peer, socket } = await connectSocket(join(dataDir, 'superego.sock'))
  const hello = await peer.call<Hello>('hello', { client: 'test', version: PROTOCOL_VERSION })
  return { peer, hello, close: async () => { socket.destroy(); server.close(); await daemon.close() } }
}
const until = async (check: () => boolean | Promise<boolean>, ms = 5000) => {
  const end = Date.now() + ms
  while (!(await check())) {
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}
const listed = async (peer: RpcPeer, archived = false) => peer.call<ThreadInfo[]>('thread.list', { archived })
const find = async (peer: RpcPeer, id: string) => [...await listed(peer), ...await listed(peer, true)].find((t) => t.id === id)
/** A thread's worktree, as clients see it: the extension's fact. */
const treeOf = (thread: ThreadInfo | undefined) => thread?.ext?.worktrees as Worktree | undefined
/** Archive a thread: what `thread.archive` says (`notes`). */
const archive = (peer: RpcPeer, id: string) => peer.call<{ notes: Record<string, string> }>('thread.archive', { thread: id })
/** A repository in the test's folder, with a first commit. */
function repository() {
  const git = (...args: string[]) => execFileSync('git', ['-C', dir, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { encoding: 'utf8' }).trim()
  execFileSync('git', ['init', '-q', dir])
  writeFileSync(join(dir, 'readme.md'), 'hi\n')
  git('add', '.'); git('commit', '-q', '-m', 'start')
  return git
}

it('is required, and announced', async () => {
  const { hello, close } = await open()
  expect(hello.features).toContain('ext:worktrees')
  await close()
})

it('gives a thread in a repository a worktree of its own when asked, in the same project, removed when archived clean', async () => {
  const git = (...args: string[]) => execFileSync('git', ['-C', dir, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { encoding: 'utf8' }).trim()
  execFileSync('git', ['init', '-q', dir])
  await mkdir(join(dir, 'app'))
  await writeFile(join(dir, 'app/readme.md'), 'hi\n')
  git('add', '.'); git('commit', '-q', '-m', 'start')
  const root = await realpath(dir)
  const { peer, close } = await open()
  // Started in a folder below the top: the same folder, in its own worktree.
  const thread = await peer.call<ThreadInfo>('thread.start', { cwd: join(dir, 'app'), title: 'Fix the login flow', worktree: true })
  const tree = treeOf(thread)!
  expect(tree.branch).toMatch(/^superego\/fix-the-login-flow-[0-9a-f]{6}$/)
  expect(thread.cwd).toBe(join(tree.path, 'app'))
  expect(thread.project).toEqual({ root, name: basename(root) })
  expect(git('branch', '--list', tree.branch)).toContain(tree.branch)
  // Otherwise in place: the same project.
  const here = await peer.call<ThreadInfo>('thread.start', { cwd: dir })
  expect(treeOf(here)).toBeUndefined()
  expect(here.project.root).toBe(root)
  // Archived with nothing uncommitted: the worktree goes, the branch stays; unarchived, it's back.
  expect(await archive(peer, thread.id)).toEqual({ notes: { worktrees: `Removed the worktree ${tree.path}; branch ${tree.branch} kept.` } })
  expect(existsSync(tree.path)).toBe(false)
  expect(git('branch', '--list', tree.branch)).toContain(tree.branch)
  // Let go of by git at once; its files deleted after.
  expect(git('worktree', 'list')).not.toContain(tree.path)
  await until(async () => (await readdir(dirname(tree.path))).length === 0)
  await peer.call('thread.unarchive', { thread: thread.id })
  expect(existsSync(join(tree.path, 'app/readme.md'))).toBe(true)
  // With changes in it, archiving leaves it be.
  await writeFile(join(tree.path, 'app/wip.md'), 'wip\n')
  expect(await archive(peer, thread.id)).toEqual({ notes: { worktrees: `Kept the worktree ${tree.path}: it has uncommitted changes.` } })
  expect(existsSync(join(tree.path, 'app/wip.md'))).toBe(true)
  // Gone already (deleted by hand): said so, not that it was removed.
  await peer.call('thread.unarchive', { thread: thread.id })
  await rm(tree.path, { recursive: true, force: true })
  expect((await archive(peer, thread.id)).notes).toEqual({ worktrees: `Its worktree ${tree.path} was already gone; branch ${tree.branch} kept.` })
  await close()
})

it('deletes the worktrees a previous process was deleting when it ended', async () => {
  const repo = join(dir, 'worktrees', 'app')
  await mkdir(join(repo, '.fix-a1b2c3.removing-0badf00d', 'node_modules'), { recursive: true })
  await mkdir(join(repo, 'in-use-d4e5f6'), { recursive: true })
  const { close } = await open()
  await until(async () => !existsSync(join(repo, '.fix-a1b2c3.removing-0badf00d')))
  expect(existsSync(join(repo, 'in-use-d4e5f6'))).toBe(true)
  await close()
})

it("takes its worktree and branch back when a later extension refuses the thread", async () => {
  const git = repository()
  const refuses = defineDaemonExtension({ name: 'refuses', setup(superego) { superego.thread({ creating() { throw new RpcError('refused', 'Not today') } }) } })
  const { peer, close } = await open(dir, [refuses])
  await expect(peer.call('thread.start', { cwd: dir, title: 'Doomed', worktree: true })).rejects.toThrow(/Not today/)
  expect(await peer.call('thread.list', {})).toEqual([])
  expect(git('branch', '--list', 'superego/*')).toBe('')
  expect(git('worktree', 'list').split('\n')).toHaveLength(1)
  await close()
})

it("gives a profile's threads worktrees through its options, unless a thread is started otherwise", async () => {
  repository()
  mkdirSync(join(dir, '.superego', 'profiles', 'default'), { recursive: true })
  writeFileSync(join(dir, '.superego', 'profiles', 'default', 'profile.ts'), "export default { options: { worktrees: true } }\n")
  await mkdir(join(dir, 'data'), { recursive: true })
  const { peer, close } = await open(join(dir, 'data'))
  await peer.call('profile.allow', { cwd: dir })
  expect(treeOf(await peer.call<ThreadInfo>('thread.start', { cwd: dir, title: 'From the profile' }))?.branch).toMatch(/^superego\/from-the-profile-/)
  expect(treeOf(await peer.call<ThreadInfo>('thread.start', { cwd: dir, title: 'In place', worktree: false }))).toBeUndefined()
  await close()
})

it("brings a thread back without its worktree when there's no checkout to restore it from", async () => {
  repository()
  const { peer, close } = await open()
  const thread = await peer.call<ThreadInfo>('thread.start', { cwd: dir, title: 'Orphan', worktree: true })
  expect(Object.values((await archive(peer, thread.id)).notes)[0]).toMatch(/^Removed the worktree/)
  // Its main checkout is no repository any more: nothing to put it back from, so it comes back without rather than refusing.
  rmSync(join(dir, '.git'), { recursive: true, force: true })
  await peer.call('thread.unarchive', { thread: thread.id })
  expect((await find(peer, thread.id))!.archived).toBeUndefined()
  expect(treeOf(await find(peer, thread.id))).toMatchObject({ removed: true })
  await close()
})

it('stops what still runs from a worktree before archiving removes it, but leaves the daemon be', async () => {
  repository()
  const { spawn } = await import('node:child_process')
  const { peer, close } = await open()
  const thread = await peer.call<ThreadInfo>('thread.start', { cwd: dir, title: 'Busy', worktree: true })
  const tree = treeOf(thread)!
  // One working in it (a shell left there), one run from a file in it (a dev server), each in a group of its own.
  const working = spawn('sleep', ['60'], { cwd: tree.path, detached: true, stdio: 'ignore' })
  const serving = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', join(tree.path, 'server.js')], { cwd: dir, detached: true, stdio: 'ignore' })
  const exited = (child: typeof working) => new Promise<void>((resolve) => child.once('exit', () => resolve()))
  const ended = Promise.all([exited(working), exited(serving)])
  await new Promise((resolve) => setTimeout(resolve, 200))
  expect(Object.values((await archive(peer, thread.id)).notes)[0]).toMatch(/^Removed the worktree/)
  await ended
  expect(existsSync(tree.path)).toBe(false)
  await close()
})

it("is removed when the thread tools archive a thread, a thread's own only once its turn ends", async () => {
  const git = repository()
  writeFileSync(join(dir, '.gitignore'), '*\n!readme.md\n!.gitignore\n')
  git('add', '.'); git('commit', '-q', '-m', 'ignore')
  const { default: threadTools } = await import('@superego/threads/daemon')
  const turn = (content: Json[], stopReason: string) => JSON.stringify({ at: 0, provider: 'x', model: 'x', message: { role: 'assistant', content, stopReason } })
  const first = await open(dir, [threadTools])
  const child = await first.peer.call<ThreadInfo>('thread.start', { cwd: dir, title: 'Child', worktree: true })
  await first.close()
  // The child archived, then itself; and it carries on in its worktree to the end of its turn.
  writeFileSync(join(dir, 'turns.jsonl'), [
    turn([{ type: 'toolCall', id: 'c1', name: 'thread_archive', arguments: { thread: child.id } }], 'toolUse'),
    turn([{ type: 'toolCall', id: 'c2', name: 'thread_archive', arguments: {} }], 'toolUse'),
    turn([{ type: 'toolCall', id: 'c3', name: 'bash', arguments: { command: 'ls' } }], 'toolUse'),
    turn([{ type: 'text', text: 'Done.' }], 'stop'),
  ].join('\n') + '\n')
  const { peer, close } = await open(dir, [threadTools], `replay:${join(dir, 'turns.jsonl')}`)
  const self = await peer.call<ThreadInfo>('thread.start', { cwd: dir, title: 'Self', worktree: true, prompt: 'tidy up' })
  const selfTree = treeOf(self)!
  // What archiving itself did is said in it, as Superego's note.
  await until(async () => JSON.stringify((await peer.call<{ value: { entries: unknown[] } }>('thread.watch', { thread: self.id })).value.entries).includes(`Archived. Removed the worktree ${selfTree.path}; branch ${selfTree.branch} kept.`))
  const entries = JSON.stringify((await peer.call<{ value: { entries: unknown[] } }>('thread.watch', { thread: self.id })).value.entries)
  const childTree = treeOf(child)!
  expect(entries).toContain(`Archived [Child](thread:${child.id}). Removed the worktree ${childTree.path}; branch ${childTree.branch} kept.`)
  expect(entries).toContain('readme.md') // its worktree was still there for the rest of the turn
  expect(entries).toContain('Done.')
  // Both worktrees gone, both branches kept.
  for (const t of [child, self]) {
    expect(existsSync(treeOf(t)!.path)).toBe(false)
    expect(git('branch', '--list', treeOf(t)!.branch)).toContain(treeOf(t)!.branch)
  }
  await close()
})
