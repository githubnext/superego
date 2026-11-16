// The daemon half of the extension API, as an extension sees it: methods (reads) apart from actions, threads by id,
// pane kinds told to the agent, and send transforms.
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { defineExtension, defineTool } from '@earendil-works/pi-durable'
import { AUTH_REJECTED, DATA_VIEWS, defineAction, defineApp, MESSAGE_ENTRY, obj, PROTOCOL_VERSION, str, type ActionInfo, type MessageOrigin, type SettingsSnapshot, type DataViewInfo, type Hello, type Notifications, type ThreadInfo, type ViewContent } from '@superego/protocol'
import { connectSocket, defineDaemonExtension, listen, openDaemon, type DaemonApi, type DaemonExtension, type LiveValue, type ScopedValue, type ThreadState } from '../src/index.ts'
import { answeredBy } from '../src/threads.ts'
import { until } from './until.ts'

for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_OAUTH_TOKEN', 'OPENAI_API_KEY']) delete process.env[key]
const SUPEREGO = defineApp({ name: 'superego', id: 'superego' })
let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'superego-extension-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }); delete process.env.SUPEREGO_REPLAY_SPEED })

async function open(extensions: DaemonExtension[], model = 'faux') {
  process.env.SUPEREGO_MODEL = model
  process.env.SUPEREGO_REPLAY_SPEED = '0'
  const daemon = await openDaemon({ app: SUPEREGO, dataDir: dir, defaultCwd: dir, agentsDir: join(dir, 'agents'), extensions })
  const server = await listen(daemon, join(dir, 'superego.sock'))
  const { peer, socket } = await connectSocket(join(dir, 'superego.sock'))
  const hello = await peer.call<Hello>('hello', { client: 'test', version: PROTOCOL_VERSION })
  return { peer, hello, close: async () => { socket.destroy(); server.close(); await daemon.close() } }
}

it('serves an extension method as a plain read: called by name, checked, not an action', async () => {
  const notes = defineDaemonExtension({
    name: 'notes',
    setup(superego) {
      superego.method('notes.folder', async ({ id }) => ({ cwd: (await superego.threads.get(id)).cwd }), { params: obj({ id: str() }) })
    },
  })
  const { peer, hello, close } = await open([notes])
  expect(hello.methods).toContain('notes.folder')
  const thread = await peer.call<ThreadInfo>('thread.start', {})
  expect(await peer.call('notes.folder', { id: thread.id })).toEqual({ cwd: dir })
  await expect(peer.call('notes.folder', {})).rejects.toMatchObject({ kind: 'invalid_params' })
  await expect(peer.call('notes.folder', { id: '999' })).rejects.toMatchObject({ kind: 'not_found' })
  // A read: not offered as an action, not in the log.
  expect((await peer.call<ActionInfo[]>('action.list', {})).map((a) => a.id)).not.toContain('notes.folder')
  expect(JSON.stringify(await peer.call('action.log', {}))).not.toContain('notes.folder')
  await close()
})

it('tells an extension when a setting changes (settings.onChange)', async () => {
  let heard = 0
  const listener = defineDaemonExtension({ name: 'listener', setup(superego) { superego.settings.onChange(() => { heard++ }) } })
  const { peer, close } = await open([listener])
  await peer.call('settings.set', { key: 'agent.model', value: 'faux/faux-1' })
  await until(async () => heard > 0)
  await close()
})

it('blocks a thread only by the status of an extension it has: not one switched off', async () => {
  const asker = defineDaemonExtension({ name: 'asker', setup(superego) { superego.status(() => ({ kind: 'question', msg: 'Which?' })) } })
  const { peer, close } = await open([asker])
  const thread = await peer.call<ThreadInfo>('thread.start', {})
  const status = async () => (await peer.call<ThreadInfo[]>('thread.list', {})).find((t) => t.id === thread.id)!.status
  expect(await status()).toMatchObject({ state: 'blocked', msg: 'Which?' })
  await peer.call('settings.set', { key: 'extensions.asker', value: false })
  expect(await status()).toEqual({ state: 'idle' })
  await close()
})

it("tells the agent the pane kinds extensions describe, beside the core's: a daemon half's, and a window's", async () => {
  const notes = defineDaemonExtension({ name: 'notes', panes: { graph: 'the notes as a graph; no params' } })
  const { peer, close } = await open([notes])
  // One whose work is all in the window describes its panes as the window declares it.
  await peer.call('extension.declare', { extensions: [{ name: 'web-panes', panes: { preview: '{ url }: a web page', bad: 3 } }] })
  const thread = await peer.call<ThreadInfo>('thread.start', { prompt: 'hi' })
  await until(async () => (await peer.call<ThreadInfo[]>('thread.list', {}))[0]!.status.state === 'done')
  const { value } = await peer.call<{ value: { entries: { model?: { role?: string; content?: unknown }[] }[]; docs: Record<string, unknown> } }>('thread.watch', { thread: thread.id })
  const prompt = JSON.stringify(value)
  expect(prompt).toContain('\\"graph\\": the notes as a graph; no params')
  expect(prompt).toContain('\\"preview\\": { url }: a web page')
  expect(prompt).not.toContain('\\"bad\\"')
  expect(prompt).toContain('\\"editor\\": { path }: a file')
  // Changes is git's to describe: without it, no "diff".
  expect(prompt).not.toContain('\\"diff\\"')
  await close()
})

it('refuses an extension describing a pane kind another already does', async () => {
  const one = defineDaemonExtension({ name: 'one', panes: { board: 'a board' } })
  const two = defineDaemonExtension({ name: 'two', panes: { board: 'another board' } })
  await expect(open([one, two])).rejects.toThrow('Pane kind board is already described')
})

it("leaves out of a window's declaration the pane kinds another extension describes", async () => {
  const notes = defineDaemonExtension({ name: 'notes', panes: { graph: 'the notes as a graph' } })
  const { peer, close } = await open([notes])
  await peer.call('extension.declare', { extensions: [{ name: 'grabby', panes: { editor: 'mine', graph: 'mine too', board: 'a board' } }] })
  const thread = await peer.call<ThreadInfo>('thread.start', { prompt: 'hi' })
  await until(async () => (await peer.call<ThreadInfo[]>('thread.list', {}))[0]!.status.state === 'done')
  const prompt = JSON.stringify((await peer.call<{ value: unknown }>('thread.watch', { thread: thread.id })).value)
  expect(prompt).toContain('\\"editor\\": { path }: a file')
  expect(prompt).toContain('\\"graph\\": the notes as a graph')
  expect(prompt).toContain('\\"board\\": a board')
  expect(prompt).not.toContain('mine')
  await close()
})

it('lists optional extensions in Settings, and tells clients what each thread goes without', async () => {
  const sidebar = defineDaemonExtension({ name: 'sidebar', title: 'Sidebar', required: true })
  const links = defineDaemonExtension({ name: 'links', title: 'Links' })
  const { peer, close } = await open([sidebar, links])
  const { value } = await peer.call<{ value: { sections: { id: string; settings: { key: string }[] }[] } }>('settings.watch', {})
  const keys = value.sections.find((s) => s.id === 'extensions')!.settings.map((s) => s.key)
  // The core's own parts and the optional bundled one; never a required one.
  expect(keys).toEqual(['extensions.coding-tools', 'extensions.panes', 'extensions.agents-md', 'extensions.links'])
  const thread = await peer.call<ThreadInfo>('thread.start', {})
  expect(thread.without).toBeUndefined()
  await peer.call('settings.set', { key: 'extensions.links', value: false })
  await until(async () => (await peer.call<ThreadInfo[]>('thread.list', {}))[0]!.without?.join() === 'links')
  await close()
})

it('transforms what a message gives the agent, in order, but not for a thread that goes without the extension', async () => {
  const seen: unknown[] = []
  const stamp = defineDaemonExtension({
    name: 'stamp',
    setup(superego) {
      superego.beforeSend(async ({ thread, text, content }) => {
        seen.push({ thread: thread.id, text, content })
        if (text.includes('stamp')) return [...content, { type: 'text', text: 'stamped' }]
      })
    },
  })
  const count = defineDaemonExtension({
    name: 'count',
    setup(superego) { superego.beforeSend(({ content }) => [...content, { type: 'text', text: `${content.length} before me` }]) },
  })
  const { peer, close } = await open([stamp, count])
  const thread = await peer.call<ThreadInfo>('thread.start', {})
  const users = async () => {
    const { value } = await peer.call<{ value: { entries: { kind: string; model?: { content: unknown }[] }[] } }>('thread.watch', { thread: thread.id })
    return value.entries.filter((e) => e.kind === MESSAGE_ENTRY).map((e) => e.model![0]!.content)
  }
  const send = async (text: string) => {
    const before = (await users()).length
    await peer.call('thread.send', { thread: thread.id, text })
    await until(async () => (await users()).length > before && (await peer.call<ThreadInfo[]>('thread.list', {}))[0]!.status.state === 'done')
    return (await users()).at(-1)
  }
  // Each transform gets what the one before returned.
  expect(await send('stamp this')).toEqual([{ type: 'text', text: 'stamp this' }, { type: 'text', text: 'stamped' }, { type: 'text', text: '2 before me' }])
  expect(seen[0]).toEqual({ thread: thread.id, text: 'stamp this', content: [{ type: 'text', text: 'stamp this' }] })
  // Turned off on this machine, its transform is skipped; untouched, a message goes as it came.
  await peer.call('settings.set', { key: 'extensions.count', value: false })
  expect(await send('plain')).toBe('plain')
  await close()
})

it("counts only what a transform returns, not what it changes in place, with attachments or without", async () => {
  const meddle = defineDaemonExtension({
    name: 'meddle',
    setup(superego) { superego.beforeSend(({ content }) => { content.push({ type: 'text', text: 'meddled' }) }) },
  })
  const { peer, close } = await open([meddle])
  const thread = await peer.call<ThreadInfo>('thread.start', {})
  await peer.call('thread.send', { thread: thread.id, text: 'look', attachments: [{ name: 'a.txt', mimeType: 'text/plain', data: Buffer.from('a').toString('base64') }] })
  await until(async () => (await peer.call<ThreadInfo[]>('thread.list', {}))[0]!.status.state === 'done')
  const { value } = await peer.call<{ value: { entries: { kind: string; model?: { content: unknown }[] }[] } }>('thread.watch', { thread: thread.id })
  expect(JSON.stringify(value.entries.find((e) => e.kind === MESSAGE_ENTRY)!.model![0]!.content)).not.toContain('meddled')
  await close()
})

it('tells clients when what it offers changes: an extension switched off, or set up', async () => {
  const links = defineDaemonExtension({ name: 'links', title: 'Links' })
  const { peer, hello, close } = await open([links])
  expect(hello.extensions.map((e) => e.name)).toContain('links')
  const told: string[][] = []
  peer.on('features.changed', (params: Notifications['features.changed']) => { told.push(params.extensions.map((e) => e.name)) })
  await peer.call('settings.set', { key: 'extensions.links', value: false })
  await until(async () => told.length === 1)
  expect(told[0]).not.toContain('links')
  expect((await peer.call<Hello>('hello', { client: 'test', version: PROTOCOL_VERSION })).extensions.map((e) => e.name)).not.toContain('links')
  await peer.call('settings.set', { key: 'extensions.links', value: true })
  await until(async () => told.length === 2)
  expect(told[1]).toContain('links')
  await close()
})

it("reserves the core's namespaces: every core method, action, setting and value is in one, and no extension takes one", async () => {
  const { RESERVED } = await import('../src/extension-host.ts')
  const { peer, hello, close } = await open([])
  for (const method of hello.methods) expect(RESERVED, method).toContain(method.split('.')[0])
  const { value } = await peer.call<{ value: { sections: { id: string; settings: { key: string }[] }[] } }>('settings.watch', {})
  for (const section of value.sections) {
    expect(RESERVED, section.id).toContain(section.id.split('.')[0])
    for (const { key } of section.settings) expect(RESERVED, key).toContain(key.split('.')[0])
  }
  for (const key of [AUTH_REJECTED, DATA_VIEWS]) expect(RESERVED, key).toContain(key.split('.')[0])
  await close()
  await expect(open([defineDaemonExtension({ name: 'thread', setup() {} })])).rejects.toThrow(/core's own/)
})

it("knows the extensions a window declares that have no daemon half: a switch for each optional one, and threads go without one off", async () => {
  const { peer, close } = await open([])
  await peer.call('extension.declare', { extensions: [{ name: 'links', title: 'Links' }, { name: 'threads', required: true }, { name: 'coding-tools', title: 'Mine' }] })
  const { value } = await peer.call<{ value: { sections: { id: string; settings: { key: string; title: string }[] }[] } }>('settings.watch', {})
  const switches = value.sections.find((s) => s.id === 'extensions')!.settings
  expect(switches.map((s) => s.key)).toEqual(['extensions.coding-tools', 'extensions.panes', 'extensions.agents-md', 'extensions.links'])
  // One the daemon sets up keeps its own declaration.
  expect(switches[0]!.title).toBe('Coding tools')
  // A newer window's word on one it declared is taken (see contract.test.ts).
  await peer.call('extension.declare', { extensions: [{ name: 'links', version: '1.0.0', title: 'Web links' }] })
  const again = await peer.call<{ value: { sections: { id: string; settings: { key: string; title: string }[] }[] } }>('settings.watch', {})
  expect(again.value.sections.find((s) => s.id === 'extensions')!.settings.find((s) => s.key === 'extensions.links')!.title).toBe('Web links')
  await peer.call<ThreadInfo>('thread.start', {})
  await peer.call('settings.set', { key: 'extensions.links', value: false })
  await until(async () => (await peer.call<ThreadInfo[]>('thread.list', {}))[0]!.without?.join() === 'links')
  await close()
})

it('announces data views, fed by a value, whose buttons run its actions: a round trip', async () => {
  const orders = defineDaemonExtension({
    name: 'orders',
    setup(superego) {
      const list = superego.value<ViewContent>('orders.recent', { items: [{ id: '1', title: 'No. 1', subtitle: 'Ada', status: 'working', actions: [{ title: 'Ship', action: 'orders.ship', params: { id: '1' } }] }] })
      superego.action(defineAction({
        id: 'orders.ship', title: 'Ship an order', runs: 'machine', params: obj({ id: str() }),
        run: ({ id }) => { list.update((c) => ({ ...c, items: c.items!.map((i) => i.id === id ? { ...i, status: 'done', subtitle: 'Ada · shipped', actions: [] } : i) })) },
      }))
      superego.view('orders.recent', { title: 'Recent orders', icon: 'list', context: 'window', fits: ['space', 'beside'], default: 'space', value: 'orders.recent' })
      superego.view('orders.notes', { title: 'Notes', context: 'thread', fits: ['beside', 'pane'], method: 'orders.notes', about: "the thread's order notes; no params" })
      superego.method('orders.notes', ({ id }) => ({ markdown: `Notes for ${String(id)}` }))
      // Checked: a source of another's, two sources, a place a window view can't go.
      expect(() => superego.view('orders.bad', { title: 'Bad', context: 'window', fits: ['space'], value: 'other.x' })).toThrow(/orders's/)
      expect(() => superego.view('orders.bad', { title: 'Bad', context: 'window', fits: ['space'], value: 'orders.a', method: 'orders.b' })).toThrow(/one source/)
      expect(() => superego.view('orders.bad', { title: 'Bad', context: 'window', fits: ['pane'], value: 'orders.a' })).toThrow(/pane/)
    },
  })
  const { peer, close } = await open([orders])
  const views = await peer.call<{ value: DataViewInfo[] }>('value.watch', { key: DATA_VIEWS })
  expect(views.value.map((v) => [v.id, v.extension])).toEqual([['orders.recent', 'orders'], ['orders.notes', 'orders']])
  expect(views.value[0]).toMatchObject({ title: 'Recent orders', icon: 'list', fits: ['space', 'beside'], default: 'space', value: 'orders.recent' })
  // The window reads the content as any value, and a button runs the action it names on this machine.
  const watched = await peer.call<{ sub: string; value: ViewContent }>('value.watch', { key: 'orders.recent' })
  let content = watched.value
  peer.on('value.changed', (p: { sub: string; value: ViewContent }) => { if (p.sub === watched.sub) content = p.value })
  const button = content.items![0]!.actions![0]!
  await peer.call('action.run', { id: button.action, params: button.params })
  await until(async () => content.items![0]!.status === 'done')
  expect(content.items![0]).toMatchObject({ subtitle: 'Ada · shipped', actions: [] })
  // A thread view's method is called with the thread; told to the agent as a pane it can open, by what it shows.
  const thread = await peer.call<ThreadInfo>('thread.start', { prompt: 'hi' })
  expect(await peer.call('orders.notes', { id: thread.id })).toEqual({ markdown: `Notes for ${thread.id}` })
  await until(async () => (await peer.call<ThreadInfo[]>('thread.list', {}))[0]!.status.state === 'done')
  const { value } = await peer.call<{ value: unknown }>('thread.watch', { thread: thread.id })
  expect(JSON.stringify(value)).toContain(`\\"orders.notes\\": the thread's order notes; no params`)
  await close()
})

it('publishes a scoped value: a watcher of one scope hears only its changes; whole, every scope by scope', async () => {
  let queue!: ScopedValue<string[]>
  let plain!: LiveValue<Record<string, number>>
  const builds = defineDaemonExtension({
    name: 'builds',
    setup(superego) {
      queue = superego.scopedValue<string[]>('builds.queue', [])
      plain = superego.value<Record<string, number>>('builds.counts', { a: 1 })
      expect(() => superego.scopedValue('builds.queue', [])).toThrow(/already published/)
      expect(() => queue.set('', ['x'])).toThrow(/non-empty/)
    },
  })
  const { peer, close } = await open([builds])
  const heard: { sub: string; value: unknown }[] = []
  peer.on('value.changed', (p: { sub: string; value: unknown }) => { heard.push(p) })
  const a = await peer.call<{ sub: string; value: string[] }>('value.watch', { key: 'builds.queue', scope: 'a' })
  const whole = await peer.call<{ sub: string; value: unknown }>('value.watch', { key: 'builds.queue' })
  expect(a.value).toEqual([])
  expect(whole.value).toEqual({})
  queue.set('b', ['other thread'])
  queue.update('a', (list) => [...list, 'first'])
  queue.set('b', ['other thread'])
  await until(async () => heard.filter((h) => h.sub === whole.sub).length >= 2)
  // a heard only its own change; whole heard both, as every scope by scope.
  expect(heard.filter((h) => h.sub === a.sub).map((h) => h.value)).toEqual([['first']])
  expect(heard.filter((h) => h.sub === whole.sub).at(-1)!.value).toEqual({ b: ['other thread'], a: ['first'] })
  expect(queue.get('a')).toEqual(['first'])
  expect(queue.get('nowhere')).toEqual([])
  expect(queue.scopes().sort()).toEqual(['a', 'b'])
  // Forgotten, a scope reads its start again.
  queue.delete('a')
  await until(async () => heard.filter((h) => h.sub === a.sub).length === 2)
  expect(heard.filter((h) => h.sub === a.sub).at(-1)!.value).toEqual([])
  // A plain value watched in a scope: its entry of that key, told only as that entry changes.
  const count = await peer.call<{ sub: string; value: unknown }>('value.watch', { key: 'builds.counts', scope: 'a' })
  expect(count.value).toBe(1)
  plain.set({ a: 1, b: 2 })
  plain.set({ a: 3, b: 2 })
  await until(async () => heard.some((h) => h.sub === count.sub))
  expect(heard.filter((h) => h.sub === count.sub).map((h) => h.value)).toEqual([3])
  await close()
})

it('keeps how a message came with it: who sent it, from which thread, for whom; and what parents read of their children', async () => {
  let api: DaemonApi | undefined
  const seen: unknown[] = []
  const relay = defineDaemonExtension({
    name: 'passer',
    setup(superego) {
      api = superego
      superego.beforeSend(({ by, from, exposure }) => { seen.push({ by, from, exposure }) })
    },
  })
  const { peer, close } = await open([relay])
  const parent = await peer.call<ThreadInfo>('thread.start', { prompt: 'lead' })
  const child = await api!.threads.start({ parent: parent.id, prompt: 'go' })
  await api!.threads.send(child.id, 'and more', { from: parent.id, exposure: 'outside' })
  const done = async (id: string) => (await peer.call<ThreadInfo[]>('thread.list', {})).find((t) => t.id === id)?.status.state === 'done'
  await until(async () => await done(child.id) && await done(parent.id))
  // The window's message is the user's own; the rest say how they came.
  expect(seen).toEqual([
    { by: undefined, from: undefined, exposure: undefined },
    { by: 'passer', from: parent.id, exposure: undefined },
    { by: 'passer', from: parent.id, exposure: 'outside' },
  ])
  const { value } = await peer.call<{ value: { entries: { kind: string; data?: unknown; model?: { role: string }[] }[] } }>('thread.watch', { thread: child.id })
  expect(value.entries.filter((e) => e.model?.[0]?.role === 'user').map((e) => [e.kind, e.data])).toEqual([
    [MESSAGE_ENTRY, { by: 'passer', from: parent.id }],
    [MESSAGE_ENTRY, { by: 'passer', from: parent.id, exposure: 'outside' }],
  ])
  // Read by its parent as it stands: a report of it can go unsaid; not by another thread, and not once it moves on.
  const now = await api!.threads.get(child.id)
  expect(api!.threads.parentRead(now)).toBe(false)
  await api!.threads.noteRead('someone', now)
  expect(api!.threads.parentRead(now)).toBe(false)
  // Read while it worked: not counted.
  await api!.threads.noteRead(parent.id, { ...now, status: { state: 'working' } })
  expect(api!.threads.parentRead(now)).toBe(false)
  // What was read, not what it is when the note is made: a run it finished since isn't read.
  await api!.threads.noteRead(parent.id, now)
  expect(api!.threads.parentRead(now)).toBe(true)
  expect(api!.threads.parentRead({ ...now, activeAt: now.activeAt + 1 })).toBe(false)
  await close()
})

it("waits until a thread isn't working (threads.idle), and tells its last answer (thread.lastAnswer)", async () => {
  // The run holds in a tool until the test lets it go, then answers.
  const turn = (content: unknown[], stopReason: string) => JSON.stringify({ at: 0, provider: 'x', model: 'x', message: { role: 'assistant', content, stopReason } })
  await writeFile(join(dir, 'turns.jsonl'), [turn([{ type: 'toolCall', id: 'c1', name: 'hold', arguments: {} }], 'toolUse'), turn([{ type: 'text', text: 'Let go.' }], 'stop')].join('\n') + '\n')
  let api: DaemonApi | undefined
  let release!: () => void
  const held = new Promise<void>((resolve) => { release = resolve })
  const holder = defineDaemonExtension({
    name: 'holder',
    setup(superego) {
      api = superego
      superego.agent(defineExtension({ name: 'holder', tools: [defineTool({ name: 'hold', description: 'Hold.', parameters: obj({}), execute: async () => { await held; return { output: [{ type: 'text', text: 'held' }] } } })] }))
    },
  })
  const { peer, close } = await open([holder], `replay:${join(dir, 'turns.jsonl')}`)
  const thread = await peer.call<ThreadInfo>('thread.start', { prompt: 'go' })
  await until(async () => (await api!.threads.get(thread.id)).status.state === 'working')
  expect(await peer.call('thread.lastAnswer', { thread: thread.id })).toEqual({ text: null })
  // Given up on: as it is, still working.
  const stop = new AbortController()
  const given = api!.threads.idle(thread.id, { signal: stop.signal })
  stop.abort()
  expect((await given).status.state).toBe('working')
  const waited = api!.threads.idle(thread.id)
  let ended = false
  void waited.then(() => { ended = true })
  await new Promise((r) => setTimeout(r, 50))
  expect(ended).toBe(false)
  release()
  expect((await waited).status.state).toBe('done')
  expect(await peer.call('thread.lastAnswer', { thread: thread.id })).toEqual({ text: 'Let go.' })
  // Not working: at once.
  expect((await api!.threads.idle(thread.id)).status.state).toBe('done')
  await expect(api!.threads.idle('999')).rejects.toMatchObject({ kind: 'not_found' })
  await close()
})

it("maps a subagent's conversation to the thread at the top of what made it (threads.of)", async () => {
  const turn = (content: unknown[], stopReason: string) => JSON.stringify({ at: 0, provider: 'x', model: 'x', message: { role: 'assistant', content, stopReason } })
  await writeFile(join(dir, 'turns.jsonl'), [turn([{ type: 'toolCall', id: 'c1', name: 'spawn', arguments: {} }], 'toolUse'), turn([{ type: 'text', text: 'Done.' }], 'stop')].join('\n') + '\n')
  let api: DaemonApi | undefined
  const found: (string | undefined)[] = []
  const spawner = defineDaemonExtension({
    name: 'spawner',
    setup(superego) {
      api = superego
      superego.agent(defineExtension({ name: 'spawner', tools: [defineTool({ name: 'spawn', description: 'Spawn.', parameters: obj({}), execute: async (_, tool, context) => {
        // A subagent's conversation, made by this call, and one made by that.
        const own = await superego.threads.conversation(superego.threads.of(tool.conversationId)!)
        const sub = await own.commit((tx) => tx.createConversation({ ownership: { kind: 'task', taskId: tool.taskId } }), context)
        found.push(superego.threads.of(Number(sub.id)))
        return { output: [{ type: 'text', text: 'spawned' }] }
      } })] }))
    },
  })
  const { peer, close } = await open([spawner], `replay:${join(dir, 'turns.jsonl')}`)
  const thread = await peer.call<ThreadInfo>('thread.start', { prompt: 'go' })
  await until(async () => found.length === 1)
  expect(found).toEqual([thread.id])
  expect(api!.threads.of(987654)).toBeUndefined()
  await close()
})

it('tells the message a tool call answers: the user message before the call, not the newest', () => {
  const user = (text: string, data: MessageOrigin = {}) => ({ kind: MESSAGE_ENTRY, data, model: [{ role: 'user', content: [{ type: 'text', text }] }] }) as never
  const calls = (...ids: string[]) => ({ kind: 'pi.assistant', model: [{ role: 'assistant', content: ids.map((id) => ({ type: 'toolCall', id, name: 'x', arguments: {} })) }] }) as never
  const result = (id: string) => ({ kind: 'pi.toolResult', model: [{ role: 'toolResult', toolCallId: id, content: [] }] }) as never
  // Newest first: an outside agent asked, the model called c1; the user typed in the window meanwhile; then c2.
  const entries = [calls('c2'), user('and this, from the window'), result('c1'), calls('c1'), user('set up my servers', { exposure: 'outside' }), calls('c0'), user('hi, from the window')]
  expect(answeredBy(entries, 'c1')).toEqual({ exposure: 'outside' })
  expect(answeredBy(entries, 'c2')).toEqual({})
  expect(answeredBy(entries, 'c0')).toEqual({})
  // Several calls in one message; and the user's message placed after the model's, before its calls ran.
  expect(answeredBy([user('mine'), calls('a', 'b'), user('theirs', { from: '7' })], 'b')).toEqual({ from: '7' })
  expect(answeredBy(entries, 'nope')).toBeUndefined()
})

it("doesn't take a user message nobody sent for the input a call answers: walks back past it, else refuses", () => {
  const said = (kind: string, text: string, data?: MessageOrigin) => ({ kind, ...(data ? { data } : {}), model: [{ role: 'user', content: [{ type: 'text', text }] }] }) as never
  const calls = (id: string) => ({ kind: 'pi.assistant', model: [{ role: 'assistant', content: [{ type: 'toolCall', id, name: 'x', arguments: {} }] }] }) as never
  // Newest first: an outside agent asked; the run compacted, reset and was continued before the model called c1.
  const entries = [calls('c1'), said('pi.user', 'continue'), said('pi.reset', 'handoff'), said('pi.compaction', 'summary'), said(MESSAGE_ENTRY, 'set up my servers', { exposure: 'outside' })]
  expect(answeredBy(entries, 'c1')).toEqual({ exposure: 'outside' })
  // No input before the call at all: not the user's.
  expect(answeredBy([calls('c1'), said('pi.compaction', 'summary')], 'c1')).toBeUndefined()
})

it("publishes an extension's state with each thread, if asked: read in as a thread's scope is watched, told every change, let go of after", async () => {
  let state!: ThreadState<{ n: number }>
  const counter = defineDaemonExtension({ name: 'counter', setup(superego) { state = superego.state<{ n: number }>({ publish: { key: 'counter.counts', empty: { n: 0 } } }) } })
  const { peer, close } = await open([counter])
  const thread = await peer.call<ThreadInfo>('thread.start', {})
  // Set while nobody watches: kept with the thread only.
  await state.set(thread.id, { n: 1 })
  const heard: { sub: string; value: unknown }[] = []
  peer.on('value.changed', (p: { sub: string; value: unknown }) => { heard.push(p) })
  const of = (sub: string) => heard.filter((h) => h.sub === sub).map((h) => h.value)
  const watched = await peer.call<{ sub: string; value: unknown }>('value.watch', { key: 'counter.counts', scope: thread.id })
  expect(watched.value).toBeNull()
  await until(async () => of(watched.sub).length === 1)
  expect(of(watched.sub)).toEqual([{ n: 1 }])
  await state.update(thread.id, (now) => ({ n: (now?.n ?? 0) + 1 }))
  await until(async () => of(watched.sub).length === 2)
  expect(of(watched.sub).at(-1)).toEqual({ n: 2 })
  // Whole: the scopes watched now. None kept: its empty.
  expect((await peer.call<{ value: unknown }>('value.watch', { key: 'counter.counts' })).value).toEqual({ [thread.id]: { n: 2 } })
  await state.set(thread.id, undefined)
  await until(async () => of(watched.sub).length === 3)
  expect(of(watched.sub).at(-1)).toEqual({ n: 0 })
  // Unwatched, let go of; watched again, read in again.
  await peer.call('unwatch', { sub: watched.sub })
  await state.set(thread.id, { n: 5 })
  const again = await peer.call<{ sub: string; value: unknown }>('value.watch', { key: 'counter.counts', scope: thread.id })
  await until(async () => of(again.sub).length === 1)
  expect(of(again.sub)).toEqual([{ n: 5 }])
  // Read, with nothing there: a thread without state, or no thread at all, reads as its empty, not as unread.
  const bare = await peer.call<ThreadInfo>('thread.start', {})
  for (const scope of [bare.id, '999']) {
    const read = await peer.call<{ sub: string; value: unknown }>('value.watch', { key: 'counter.counts', scope })
    expect(read.value).toBeNull()
    await until(async () => of(read.sub).length === 1)
    expect(of(read.sub)).toEqual([{ n: 0 }])
  }
  await close()
})

it('draws a settings section from a live value: clients get its name, not the data again; an extension reading the snapshot gets the data', async () => {
  let api!: DaemonApi
  let live!: LiveValue<{ n: number }>
  const panel = defineDaemonExtension({
    name: 'panel',
    setup(superego) {
      api = superego
      live = superego.value('panel.state', { n: 1 })
      superego.settings.register({ id: 'panel', title: 'Panel', ui: 'panel', settings: [], value: 'panel.state' })
      expect(() => superego.settings.register({ id: 'panel.more', title: 'More', settings: [], value: 'other.state' })).toThrow(/must name/)
    },
  })
  const { peer, close } = await open([panel])
  const { value } = await peer.call<{ value: SettingsSnapshot }>('settings.watch', {})
  const section = value.sections.find((s) => s.id === 'panel')!
  expect(section.value).toBe('panel.state')
  expect(section.data).toBeUndefined()
  live.set({ n: 2 })
  expect((await api.settings.snapshot()).sections.find((s) => s.id === 'panel')!.data).toEqual({ n: 2 })
  await close()
})
