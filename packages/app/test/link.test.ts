// A machine link (main/link.ts) against a fake daemon: what it offers follows `features.changed` after hello, and the
// renderer is told.
import { expect, it } from 'vitest'
import { PROTOCOL_VERSION, RpcPeer, type Hello } from '@superego/protocol'
import { Link } from '../src/main/link.ts'
import type { MachineEntry } from '../src/shared.ts'

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

it("follows what the daemon offers as it changes, telling the renderer", async () => {
  let daemon!: RpcPeer
  const client: RpcPeer = new RpcPeer((line) => queueMicrotask(() => daemon.receive(line)))
  daemon = new RpcPeer((line) => queueMicrotask(() => client.receive(line)))
  daemon.handle('hello', async () => ({ version: PROTOCOL_VERSION, machine: { id: 'm1', hostname: 'box' }, features: ['threads', 'ext:git'], methods: [] }) as unknown as Hello)
  const events: { method: string; params: unknown }[] = []
  const link = new Link({ id: 'm', label: 'box', open: async () => ({ peer: client, closed: new Promise(() => {}), close() {} }), onEvent: (method, params) => events.push({ method, params }) })
  link.start()
  for (let i = 0; i < 20 && link.state !== 'connected'; i++) await settle()
  expect(link.has('ext:git')).toBe(true)
  daemon.notify('features.changed', { features: ['threads'] })
  for (let i = 0; i < 20 && link.has('ext:git'); i++) await settle()
  expect(link.has('ext:git')).toBe(false)
  // The entry again, with the new features, and the notification passed on.
  const entries = events.filter((e) => e.method === '$connection').map((e) => e.params as MachineEntry)
  expect(entries.at(-1)).toMatchObject({ state: 'connected', features: ['threads'] })
  expect(events.at(-1)).toEqual({ method: 'features.changed', params: { features: ['threads'] } })
  link.stop()
})
