// The windows' IPC in the main process: a protocol channel held for the page that opened it, and given up when that
// page is gone.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CallResult } from '../src/shared/bridge.ts'

const handlers = new Map<string, (event: unknown, ...args: never[]) => unknown>()
const listeners = new Map<string, (event: unknown, ...args: never[]) => void>()
vi.mock('electron', () => ({
  ipcMain: {
    handle: (name: string, handler: (event: unknown, ...args: never[]) => unknown) => handlers.set(name, handler),
    on: (name: string, listener: (event: unknown, ...args: never[]) => void) => listeners.set(name, listener),
  },
}))
const { AppWindow } = await import('../src/main/app-windows.ts')
const { serveIpc } = await import('../src/main/ipc.ts')
const { CHANNEL } = await import('../src/shared/bridge.ts')

/** A channel on a machine's link, opened once `open()` is called. */
function fakeLink() {
  let open!: () => void
  let end!: () => void
  const channel = { abort: vi.fn(), end: vi.fn(), onData: vi.fn(), write: vi.fn(), ended: new Promise<void>((resolve) => { end = resolve }) }
  const opening = new Promise<void>((resolve) => { open = resolve })
  const link = { channel: vi.fn(async () => { await opening; return channel }) }
  return { link, channel, open: () => open(), end: () => end() }
}

let sent: unknown[]
let window: InstanceType<typeof AppWindow>
let link: ReturnType<typeof fakeLink>
beforeEach(() => {
  handlers.clear()
  listeners.clear()
  sent = []
  const contents = { isDestroyed: () => false, send: (_channel: string, message: unknown) => sent.push(message) }
  window = new AppWindow('w1', { webContents: contents } as never, () => ({}) as never)
  link = fakeLink()
  serveIpc({
    machines: () => [], linkOf: (machine) => machine === 'local' ? link.link as never : undefined,
    windowOf: (of) => of === window.contents ? window : undefined, callApp: async () => null, forwardUrl: async (_machine, url) => url,
  })
})
const open = () => handlers.get(CHANNEL.open)!({ sender: window.contents }, ...['local', 'terminal', {}] as never[]) as Promise<CallResult>

describe('a window\'s channels', () => {
  it('holds one for its page until it ends, then tells the page', async () => {
    const opening = open()
    link.open()
    const result = await opening
    expect(result.ok).toBe(true)
    const id = (result as { result: string }).result
    expect(window.channels.has(id)).toBe(true)
    listeners.get(CHANNEL.start)!({ sender: window.contents }, ...[id] as never[])
    expect(link.channel.onData).toHaveBeenCalledOnce()
    link.end()
    await vi.waitFor(() => expect(window.channels.has(id)).toBe(false))
    expect(link.channel.end).toHaveBeenCalled()
    expect(sent).toEqual([{ id, closed: true }])
  })

  it('aborts one that opens after its page went, and says the window is unknown', async () => {
    const opening = open()
    window.pageLoaded()
    link.open()
    expect(await opening).toEqual({ ok: false, error: { kind: 'unknown_window', message: 'The page that opened it is gone' } })
    expect(link.channel.abort).toHaveBeenCalled()
    expect(window.channels.size).toBe(0)
  })

  it('aborts every one as the page loads again', async () => {
    const opening = open()
    link.open()
    await opening
    window.pageLoaded()
    expect(link.channel.abort).toHaveBeenCalledWith('The page loaded again')
  })
})
