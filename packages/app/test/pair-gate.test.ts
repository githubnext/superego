// @vitest-environment happy-dom
// The browser's gate (pair-gate.ts, through web-bridge.ts) on one of the user's own tailnet devices that waits to be
// approved: it names the device as Settings lists it, still takes a pairing code, and goes, connecting, once approved.
import { afterEach, expect, it, vi } from 'vitest'
import { PROTOCOL_VERSION } from '@superego/protocol'

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); document.body.innerHTML = '' })

it('says which device to approve, and connects once it is', async () => {
  vi.useFakeTimers()
  let approved = false
  const fetches: string[] = []
  vi.stubGlobal('fetch', async (url: string) => {
    fetches.push(url)
    if (approved) return new Response(null, { status: 204 })
    return new Response(JSON.stringify({ waiting: 'phone' }), { status: 401, headers: { 'content-type': 'application/json' } })
  })
  const sockets: Socket[] = []
  // Refused at the door until approved: closed before it opens.
  class Socket {
    static OPEN = 1
    readyState = 1
    bufferedAmount = 0
    onopen?: () => void
    onmessage?: (message: { data: string }) => void
    onclose?: () => void
    constructor() {
      sockets.push(this)
      queueMicrotask(() => approved ? this.onopen?.() : this.onclose?.())
    }
    send(line: string) {
      const request = JSON.parse(line) as { id: number; method: string }
      const result = request.method === 'hello' ? { version: PROTOCOL_VERSION, machine: { id: 'm1', hostname: 'box' }, features: [], extensions: [], methods: [] }
        : request.method === 'machines.watch' ? { sub: 'w1', value: [{ id: 'local', label: 'box', state: 'connected' }] } : null
      queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) }))
    }
    close() { this.onclose?.() }
  }
  vi.stubGlobal('WebSocket', Socket)
  const { webBridge } = await import('../src/renderer/web-bridge.ts')
  webBridge()
  await vi.waitFor(() => expect(document.querySelector('.pair-gate')).not.toBeNull())
  const gate = document.querySelector('.pair-gate')!
  expect(gate.querySelector('.pair-gate__title')?.textContent).toBe('Approve this device')
  expect(gate.querySelector('.pair-gate__name')?.textContent).toBe('phone')
  // A code still pairs it.
  expect(gate.querySelector('input[name=code]')).not.toBeNull()
  // Still waiting: it asks again, and stays.
  await vi.advanceTimersByTimeAsync(3_000)
  expect(fetches.filter((url) => url === '/rpc').length).toBe(2)
  expect(document.querySelector('.pair-gate')).not.toBeNull()
  approved = true
  await vi.advanceTimersByTimeAsync(3_000)
  expect(document.querySelector('.pair-gate')).toBeNull()
  await vi.advanceTimersByTimeAsync(1_000)
  expect(sockets.length).toBe(2)
})
