// worktrees against a real daemon: a thread's own worktree made, removed when archived clean, kept with changes, put
// back when unarchived; what a previous process left half-deleted swept; and a worktree kept before extensions had state.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { connectSocket, listen, openDaemon } from '@superego/daemon'
import { defineApp, PROTOCOL_VERSION, type Hello, type Json, type RpcPeer, type ThreadInfo } from '@superego/protocol'
import worktrees from '../src/daemon.ts'
import type { Worktree } from '../src/shared.ts'

for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_OAUTH_TOKEN', 'OPENAI_API_KEY']) delete process.env[key]
const SUPEREGO = defineApp({ name: 'superego', id: 'superego' })
let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'superego-worktrees-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

async function open(dataDir = dir) {
  process.env.SUPEREGO_MODEL = 'faux'
  const daemon = await openDaemon({ app: SUPEREGO, dataDir, defaultCwd: dir, agentsDir: join(dir, 'agents'), extensions: [worktrees] })
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
/** Archive a thread, and say what became of its worktree (as `thread.archive` once did). */
async function archive(peer: RpcPeer, id: string) {
  await peer.call('thread.archive', { id })
  const tree = treeOf(await find(peer, id))
  return { worktree: tree ? (tree.removed ? 'removed' : 'kept') : null }
}

it('is required, and announced', async () => {
  const { hello, close } = await open()
  expect(hello.features).toContain('ext:worktrees')
  await close()
})

it('gives a thread in a repository a worktree of its own when asked, in the same session, removed when archived clean', async () => {
  const git = (...args: string[]) => execFileSync('git', ['-C', dir, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { encoding: 'utf8' }).trim()
  execFileSync('git', ['init', '-q', dir])
  await mkdir(join(dir, 'app'))
  await writeFile(join(dir, 'app/readme.md'), 'hi\n')
  git('add', '.'); git('commit', '-q', '-m', 'start')
  const root = await realpath(dir)
  const { peer, close } = await open()
  // Started in a folder below the top: the same folder, in its own worktree.
  const thread = await peer.call<ThreadInfo>('thread.create', { cwd: join(dir, 'app'), title: 'Fix the login flow', worktree: true })
  const tree = treeOf(thread)!
  expect(tree.branch).toMatch(/^superego\/fix-the-login-flow-[0-9a-f]{6}$/)
  expect(thread.cwd).toBe(join(tree.path, 'app'))
  expect(thread.session).toEqual({ root, name: basename(root) })
  expect(git('branch', '--list', tree.branch)).toContain(tree.branch)
  // Otherwise in place: the same session.
  const here = await peer.call<ThreadInfo>('thread.create', { cwd: dir })
  expect(treeOf(here)).toBeUndefined()
  expect(here.session.root).toBe(root)
  // Archived with nothing uncommitted: the worktree goes, the branch stays; unarchived, it's back.
  expect(await archive(peer, thread.id)).toEqual({ worktree: 'removed' })
  expect(existsSync(tree.path)).toBe(false)
  expect(git('branch', '--list', tree.branch)).toContain(tree.branch)
  // Let go of by git at once; its files deleted after.
  expect(git('worktree', 'list')).not.toContain(tree.path)
  await until(async () => (await readdir(dirname(tree.path))).length === 0)
  await peer.call('thread.unarchive', { id: thread.id })
  expect(existsSync(join(tree.path, 'app/readme.md'))).toBe(true)
  // With changes in it, archiving leaves it be.
  await writeFile(join(tree.path, 'app/wip.md'), 'wip\n')
  expect(await archive(peer, thread.id)).toEqual({ worktree: 'kept' })
  expect(existsSync(join(tree.path, 'app/wip.md'))).toBe(true)
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

it('reads the worktree a thread kept before extensions had state, as its own, and moves it when it changes', async () => {
  const repo = join(dir, 'repo')
  mkdirSync(repo)
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { encoding: 'utf8' }).trim()
  git('init', '-q'); writeFileSync(join(repo, 'readme.md'), 'hi\n'); git('add', '.'); git('commit', '-q', '-m', 'start')
  const tree = { path: join(dir, 'data', 'worktrees', 'repo', 'old-abc123'), branch: 'superego/old-abc123' }
  mkdirSync(join(dir, 'data', 'worktrees', 'repo'), { recursive: true })
  git('worktree', 'add', '-q', '-b', tree.branch, tree.path, 'HEAD')
  // A database as an older daemon left it: the worktree in the thread's own metadata.
  const { Harness, createRegistry, defineDoc } = await import('@earendil-works/pi-durable')
  const { openNodeSqliteStorage } = await import('@earendil-works/pi-durable/storage/sqlite/node')
  const { createModels } = await import('@earendil-works/pi-ai/models')
  const { BACKGROUND_CONTEXT: context } = await import('@earendil-works/chord/context')
  const Catalog = defineDoc<{ ids: number[] }>({ kind: 'superego.catalog', version: 1, scope: 'session', initial: () => ({ ids: [] }), checkpointWhen: () => true })
  const ThreadDoc = defineDoc<Record<string, Json>>({
    kind: 'superego.session', version: 1, scope: 'conversation', history: 'latest', fork: 'current', initial: () => ({ title: '', cwd: '', createdAt: 0 }), checkpointWhen: () => true,
  })
  const root = await realpath(repo)
  const harness = await Harness.open(await openNodeSqliteStorage(join(dir, 'data', 'superego.sqlite')), { models: createModels(), registry: createRegistry() }, context)
  const old = await harness.createConversation({
    ownership: { kind: 'ownerless' }, agent: { cwd: tree.path },
    init: async (tx, created) => { Object.assign(await tx.doc(ThreadDoc, created), { title: 'Old', cwd: tree.path, root, createdAt: 1, worktree: tree }); (await tx.doc(Catalog)).ids.push(created) },
  }, context)
  await harness.close(context)

  const { peer, close } = await open(join(dir, 'data'))
  const id = String(old.id)
  expect(await find(peer, id)).toMatchObject({ ext: { worktrees: tree } })
  // Archived clean, it goes as ever, and is then kept as the extension's.
  expect(await archive(peer, id)).toEqual({ worktree: 'removed' })
  expect(existsSync(tree.path)).toBe(false)
  expect(await find(peer, id)).toMatchObject({ ext: { worktrees: { ...tree, removed: true } } })
  await peer.call('thread.unarchive', { id })
  expect(existsSync(join(tree.path, 'readme.md'))).toBe(true)
  expect(treeOf(await find(peer, id))).toEqual(tree)
  await close()
})
