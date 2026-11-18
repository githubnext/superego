// A machine link (link.ts) against a fake daemon: what it offers follows `features.changed` after hello, and the
// renderer is told.
import { expect, it } from 'vitest'
import { PROTOCOL_VERSION, RpcPeer, type Hello } from '@superego/protocol'
import { Link } from '../src/link.ts'
import type { MachineEntry } from '../src/shared.ts'

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

/** A link to a fake daemon that says `hello`, connected. */
async function linked(hello: Partial<Hello>) {
  let daemon!: RpcPeer
  const client: RpcPeer = new RpcPeer((line) => queueMicrotask(() => daemon.receive(line)))
  daemon = new RpcPeer((line) => queueMicrotask(() => client.receive(line)))
  daemon.handle('hello', async () => ({ version: PROTOCOL_VERSION, machine: { id: 'm1', hostname: 'box' }, features: [], extensions: [], methods: [], ...hello }) as unknown as Hello)
  const events: { method: string; params: unknown }[] = []
  const link = new Link({ id: 'm', label: 'box', open: async () => ({ peer: client, closed: new Promise(() => {}), close() {} }), onEvent: (method, params) => events.push({ method, params }) })
  link.start()
  for (let i = 0; i < 20 && link.state !== 'connected'; i++) await settle()
  return { link, daemon, events }
}

it("follows what the daemon offers as it changes, telling the renderer", async () => {
  const { link, daemon, events } = await linked({ extensions: [{ name: 'git' }] })
  expect(link.has('ext:git')).toBe(true)
  daemon.notify('features.changed', { features: [], extensions: [] })
  for (let i = 0; i < 20 && link.has('ext:git'); i++) await settle()
  expect(link.has('ext:git')).toBe(false)
  // The entry again, with what it offers now, and the notification passed on.
  const entries = events.filter((e) => e.method === '$connection').map((e) => e.params as MachineEntry)
  expect(entries.at(-1)).toMatchObject({ state: 'connected', features: [], extensions: [] })
  expect(events.at(-1)).toEqual({ method: 'features.changed', params: { features: [], extensions: [] } })
  link.stop()
})

it("meets a newer daemon: an extension a major ahead isn't one this window speaks, and it follows what changes", async () => {
  const { link, daemon } = await linked({
    api: '2.0.0',
    extensions: [{ name: 'git', version: '2.0.0', api: '^2' }, { name: 'ask-user', version: '1.4.0', api: '^1 || ^2' }],
  })
  expect(link.entry().extensions).toHaveLength(2)
  expect(link.has('ext:git')).toBe(true)
  expect(link.has('ext:git@<2')).toBe(false)
  expect(link.has('ext:ask-user@^1')).toBe(true)
  // Downgraded there: the window hears it with what's on now.
  daemon.notify('features.changed', { features: [], extensions: [{ name: 'git', version: '1.9.0' }] })
  for (let i = 0; i < 20 && !link.has('ext:git@<2'); i++) await settle()
  expect(link.has('ext:git@<2')).toBe(true)
  expect(link.has('ext:ask-user@^1')).toBe(false)
  link.stop()
})

it("keeps a change told right behind hello's answer, before the answer is read (a restarted daemon's profiles loading)", async () => {
  let daemon!: RpcPeer
  const client: RpcPeer = new RpcPeer((line) => queueMicrotask(() => daemon.receive(line)))
  // Both lines in one go, as one read of the socket would bring them.
  let pending: string[] = []
  daemon = new RpcPeer((line) => {
    pending.push(line)
    if (pending.length === 1) queueMicrotask(() => { const lines = pending; pending = []; for (const l of lines) client.receive(l) })
  })
  daemon.handle('hello', async () => {
    queueMicrotask(() => daemon.notify('features.changed', { features: [], extensions: [{ name: 'queue', version: '1.0.0' }] }))
    return { version: PROTOCOL_VERSION, machine: { id: 'm1', hostname: 'box' }, features: [], extensions: [], methods: [] } as unknown as Hello
  })
  const link = new Link({ id: 'm', label: 'box', open: async () => ({ peer: client, closed: new Promise(() => {}), close() {} }), onEvent: () => {} })
  link.start()
  for (let i = 0; i < 20 && link.state !== 'connected'; i++) await settle()
  expect(link.has('ext:queue')).toBe(true)
  link.stop()
})
