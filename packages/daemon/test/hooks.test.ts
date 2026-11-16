// Extensions in a thread's life: lifecycle hooks, state kept with each thread and the facts clients see of it, choosing
// its agent, and the thread operations (create, submit, lastAnswer, archive, unarchive) they're given.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
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
  // Nothing to change, nothing to hear: unarchiving one in use, archiving one put away.
  heard.length = 0
  await peer.call('thread.unarchive', { id: thread.id })
  await peer.call('thread.archive', { id: thread.id })
  await peer.call('thread.archive', { id: thread.id })
  expect(heard).toEqual(['nest archiving false', 'after archiving false', 'nest archived true', 'after archived true'])
  await peer.call('thread.unarchive', { id: thread.id })
  // Switched off, an extension's hooks and facts aren't for the thread.
  await peer.call('settings.set', { key: 'extensions.nest', value: false })
  expect((await find(peer, thread.id))!.ext).toBeUndefined()
  heard.length = 0
  const plain = await peer.call<ThreadInfo>('thread.create', { options: { nest: true } })
  expect(plain.cwd).toBe(dir)
  expect(heard).toEqual([`after creating ${dir}`, `after created ${dir}`])
  await close()
})

it('tells blocked once each time a thread comes to need the user, as the status says', async () => {
  const heard: string[] = []
  let asking: string | undefined
  let api!: DaemonApi
  const asker = defineDaemonExtension({
    name: 'asker',
    setup(superego) {
      api = superego
      superego.status((id) => id === asking ? { kind: 'question', msg: 'Which?' } : undefined)
      superego.thread({ blocked: (t) => { heard.push(`${t.id} ${t.status.state} ${t.status.msg}`) } })
    },
  })
  const { peer, close } = await open([asker])
  const thread = await peer.call<ThreadInfo>('thread.create', {})
  asking = thread.id
  api.invalidate()
  api.invalidate()
  await until(() => heard.length === 1)
  asking = undefined
  api.invalidate()
  asking = thread.id
  api.invalidate()
  await until(() => heard.length === 2)
  expect(heard).toEqual([`${thread.id} blocked Which?`, `${thread.id} blocked Which?`])
  await close()
})

it("tells those whose unarchiving ran, in reverse, when a later one refuses: what they put back is undone", async () => {
  const heard: string[] = []
  const part = (name: string, refuse = false) => defineDaemonExtension({
    name,
    setup(superego) {
      superego.thread({
        unarchiving() { if (refuse) throw new Error('nope'); heard.push(`${name} put back`) },
        unarchiveAbandoned() { heard.push(`${name} undone`) },
      })
    },
  })
  const { peer, close } = await open([part('first'), part('second'), part('third', true)])
  const thread = await peer.call<ThreadInfo>('thread.create', {})
  await peer.call('thread.archive', { id: thread.id })
  await expect(peer.call('thread.unarchive', { id: thread.id })).rejects.toMatchObject({ kind: 'refused', message: 'third: nope' })
  // The refusing hook did nothing to undo; the others undo in reverse, and it stays archived.
  expect(heard).toEqual(['first put back', 'second put back', 'second undone', 'first undone'])
  expect((await find(peer, thread.id))!.archived).toBe(true)
  await close()
})

it('refuses when an -ing hook says no; a hook that throws otherwise is logged, and wedges nothing', async () => {
  let refuse = true
  const guard = defineDaemonExtension({
    name: 'guard',
    setup(superego) {
      superego.thread({
        creating(draft) {
          if (draft.options.guard === 'no') throw new RpcError('busy', 'Not now')
          if (draft.options.guard === 'plain') throw new Error('No way')
        },
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
  // A plain error says whose it is, as for the other -ing hooks.
  await expect(peer.call('thread.create', { options: { guard: 'plain' } })).rejects.toMatchObject({ kind: 'refused', message: 'guard: No way' })
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

it("says what a run did in its done status, as clients first hear it's done: an extension's recap, else the answer's first sentence", async () => {
  const recaps = defineDaemonExtension({
    name: 'recaps',
    setup(superego) {
      superego.recap(({ answer, calls }) => answer?.includes('recap me') ? `**Recapped**, [with](https://x.test) ${calls.length} calls` : undefined)
      // Asked only when the first says nothing; a throw counts as nothing too.
      superego.recap(() => { throw new Error('no recap') })
    },
  })
  const first = await open([recaps])
  const done: Record<string, ThreadInfo['status'][]> = {}
  await first.peer.call('threads.watch', {})
  first.peer.on('threads.changed', ({ value }: { value: ThreadInfo[] }) => {
    for (const t of value) if (t.status.state === 'done') (done[t.id] ??= []).push(t.status)
  })
  const plain = await first.peer.call<ThreadInfo>('thread.create', { prompt: 'Fix **the** build. Then the rest of it, which goes on and on.' })
  const recapped = await first.peer.call<ThreadInfo>('thread.create', { prompt: 'recap me' })
  await until(() => Boolean(done[plain.id] && done[recapped.id]))
  expect(done[plain.id]![0]).toEqual({ state: 'done', msg: 'echo: Fix the build.' })
  expect(done[recapped.id]![0]).toEqual({ state: 'done', msg: 'Recapped, with 0 calls' })
  await first.close()

  // Answered before a restart, and not seen yet: it says so after.
  const { peer, close } = await open([recaps])
  expect((await find(peer, plain.id))!.status).toEqual({ state: 'done', msg: 'echo: Fix the build.' })
  await peer.call('thread.seen', { id: plain.id })
  expect((await find(peer, plain.id))!.status).toEqual({ state: 'idle' })
  await close()
})

it("tells an extension of each tool call a thread's agent makes, once it ends, without waiting on it or letting it fail the run", async () => {
  const heard: Json[] = []
  const watcher = defineDaemonExtension({
    name: 'watcher',
    setup(superego) {
      superego.agent(defineExtension({ name: 'watcher', tools: [
        defineTool({ name: 'query', description: 'Query.', parameters: obj({ sql: str() }), async execute({ sql }) { return { output: [{ type: 'text', text: `rows for ${sql}` }] } } }),
        defineTool({ name: 'broken', description: 'Fails.', parameters: obj({}), async execute() { throw new Error('no database') } }),
      ] }))
      // A watcher that throws is logged; the run goes on, and the others still hear.
      superego.toolCalls(() => { throw new Error('watcher failed') })
      superego.toolCalls(async (record) => { heard.push(record as unknown as Json) })
    },
  })
  const turns = join(dir, 'turns.jsonl')
  const turn = (content: unknown[], stopReason: string) => JSON.stringify({ at: 0, provider: 'test', model: 'test', message: { role: 'assistant', content, stopReason } })
  writeFileSync(turns, [
    turn([{ type: 'toolCall', id: 'c1', name: 'query', arguments: { sql: 'select 1' } }], 'toolUse'),
    turn([{ type: 'toolCall', id: 'c2', name: 'broken', arguments: {} }], 'toolUse'),
    turn([{ type: 'text', text: 'Done.' }], 'stop'),
  ].join('\n') + '\n')
  process.env.SUPEREGO_MODEL = `replay:${turns}`
  process.env.SUPEREGO_REPLAY_SPEED = '0'
  const daemon = await openDaemon({ app: SUPEREGO, dataDir: dir, defaultCwd: dir, agentsDir: join(dir, 'agents'), extensions: [watcher] })
  try {
    const server = await listen(daemon, join(dir, 'superego.sock'))
    const { peer, socket } = await connectSocket(join(dir, 'superego.sock'))
    await peer.call('hello', { client: 'test', version: PROTOCOL_VERSION })
    const thread = await peer.call<ThreadInfo>('thread.create', { prompt: 'Look at the database' })
    await done(peer, thread.id)
    await until(() => heard.length === 2)
    expect(heard).toEqual([
      { thread: thread.id, call: { id: 'c1', name: 'query', args: { sql: 'select 1' } }, result: { isError: false, text: 'rows for select 1' } },
      { thread: thread.id, call: { id: 'c2', name: 'broken', args: {} }, result: expect.objectContaining({ isError: true, text: expect.stringContaining('no database') }) },
    ])
    socket.destroy(); server.close()
  } finally {
    delete process.env.SUPEREGO_REPLAY_SPEED
    await daemon.close()
  }
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
  let answer = true
  // It can't pick another extension's part.
  const fallback = defineDaemonExtension({ name: 'fallback', setup(superego) { superego.agentFor(() => answer ? { instructions: 'Anything.', extensions: [tools] } : undefined) } })
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
  // No longer answering, its instructions go with it.
  answer = false
  await peer.call('thread.submit', { id: other.id, text: 'again' })
  await until(async () => !(await agentOf(peer, other.id)).instructions)
  await done(peer, other.id)
  expect((await agentOf(peer, other.id)).instructions).toBeFalsy()
  await close()
})

it("runs an extension's own thread only as that extension's: refused while the thread goes without it", async () => {
  let api!: DaemonApi
  let target: string | undefined
  // Chosen first, and leaving out the owner for its thread.
  const picky = defineDaemonExtension({ name: 'picky', setup(superego) { superego.agentFor(({ id }) => id && id === target ? { without: ['own'] } : undefined) } })
  const own = defineDaemonExtension({ name: 'own', setup(superego) { api = superego } })
  const { peer, close } = await open([picky, own])
  const thread = await api.threads.create({ hidden: true })
  expect(thread.owner).toBe('own')
  await api.threads.submit(thread.id, 'hello')
  await until(async () => (await api.threads.get(thread.id)).status.state === 'done')
  target = thread.id
  await expect(peer.call('thread.submit', { id: thread.id, text: 'again' })).rejects.toMatchObject({ kind: 'invalid' })
  await close()
})

it('gives extensions the thread operations: create (hidden, as a child), submit, its last answer and entries, archive (now or when idle), unarchive', async () => {
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
  // Its newest entries first: the answer, then the message.
  const entries = await api.threads.entries(top.id, 50)
  expect(entries[0]!.kind).toBe('pi.assistant')
  expect(entries.find((e) => e.kind === 'pi.user')?.model?.[0]).toMatchObject({ content: 'hello' })
  expect(await api.threads.entries(top.id, 1)).toHaveLength(1)
  // Cleared: nothing from before, the answer neither.
  await api.threads.clear(top.id)
  expect(await api.threads.entries(top.id, 50)).toEqual([])
  expect(await api.threads.lastAnswer(top.id)).toBeUndefined()
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

it("runs a profile's hooks and shows its facts after a restart, before any of its threads runs", async () => {
  const home = join(dir, 'home')
  const profile = join(home, 'profiles', 'default')
  const log = join(dir, 'heard.log')
  mkdirSync(profile, { recursive: true })
  writeFileSync(join(profile, 'profile.ts'), `import { defineProfile } from 'superego'\nexport default defineProfile({ extensions: ['./keeper.ts'] })\n`)
  writeFileSync(join(profile, 'keeper.ts'), `import { appendFileSync } from 'node:fs'
import { defineDaemonExtension } from 'superego'
const hear = (what) => (t) => { appendFileSync(${JSON.stringify(log)}, what + ' ' + t.title + '\\n') }
export default defineDaemonExtension({
  name: 'keeper',
  setup(superego) {
    superego.facts(() => ({ kept: true }))
    superego.thread({ archiving: hear('archiving'), archived: hear('archived'), unarchiving: hear('unarchiving'), unarchived: hear('unarchived') })
  },
})
`)
  const heard = () => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : []
  const first = await open([], home)
  const away = await first.peer.call<ThreadInfo>('thread.create', { cwd: dir, title: 'Away' })
  expect(away.ext).toEqual({ keeper: { kept: true } })
  await first.peer.call('thread.archive', { id: away.id })
  expect(heard()).toEqual(['archiving Away', 'archived Away'])
  await first.close()

  // Only an archived thread has the profile: nothing loads it at startup, so bringing it back does.
  const second = await open([], home)
  await second.peer.call('thread.unarchive', { id: away.id })
  expect(heard().slice(2)).toEqual(['unarchiving Away', 'unarchived Away'])
  expect((await find(second.peer, away.id))!.ext).toEqual({ keeper: { kept: true } })
  await second.close()

  // A thread in use's profile loads at startup: its facts show, and its hooks run, without a turn.
  const { peer, close } = await open([], home)
  await until(async () => (await find(peer, away.id))!.ext?.keeper !== undefined)
  await peer.call('thread.archive', { id: away.id })
  expect(heard().slice(4)).toEqual(['archiving Away', 'archived Away'])
  await close()
})

it('says what archiving did, a line from each extension whose hooks said one', async () => {
  const noting = (name: string, archiving: string | undefined, archived: string | undefined) => defineDaemonExtension({
    name, setup: (s) => s.thread({ archiving: () => (archiving ? { note: archiving } : undefined), archived: () => (archived ? { note: archived } : undefined) }),
  })
  let api!: DaemonApi
  const grab = defineDaemonExtension({ name: 'grab', setup(s) { api = s } })
  const { peer, close } = await open([noting('tickets', 'Closed #12.', 'Unassigned.'), noting('quiet', undefined, undefined), grab])
  const thread = await peer.call<ThreadInfo>('thread.create', {})
  expect(await peer.call('thread.archive', { id: thread.id })).toEqual({ notes: { tickets: 'Closed #12. Unassigned.' } })
  await peer.call('thread.unarchive', { id: thread.id })
  // To an extension too; nothing to say of one already away.
  expect(await api.threads.archive(thread.id)).toEqual({ notes: { tickets: 'Closed #12. Unassigned.' } })
  expect(await api.threads.archive(thread.id)).toEqual({ notes: {} })
  await close()
})
