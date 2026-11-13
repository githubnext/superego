// Extensions in a thread's life: lifecycle hooks, state kept with each thread and the facts clients see of it, choosing
// its agent, and the thread operations (create, submit, lastAnswer, archive, unarchive) they're given.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { defineExtension, defineTool } from '@earendil-works/pi-durable'
import { defineApp, obj, PROTOCOL_VERSION, RpcError, str, type Json, type RpcPeer, type ThreadInfo } from '@superego/protocol'
import { connectSocket, defineDaemonExtension, listen, openDaemon, type DaemonApi, type DaemonExtension } from '../src/index.ts'

for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_OAUTH_TOKEN', 'OPENAI_API_KEY']) delete process.env[key]
const SUPEREGO = defineApp({ name: 'superego', id: 'superego' })
let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'superego-hooks-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

async function open(extensions: DaemonExtension[] = [], dataDir = dir) {
  process.env.SUPEREGO_MODEL = 'faux'
  const daemon = await openDaemon({ app: SUPEREGO, dataDir, defaultCwd: dir, agentsDir: join(dir, 'agents'), extensions })
  const server = await listen(daemon, join(dataDir, 'superego.sock'))
  const { peer, socket } = await connectSocket(join(dataDir, 'superego.sock'))
  await peer.call('hello', { client: 'test', version: PROTOCOL_VERSION })
  return { peer, close: async () => { socket.destroy(); server.close(); await daemon.close() } }
}
const until = async (check: () => boolean | Promise<boolean>) => {
  for (let i = 0; i < 200; i++) { if (await check()) return; await new Promise((r) => setTimeout(r, 25)) }
  throw new Error('timed out')
}
const listed = async (peer: RpcPeer, archived = false) => peer.call<ThreadInfo[]>('thread.list', { archived })
const find = async (peer: RpcPeer, id: string) => [...await listed(peer), ...await listed(peer, true)].find((t) => t.id === id)
const done = (peer: RpcPeer, id: string) => until(async () => (await find(peer, id))?.status.state === 'done')
/** The extensions and instructions a thread's agent has, once a turn configured it. */
async function agentOf(peer: RpcPeer, id: string) {
  const { value } = await peer.call<{ value: { docs: Record<string, unknown> } }>('thread.watch', { id })
  const agent = value.docs['pi.agent'] as { extensions?: string[]; instructions?: string } | undefined
  return { extensions: agent?.extensions ?? [], instructions: agent?.instructions }
}

it("takes part in a thread's life, in order: creating moves it and gives it state; then created, turns, archiving and back", async () => {
  const heard: string[] = []
  const hear = (name: string) => ({
    created: (t: ThreadInfo) => { heard.push(`${name} created ${t.cwd}`) },
    turnStart: () => { heard.push(`${name} turnStart`) },
    turnEnd: () => { heard.push(`${name} turnEnd`) },
    archiving: (t: ThreadInfo) => { heard.push(`${name} archiving ${Boolean(t.archived)}`) },
    archived: (t: ThreadInfo) => { heard.push(`${name} archived ${Boolean(t.archived)}`) },
    unarchiving: () => { heard.push(`${name} unarchiving`) },
    unarchived: (t: ThreadInfo) => { heard.push(`${name} unarchived ${Boolean(t.archived)}`) },
  })
  const nest = defineDaemonExtension({
    name: 'nest',
    setup(superego) {
      superego.facts(({ state }) => state)
      superego.thread({
        ...hear('nest'),
        async creating(draft) {
          heard.push(`nest creating ${JSON.stringify(draft.options)}`)
          if (draft.options.nest !== true) return
          const cwd = join(draft.cwd, 'nested')
          await mkdir(cwd, { recursive: true })
          return { cwd, state: { made: cwd } }
        },
      })
    },
  })
  const after = defineDaemonExtension({
    name: 'after',
    setup(superego) {
      superego.thread({ ...hear('after'), creating(draft) { heard.push(`after creating ${draft.cwd}`) } })
    },
  })
  const { peer, close } = await open([nest, after])
  const thread = await peer.call<ThreadInfo>('thread.create', { prompt: 'hi', options: { nest: true } })
  const nested = join(dir, 'nested')
  expect(thread).toMatchObject({ cwd: nested, session: { root: dir }, ext: { nest: { made: nested } } })
  await done(peer, thread.id)
  await until(() => heard.includes('after turnEnd'))
  expect(heard).toEqual([
    'nest creating {"nest":true}', `after creating ${nested}`,
    `nest created ${nested}`, `after created ${nested}`,
    'nest turnStart', 'after turnStart', 'nest turnEnd', 'after turnEnd',
  ])
  heard.length = 0
  await peer.call('thread.archive', { id: thread.id })
  await peer.call('thread.unarchive', { id: thread.id })
  expect(heard).toEqual([
    'nest archiving false', 'after archiving false', 'nest archived true', 'after archived true',
    'nest unarchiving', 'after unarchiving', 'nest unarchived false', 'after unarchived false',
  ])
  // Switched off, an extension's hooks aren't for the thread.
  await peer.call('settings.set', { key: 'extensions.nest', value: false })
  heard.length = 0
  const plain = await peer.call<ThreadInfo>('thread.create', { options: { nest: true } })
  expect(plain.cwd).toBe(dir)
  expect(heard).toEqual([`after creating ${dir}`, `after created ${dir}`])
  await close()
})

it('refuses when an -ing hook says no; a hook that throws otherwise is logged, and wedges nothing', async () => {
  let refuse = true
  const guard = defineDaemonExtension({
    name: 'guard',
    setup(superego) {
      superego.thread({
        creating(draft) { if (draft.options.guard === 'no') throw new RpcError('busy', 'Not now') },
        archiving() { if (refuse) throw new RpcError('busy', 'Still needed') },
        unarchiving() { if (refuse) throw new Error('nope') },
        created() { throw new Error('broken') },
        turnStart() { throw new Error('broken') },
        turnEnd: async () => { throw new Error('broken') },
        archived() { throw new Error('broken') },
      })
    },
  })
  const { peer, close } = await open([guard])
  await expect(peer.call('thread.create', { options: { guard: 'no' } })).rejects.toMatchObject({ kind: 'busy', message: 'Not now' })
  expect(await listed(peer)).toEqual([])
  const thread = await peer.call<ThreadInfo>('thread.create', { prompt: 'hi' })
  await done(peer, thread.id)
  await expect(peer.call('thread.archive', { id: thread.id })).rejects.toMatchObject({ kind: 'busy', message: 'Still needed' })
  expect((await find(peer, thread.id))!.archived).toBeUndefined()
  refuse = false
  await peer.call('thread.archive', { id: thread.id })
  expect((await find(peer, thread.id))!.archived).toBe(true)
  refuse = true
  await expect(peer.call('thread.unarchive', { id: thread.id })).rejects.toMatchObject({ kind: 'refused', message: 'guard: nope' })
  expect((await find(peer, thread.id))!.archived).toBe(true)
  refuse = false
  await peer.call('thread.unarchive', { id: thread.id })
  // Its turns go on as ever.
  await peer.call('thread.submit', { id: thread.id, text: 'again' })
  await done(peer, thread.id)
  await close()
})

it('keeps state with each thread, as facts clients see, across a restart', async () => {
  const notes = defineDaemonExtension({
    name: 'notes',
    setup(superego) {
      const state = superego.state<{ count: number }>()
      superego.facts<{ count: number }>(({ state }) => state && { notes: state.count })
      superego.method('notes.add', async ({ id }) => { await state.update(id, (now) => ({ count: (now?.count ?? 0) + 1 })); return null }, { params: obj({ id: str() }) })
      superego.method('notes.get', async ({ id }) => (await state.get(id)) ?? null, { params: obj({ id: str() }) })
      superego.method('notes.clear', async ({ id }) => { await state.set(id, undefined); return null }, { params: obj({ id: str() }) })
    },
  })
  const first = await open([notes])
  const thread = await first.peer.call<ThreadInfo>('thread.create', {})
  expect(thread.ext).toBeUndefined()
  await first.peer.call('notes.add', { id: thread.id })
  await first.peer.call('notes.add', { id: thread.id })
  expect((await find(first.peer, thread.id))!.ext).toEqual({ notes: { notes: 2 } })
  await first.close()

  const { peer, close } = await open([notes])
  expect((await find(peer, thread.id))!.ext).toEqual({ notes: { notes: 2 } })
  expect(await peer.call('notes.get', { id: thread.id })).toEqual({ count: 2 })
  await peer.call('notes.clear', { id: thread.id })
  expect((await find(peer, thread.id))!.ext).toBeUndefined()
  await close()
  // Without the extension, its state stays with the thread, unsaid.
  const bare = await open([])
  expect((await find(bare.peer, thread.id))!.ext).toBeUndefined()
  await bare.close()
})

it('reads the worktree a thread kept before extensions had state, as the worktrees extension\'s, and moves it when it changes', async () => {
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

  const { peer, close } = await open([], join(dir, 'data'))
  const id = String(old.id)
  expect(await find(peer, id)).toMatchObject({ worktree: tree, ext: { worktrees: tree } })
  // Archived clean, it goes as ever, and is then kept as the extension's.
  expect(await peer.call('thread.archive', { id })).toEqual({ worktree: 'removed' })
  expect(existsSync(tree.path)).toBe(false)
  expect(await find(peer, id)).toMatchObject({ worktree: { ...tree, removed: true }, ext: { worktrees: { ...tree, removed: true } } })
  await peer.call('thread.unarchive', { id })
  expect(existsSync(join(tree.path, 'readme.md'))).toBe(true)
  expect((await find(peer, id))!.worktree).toEqual(tree)
  await close()
})

it("lets an extension choose a thread's agent: instructions, tools and what it goes without; the first to answer wins", async () => {
  const tools = defineExtension({ name: 'picked', tools: [defineTool({ name: 'picked_tool', description: 'Picked.', parameters: obj({}), async execute() { return { output: [] } } })] })
  const picker = defineDaemonExtension({
    name: 'picker',
    setup(superego) {
      superego.agent(tools, { always: false })
      superego.thread({ creating: (draft) => draft.options.picker === true ? { state: 'mine' } : undefined })
      superego.agentFor(({ state }) => state === 'mine' ? { instructions: 'Picked.', extensions: [tools], without: ['coding-tools'] } : undefined)
    },
  })
  const fallback = defineDaemonExtension({ name: 'fallback', setup(superego) { superego.agentFor(() => ({ instructions: 'Anything.' })) } })
  const { peer, close } = await open([picker, fallback])
  const mine = await peer.call<ThreadInfo>('thread.create', { prompt: 'hi', options: { picker: true } })
  const other = await peer.call<ThreadInfo>('thread.create', { prompt: 'hi' })
  expect(mine.without).toEqual(['coding-tools'])
  expect(other.without).toBeUndefined()
  await done(peer, mine.id)
  await done(peer, other.id)
  const chosen = await agentOf(peer, mine.id)
  expect(chosen.instructions).toBe('Picked.')
  expect(chosen.extensions).toContain('picked')
  expect(chosen.extensions).not.toContain('coding-tools')
  const plain = await agentOf(peer, other.id)
  expect(plain.instructions).toBe('Anything.')
  expect(plain.extensions).not.toContain('picked')
  await close()
})

it('gives extensions the thread operations: create (hidden, as a child), submit, its last answer, archive (now or when idle), unarchive', async () => {
  let api!: DaemonApi
  const { peer, close } = await open([defineDaemonExtension({ name: 'ops', setup(superego) { api = superego } })])
  const own = await api.threads.create({ title: 'Own', hidden: true })
  expect(own.hidden).toBe(true)
  expect(await listed(peer)).toEqual([])
  expect((await api.threads.list({ hidden: true })).map((t) => t.id)).toEqual([own.id])
  // A hidden thread's children are top-level; another's are its children.
  const top = await api.threads.create({ title: 'Top', parent: own.id })
  expect(top.parent).toBeUndefined()
  const child = await api.threads.create({ title: 'Child', parent: top.id })
  expect(child.parent).toBe(top.id)
  expect((await listed(peer)).map((t) => t.id)).toEqual([child.id, top.id])
  await api.threads.submit(top.id, 'hello')
  await done(peer, top.id)
  expect(await api.threads.lastAnswer(top.id)).toEqual(expect.any(String))
  expect(await api.threads.lastAnswer(child.id)).toBeUndefined()
  await api.threads.archive(child.id, { whenIdle: true })
  await until(async () => (await api.threads.get(child.id)).archived === true)
  await api.threads.unarchive(child.id)
  expect((await api.threads.get(child.id)).archived).toBeUndefined()
  await api.threads.archive(top.id)
  expect((await listed(peer, true)).map((t) => t.id)).toEqual([top.id])
  await close()
})

it("undoes a profile's hooks, facts and choice of agent when it changes", async () => {
  const home = join(dir, 'home')
  const profile = join(home, 'profiles', 'default')
  const write = (files: Record<string, string>) => { for (const [path, content] of Object.entries(files)) { mkdirSync(join(profile, path, '..'), { recursive: true }); writeFileSync(join(profile, path), content) } }
  const extension = (version: number) => `import { defineDaemonExtension } from 'superego'
export default defineDaemonExtension({
  name: 'tagged',
  setup(superego) {
    superego.facts(() => ({ version: ${version} }))
    superego.agentFor(() => ({ instructions: 'Version ${version}.' }))
    superego.thread({ created: (t) => superego.state().set(t.id, ${version}) })
  },
})
`
  write({ 'profile.ts': `import { defineProfile } from 'superego'\nexport default defineProfile({ extensions: ['./tagged.ts'] })\n`, 'tagged.ts': extension(1) })
  const { peer, close } = await open([], home)
  const thread = await peer.call<ThreadInfo>('thread.create', { cwd: dir, prompt: 'hi' })
  expect(thread.ext).toEqual({ tagged: { version: 1 } })
  await done(peer, thread.id)
  expect((await agentOf(peer, thread.id)).instructions).toBe('Version 1.')
  // Another thread, of no profile, has none of it.
  const elsewhere = join(dir, 'elsewhere')
  mkdirSync(join(elsewhere, '.superego', 'profiles', 'default'), { recursive: true })
  writeFileSync(join(elsewhere, '.superego', 'profiles', 'default', 'profile.ts'), `import { defineProfile } from 'superego'\nexport default defineProfile({})\n`)
  await peer.call('profile.allow', { cwd: elsewhere })
  const plain = await peer.call<ThreadInfo>('thread.create', { cwd: elsewhere })
  expect(plain.ext).toBeUndefined()
  // Changed, it's set up again: the old version's facts and choice are gone, not doubled.
  write({ 'tagged.ts': extension(2) })
  await peer.call('thread.submit', { id: thread.id, text: 'again' })
  await until(async () => (await find(peer, thread.id))!.ext?.tagged !== undefined && JSON.stringify((await find(peer, thread.id))!.ext) === '{"tagged":{"version":2}}')
  await done(peer, thread.id)
  expect((await agentOf(peer, thread.id)).instructions).toBe('Version 2.')
  await close()
})
