// A daemon that reaches another: the hub keeps a link (through a `via` command that pipes stdio to the other daemon's
// socket) to the machine in its machines.json, and serves it to its own clients through relay.call and relay.event.
// Both daemons run here, headless, each in a temporary data dir.
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { connectSocket, defineDaemonExtension, listen, openDaemon, type DaemonApi, type DaemonExtension, type MachineReach } from '@superego/daemon'
import threadTools from '../../../extensions/thread-tools/src/daemon.ts'
import { defineApp, PROTOCOL_VERSION, type ActionLogEntry, type Json, type MachineEntry, type Notifications, type RpcPeer, type ThreadInfo } from '@superego/protocol'
import { machineHub, MachineStore, upload } from '../src/index.ts'

const hubApp = defineApp({ name: 'hub', id: 'hubtest' })
const boxApp = defineApp({ name: 'box', id: 'boxtest' })
for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_OAUTH_TOKEN', 'OPENAI_API_KEY']) delete process.env[key]

let dir: string
const cleanups: (() => unknown)[] = []
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'superego-hub-'))
  process.env.HUBTEST_MODEL = 'faux'
  process.env.BOXTEST_MODEL = 'faux'
})
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  await rm(dir, { recursive: true, force: true })
  delete process.env.HUBTEST_MODEL
  delete process.env.HUBTEST_REPLAY_SPEED
  delete process.env.BOXTEST_MODEL
})

const until = async (check: () => boolean | Promise<boolean>, ms = 10_000) => {
  const end = Date.now() + ms
  while (!(await check())) {
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

/** A daemon on a socket of its own. */
async function start(app: typeof hubApp, name: string, reach?: (self: Parameters<typeof machineHub>[0]['self']) => MachineReach, extensions: DaemonExtension[] = []) {
  const dataDir = join(dir, name)
  // The thread tools are the threads extension's: the hub's agent starts a thread on the box with them.
  const daemon = await openDaemon({ app, dataDir, defaultCwd: dir, agentsDir: join(dir, 'agents'), extensions: [threadTools, ...extensions], ...(reach ? { reach } : {}) })
  const socket = join(dir, `${name}.sock`)
  const server = await listen(daemon, socket)
  cleanups.push(async () => { server.close(); await daemon.close() })
  return { daemon, dataDir, socket }
}

/** A `via` command that splices its stdio to a daemon's socket, as `ssh <host> superego connect` would. */
async function viaTo(socket: string) {
  const script = join(dir, 'splice.cjs')
  await writeFile(script, "const s = require('net').connect(process.argv[2]); process.stdin.pipe(s); s.pipe(process.stdout); s.on('close', () => process.exit(0)); s.on('error', () => process.exit(1))\n")
  return `'${process.execPath}' '${script}' '${socket}'`
}

/** A client of the hub that keeps what it hears: `from`, one in that thread's shell. */
async function client(socket: string, from?: string) {
  const { peer, socket: conn } = await connectSocket(socket)
  cleanups.push(() => conn.destroy())
  await peer.call('hello', { client: 'test', version: PROTOCOL_VERSION, ...(from ? { from } : {}) })
  const events: Notifications['relay.event'][] = []
  peer.on('relay.event', (params: Notifications['relay.event']) => events.push(params))
  let machines: MachineEntry[] = []
  const watched = await peer.call<{ sub: string; value: MachineEntry[] }>('machines.watch', {})
  machines = watched.value
  peer.on('machines.changed', ({ sub, value }: Notifications['machines.changed']) => { if (sub === watched.sub) machines = value })
  return { peer, conn, events, machines: () => machines }
}

/** A hub that reaches `box`, its calls on the way recorded. `older`: the box's daemon passes for one without `relay.as`. */
async function hubReaching(box: { socket: string }, extra: { label: string; via: string }[] = [], { extensions = [], older = false }: { extensions?: DaemonExtension[]; older?: boolean } = {}) {
  const hubDir = join(dir, 'hub')
  const store = new MachineStore(hubDir)
  const added = await store.add({ label: 'Box', via: await viaTo(box.socket) })
  for (const machine of extra) await store.add(machine)
  store.close()
  const calls: { machine: string; method: string; params: unknown }[] = []
  const hub = await start(hubApp, 'hub', (self) => {
    const reach = machineHub({ app: hubApp, dataDir: hubDir, self })
    return {
      ...reach, call: (machine, method, params) => { calls.push({ machine, method, params }); return reach.call(machine, method, params) },
      offers: (machine, feature) => !(older && feature === 'relay-as') && reach.offers(machine, feature),
    }
  }, extensions)
  return { ...hub, box: added.id, calls }
}

const call = <T,>(peer: RpcPeer, machine: string, method: string, params: unknown) => peer.call<T>('relay.call', { machine, method, params })

it('lists the machines it reaches, passes calls on, and brings their news back to whoever used them', async () => {
  const box = await start(boxApp, 'box')
  const hub = await hubReaching(box)
  const a = await client(hub.socket)
  const b = await client(hub.socket)
  expect(a.machines()[0]).toMatchObject({ id: 'local', state: 'connected', machine: { id: hub.daemon.machine.id } })
  await until(() => a.machines().find((m) => m.id === hub.box)?.state === 'connected')
  expect(a.machines().find((m) => m.id === hub.box)).toMatchObject({ label: 'Box', machine: { id: box.daemon.machine.id }, remote: { ssh: false } })
  // The machine id it remembered for next time, written once it connected.
  await until(() => new MachineStore(join(dir, 'hub')).get(hub.box)?.daemonId === box.daemon.machine.id)

  // The far daemon lists the hub as a client, named for its computer.
  const { value: boxClients } = await connectSocket(box.socket).then(async ({ peer, socket }) => {
    cleanups.push(() => socket.destroy())
    await peer.call('hello', { client: 'test', version: PROTOCOL_VERSION })
    return peer.call<{ value: { kind: string }[] }>('clients.watch', {})
  })
  expect(boxClients.map((c) => c.kind)).toContain('hubtest-daemon')

  const watch = await call<{ sub: string; value: ThreadInfo[] }>(a.peer, hub.box, 'threads.watch', {})
  expect(watch.value).toEqual([])
  const thread = await call<ThreadInfo>(a.peer, hub.box, 'thread.start', { title: 'Over there' })
  await until(() => a.events.some((e) => e.machine === hub.box && e.method === 'threads.changed'
    && (e.params as Notifications['threads.changed']).sub === watch.sub && (e.params as Notifications['threads.changed']).value.some((t) => t.id === thread.id)))
  // b never called the box: none of its news.
  expect(b.events).toEqual([])
  // Not for the link's own business, nor for this machine.
  await expect(call(a.peer, hub.box, 'hello', {})).rejects.toMatchObject({ kind: 'invalid' })
  await expect(call(a.peer, 'local', 'thread.list', {})).rejects.toMatchObject({ kind: 'invalid' })
  await expect(call(a.peer, 'nowhere', 'thread.list', {})).rejects.toMatchObject({ kind: 'not_found' })

  // a goes: the watch it opened over there ends with it.
  a.conn.destroy()
  await until(() => hub.calls.some((c) => c.method === 'unwatch' && (c.params as { sub: string }).sub === watch.sub))

  // Reconnecting a machine drops its link and makes another.
  await b.peer.call('machine.reconnect', { id: hub.box })
  await until(() => b.machines().find((m) => m.id === hub.box)?.state === 'connected')
  expect(await call<ThreadInfo[]>(b.peer, hub.box, 'thread.list', {})).toMatchObject([{ id: thread.id }])
})

it('passes large attachments on, uploaded to the hub and again to the machine', async () => {
  const box = await start(boxApp, 'box')
  const hub = await hubReaching(box)
  const a = await client(hub.socket)
  await until(() => a.machines().find((m) => m.id === hub.box)?.state === 'connected')
  const thread = await call<ThreadInfo>(a.peer, hub.box, 'thread.start', { title: 'files' })
  const bytes = Buffer.alloc(300 * 1024, 'x')
  const id = await upload(a.peer, { name: 'big.txt', mimeType: 'text/plain', bytes })
  await call(a.peer, hub.box, 'thread.send', { thread: thread.id, text: 'see', attachments: [{ name: 'big.txt', mimeType: 'text/plain', upload: id }] })
  expect((await readFile(join(box.dataDir, 'attachments', thread.id, 'big.txt'))).equals(bytes)).toBe(true)
  // Through action.run too, as the window sends it.
  const again = await upload(a.peer, { name: 'again.txt', mimeType: 'text/plain', bytes })
  await call(a.peer, hub.box, 'action.run', { id: 'thread.send', params: { thread: thread.id, text: 'more', attachments: [{ name: 'again.txt', mimeType: 'text/plain', upload: again }] } })
  expect((await readFile(join(box.dataDir, 'attachments', thread.id, 'again.txt'))).equals(bytes)).toBe(true)
})

it('refuses a machine reached twice, and a route back to itself', async () => {
  const box = await start(boxApp, 'box')
  const hubSocket = join(dir, 'hub.sock')
  const hub = await hubReaching(box, [{ label: 'Box again', via: await viaTo(box.socket) }, { label: 'Myself', via: await viaTo(hubSocket) }])
  const a = await client(hub.socket)
  const entry = (label: string) => a.machines().find((m) => m.label === label)
  await until(() => entry('Myself')?.errorKind === 'duplicate_machine')
  expect(entry('Myself')!.error).toMatch(/itself/)
  // The two routes to the box race: whichever answers first is the box, the other the duplicate.
  const routes = () => [entry('Box'), entry('Box again')]
  await until(() => routes().some((e) => e?.state === 'connected') && routes().some((e) => e?.errorKind === 'duplicate_machine'))
})

it('lets an agent start a thread on another machine', async () => {
  const box = await start(boxApp, 'box')
  const turn = (content: Json[], stopReason: string) => JSON.stringify({ at: 0, provider: 'x', model: 'x', message: { role: 'assistant', content, stopReason } })
  await writeFile(join(dir, 'turns.jsonl'), [
    turn([{ type: 'toolCall', id: 'c1', name: 'thread_machines', arguments: {} }], 'toolUse'),
    turn([{ type: 'toolCall', id: 'c2', name: 'thread_start', arguments: { machine: 'Box', prompt: 'Count the files', title: 'Remote count' } }], 'toolUse'),
    turn([{ type: 'text', text: 'Started it.' }], 'stop'),
  ].join('\n') + '\n')
  process.env.HUBTEST_MODEL = `replay:${join(dir, 'turns.jsonl')}`
  process.env.HUBTEST_REPLAY_SPEED = '0'
  const hub = await hubReaching(box)
  const a = await client(hub.socket)
  await until(() => a.machines().find((m) => m.id === hub.box)?.state === 'connected')

  const parent = await a.peer.call<ThreadInfo>('thread.start', { prompt: 'Have the box count its files', title: 'Parent' })
  await until(async () => (await a.peer.call<ThreadInfo[]>('thread.list', {}))[0]?.status.state === 'done')
  const there = await call<ThreadInfo[]>(a.peer, hub.box, 'thread.list', {})
  expect(there).toHaveLength(1)
  expect(there[0]).toMatchObject({ title: 'Remote count' })
  expect(there[0]!.parent).toBeUndefined()
  // Its own catalog has the parent only: the child lives over there.
  expect((await a.peer.call<ThreadInfo[]>('thread.list', {})).map((t) => t.id)).toEqual([parent.id])
  const { value } = await a.peer.call<{ value: { entries: unknown[] } }>('thread.watch', { thread: parent.id })
  const transcript = JSON.stringify(value.entries)
  expect(transcript).toContain('Box (id ')
  expect(transcript).toContain(`Started \\"Remote count\\" (thread ${there[0]!.id} on Box)`)
  // The box's faux model answers the child's prompt.
  await until(async () => (await call<ThreadInfo[]>(a.peer, hub.box, 'thread.list', {}))[0]?.status.state === 'done')
})

it("refuses the user's consent to a thread's shell and an extension calling another machine, there as here", async () => {
  let machines!: DaemonApi['machines']
  const asker = defineDaemonExtension({ name: 'asker', setup(superego) { machines = superego.machines } })
  const box = await start(boxApp, 'box')
  const hub = await hubReaching(box, [], { extensions: [asker] })
  const user = await client(hub.socket)
  const shell = await client(hub.socket, '7')
  await until(() => user.machines().find((m) => m.id === hub.box)?.state === 'connected')
  const secret = { key: 'mail.token', value: 'x' }
  const consent = { kind: 'consent' }
  // The user's own call is theirs: it reaches the box's router (which has no such secret).
  await expect(call(user.peer, hub.box, 'secrets.set', secret)).rejects.toMatchObject({ kind: 'unknown_setting' })
  // A thread's shell, by the action's id or through action.run, and a setting that records consent.
  await expect(call(shell.peer, hub.box, 'secrets.set', secret)).rejects.toMatchObject(consent)
  await expect(call(shell.peer, hub.box, 'action.run', { id: 'secrets.set', params: secret })).rejects.toMatchObject(consent)
  await expect(call(shell.peer, hub.box, 'settings.set', { key: 'outside.startThreads', value: true })).rejects.toMatchObject(consent)
  // An extension, as its dispatch is here.
  await expect(machines.call(hub.box, 'secrets.set', secret)).rejects.toMatchObject(consent)
  await expect(machines.call(hub.box, 'action.run', { id: 'settings.set', params: { key: 'outside.startThreads', value: true } })).rejects.toMatchObject(consent)
  expect(box.daemon.settings.get('outside.startThreads')).toBe(false)
  // What isn't consent goes through for both, as it did: the box's action log says whose it was.
  expect(await call(shell.peer, hub.box, 'thread.list', {})).toEqual([])
  expect(await machines.call(hub.box, 'thread.list', {})).toEqual([])
  await call(shell.peer, hub.box, 'thread.start', { title: 'From a shell' })
  const log = await call<ActionLogEntry[]>(user.peer, hub.box, 'action.log', {})
  expect(log.find((e) => e.id === 'thread.start')?.client).toMatchObject({ kind: 'hubtest-daemon', from: '7' })
})

it("passes on to an older machine, for a thread's shell or an extension, nothing that could be the user's consent", async () => {
  let machines!: DaemonApi['machines']
  const asker = defineDaemonExtension({ name: 'asker', setup(superego) { machines = superego.machines } })
  const box = await start(boxApp, 'box')
  const hub = await hubReaching(box, [], { extensions: [asker], older: true })
  const user = await client(hub.socket)
  const shell = await client(hub.socket, '7')
  await until(() => user.machines().find((m) => m.id === hub.box)?.state === 'connected')
  const secret = { key: 'mail.token', value: 'x' }
  const consent = { kind: 'consent', message: expect.stringContaining('older Superego') }
  await expect(call(shell.peer, hub.box, 'secrets.set', secret)).rejects.toMatchObject(consent)
  await expect(call(shell.peer, hub.box, 'action.run', { id: 'settings.set', params: { key: 'outside.startThreads', value: true } })).rejects.toMatchObject(consent)
  await expect(machines.call(hub.box, 'secrets.set', secret)).rejects.toMatchObject(consent)
  // An extension's action or method there, which this machine can't judge, and a call passed on again.
  await expect(call(shell.peer, hub.box, 'mail.send', {})).rejects.toMatchObject(consent)
  await expect(call(shell.peer, hub.box, 'action.run', { id: 'mail.send' })).rejects.toMatchObject(consent)
  await expect(call(shell.peer, hub.box, 'relay.call', { machine: 'x', method: 'secrets.set', params: secret })).rejects.toMatchObject(consent)
  expect(hub.calls.filter((c) => c.method !== 'hello' && c.method !== 'unwatch')).toEqual([])
  // Reads and the core's other actions still go, and the user's own calls as ever.
  expect(await call(shell.peer, hub.box, 'thread.list', {})).toEqual([])
  expect(await machines.call(hub.box, 'thread.list', {})).toEqual([])
  await expect(call(user.peer, hub.box, 'secrets.set', secret)).rejects.toMatchObject({ kind: 'unknown_setting' })
})

it("lets an extension change the list (superego.machines): added, renamed, switched off and removed, in machines.json", async () => {
  let machines!: DaemonApi['machines']
  const keeper = defineDaemonExtension({ name: 'keeper', setup(superego) { machines = superego.machines } })
  const dataDir = join(dir, 'hub')
  const daemon = await openDaemon({ app: hubApp, dataDir, defaultCwd: dir, agentsDir: join(dir, 'agents'), extensions: [keeper], reach: (self) => machineHub({ app: hubApp, dataDir, self }) })
  cleanups.push(() => daemon.close())
  const added = await machines.add({ label: 'Box', target: 'me@box' })
  expect(added).toMatchObject({ label: 'Box', remote: { enabled: true, ssh: true } })
  expect(machines.list().map((m) => m.label)).toEqual(['Box'])
  expect(await machines.update(added.id, { label: 'Build box', enabled: false })).toMatchObject({ label: 'Build box', state: 'disabled' })
  expect(JSON.parse(await readFile(join(dataDir, 'machines.json'), 'utf8'))).toMatchObject([{ id: added.id, label: 'Build box', target: 'me@box', enabled: false }])
  await machines.remove(added.id)
  expect(machines.list()).toEqual([])
  await expect(machines.remove(added.id)).rejects.toMatchObject({ kind: 'not_found' })
  await expect(machines.add({ target: '-oProxyCommand=x' })).rejects.toMatchObject({ kind: 'invalid' })
})
