import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { artifactUrl, CHANNEL, type BridgeChannel, type CallResult, type ChannelEvent, type SuperegoBridge, type SuperegoEvent } from '../shared/bridge.ts'

/**
 * The bridge as this (isolated) world has it: its calls answer with what happened (CallResult), not by throwing. An error
 * crosses the context bridge with its message only, and the window acts on an RPC error's `kind` (no_model,
 * profile_not_allowed, profile_missing): `window.superego` is made in the page's own world (below), where it throws
 * errors that keep it.
 */
const bridge = {
  call: (machine: string, method: string, params: unknown) => ipcRenderer.invoke(CHANNEL.call, machine, method, params) as Promise<CallResult>,
  machines: () => ipcRenderer.invoke(CHANNEL.machines),
  artifactUrl,
  forward: (machine: string, url: string) => ipcRenderer.invoke(CHANNEL.forward, machine, url) as Promise<CallResult>,
  onEvent(listener) {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  },
  async channel(machine: string, kind: string, params: unknown): Promise<CallResult> {
    const response = await ipcRenderer.invoke(CHANNEL.open, machine, kind, params) as CallResult
    return response.ok ? { ok: true, result: held(response.result as string) } : response
  },
} satisfies Omit<SuperegoBridge, 'call' | 'channel' | 'forward'> & Record<'call' | 'channel', (machine: string, method: string, params: unknown) => Promise<CallResult>> & { forward(machine: string, url: string): Promise<CallResult> }

// One IPC listener for the window; every watch subscribes here instead.
const listeners = new Set<(event: SuperegoEvent) => void>()
ipcRenderer.on(CHANNEL.event, (_event: IpcRendererEvent, event: SuperegoEvent) => { for (const listener of listeners) listener(event) })

// The window's channels: the main process holds each on the machine's link and passes its data on, one chunk at a time
// (the next once this window has read it, so credit runs from the daemon to the reader).
const channels = new Map<string, { data(bytes: Uint8Array): void; closed(reason?: string): void }>()
ipcRenderer.on(CHANNEL.data, (_event: IpcRendererEvent, event: ChannelEvent) => {
  const channel = channels.get(event.id)
  if ('data' in event) channel?.data(event.data)
  else channel?.closed(event.reason)
})

function held(id: string): BridgeChannel {
  let reader: ((bytes: Uint8Array) => void | Promise<void>) | undefined
  const waiting: Uint8Array[] = []
  const closers = new Set<(reason?: string) => void>()
  let closed: { reason?: string } | undefined
  let reading = Promise.resolve()
  const read = (bytes: Uint8Array) => {
    reading = reading.then(async () => {
      try { await reader!(bytes) } catch (error) { console.error(error) }
      ipcRenderer.send(CHANNEL.ack, id)
    })
  }
  channels.set(id, {
    data: (bytes) => { if (reader) read(bytes); else waiting.push(bytes) },
    closed: (reason) => {
      channels.delete(id)
      closed = reason ? { reason } : {}
      void reading.then(() => { for (const listener of closers) listener(reason) })
    },
  })
  ipcRenderer.send(CHANNEL.start, id)
  return {
    write: (bytes) => { if (!closed) ipcRenderer.send(CHANNEL.write, id, bytes) },
    onData: (listener) => { reader = listener; for (const bytes of waiting.splice(0)) read(bytes) },
    onClose: (listener) => { if (closed) listener(closed.reason); else closers.add(listener) },
    close: () => { if (!closed) ipcRenderer.send(CHANNEL.close, id) },
  }
}

// Run in the page's world, from its source alone (no closure): `raw` comes over the bridge, its functions proxied.
contextBridge.executeInMainWorld({
  func: (raw: typeof bridge) => {
    const answer = (response: CallResult) => {
      if (response.ok) return response.result
      throw Object.assign(new Error(response.error.message), { kind: response.error.kind })
    }
    const superego: SuperegoBridge = {
      ...raw,
      call: async (machine, method, params) => answer(await raw.call(machine, method, params)),
      channel: async (machine, kind, params) => answer(await raw.channel(machine, kind, params)) as BridgeChannel,
      forward: async (machine, url) => answer(await raw.forward(machine, url)) as string,
    }
    Object.defineProperty(globalThis, 'superego', { value: Object.freeze(superego), enumerable: true })
  },
  args: [bridge],
})

// The native menu (main/context-menu.ts) is for content, as selection is: a right-click on the chrome (what the styles
// make unselectable, and that isn't a field or an image) gets none. An image is always content, even one kept from
// being selected so it can be dragged (the lightbox's). Last to hear it, after the app's own menus.
window.addEventListener('contextmenu', (event) => {
  const target = event.target instanceof Element ? event.target : null
  if (!target || target.closest('img, input, textarea, [contenteditable]:not([contenteditable="false"])')) return
  if (getComputedStyle(target).userSelect === 'none') event.preventDefault()
})
