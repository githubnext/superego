// The browser's bridge (web-bridge.ts) against a fake WebSocket: what the daemon offers follows `features.changed`.
import { expect, it, vi } from 'vitest'
import { PROTOCOL_VERSION } from '@superego/protocol'
import type { MachineEntry, SuperegoEvent } from '../src/shared.ts'

class FakeSocket {
  static OPEN = 1
  static last: FakeSocket
  readyState = 1
  onopen?: () => void
  onmessage?: (message: { data: string }) => void
  onclose?: () => void
  constructor() { FakeSocket.last = this; queueMicrotask(() => this.onopen?.()) }
  send(line: string) {
    const request = JSON.parse(line) as { id: number; method: string }
    if (request.method === 'hello') this.receive({ jsonrpc: '2.0', id: request.id, result: { version: PROTOCOL_VERSION, machine: { id: 'm1', hostname: 'box' }, features: ['threads', 'ext:git'], methods: [] } })
  }
  receive(message: unknown) { queueMicrotask(() => this.onmessage?.({ data: JSON.stringify(message) })) }
}

it('follows what the daemon offers as it changes', async () => {
  const storage = new Map<string, string>()
  vi.stubGlobal('location', { hash: '', hostname: 'box', host: 'box:1', protocol: 'http:', pathname: '/', search: '' })
  vi.stubGlobal('localStorage', { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => storage.set(k, v), removeItem: (k: string) => storage.delete(k) })
  vi.stubGlobal('WebSocket', FakeSocket)
  const { webBridge } = await import('../src/renderer/web-bridge.ts')
  const bridge = webBridge()
  const entries: MachineEntry[] = []
  bridge.onEvent((event: SuperegoEvent) => { if (event.method === '$machines') entries.push(...(event.params as MachineEntry[])) })
  const settle = async (check: () => boolean) => { for (let i = 0; i < 50 && !check(); i++) await new Promise((r) => setTimeout(r, 0)) }
  await settle(() => entries.at(-1)?.state === 'connected')
  expect(entries.at(-1)?.features).toEqual(['threads', 'ext:git'])
  FakeSocket.last.receive({ jsonrpc: '2.0', method: 'features.changed', params: { features: ['threads'] } })
  await settle(() => entries.at(-1)?.features?.length === 1)
  expect(entries.at(-1)).toMatchObject({ state: 'connected', features: ['threads'] })
  expect((await bridge.machines())[0]?.features).toEqual(['threads'])
  vi.unstubAllGlobals()
})

it('pairs with the ticket in the address, after taking it out of the address, then connects by cookie alone', async () => {
  vi.resetModules()
  const storage = new Map<string, string>([['superego.webToken', 'old']])
  const location = { hash: '#pair=tick', hostname: 'box', host: 'box:1', protocol: 'http:', pathname: '/', search: '' }
  const steps: string[] = []
  vi.stubGlobal('location', location)
  vi.stubGlobal('history', { replaceState: (_s: unknown, _t: string, url: string) => { steps.push(`replace ${url}`); location.hash = '' } })
  vi.stubGlobal('localStorage', { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => storage.set(k, v), removeItem: (k: string) => storage.delete(k) })
  vi.stubGlobal('fetch', async (url: string, init?: { method?: string; body?: string }) => {
    steps.push(`${init?.method ?? 'GET'} ${url}${init?.body ? ` ${init.body}` : ''} (hash ${JSON.stringify(location.hash)})`)
    return { ok: url === '/pair', status: url === '/pair' ? 200 : 401 }
  })
  const sockets: string[] = []
  vi.stubGlobal('WebSocket', class extends FakeSocket { constructor(url: string) { super(); sockets.push(url) } })
  const { webBridge } = await import('../src/renderer/web-bridge.ts')
  const bridge = webBridge()
  const entries: MachineEntry[] = []
  bridge.onEvent((event: SuperegoEvent) => { if (event.method === '$machines') entries.push(...(event.params as MachineEntry[])) })
  for (let i = 0; i < 50 && entries.at(-1)?.state !== 'connected'; i++) await new Promise((r) => setTimeout(r, 0))
  expect(steps).toEqual(['replace /', 'GET /rpc (hash "")', 'POST /pair {"ticket":"tick"} (hash "")'])
  expect(sockets).toEqual(['ws://box:1/rpc'])
  expect(storage.has('superego.webToken')).toBe(false)
  vi.unstubAllGlobals()
})
