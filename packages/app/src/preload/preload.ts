import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { artifactUrl, CHANNEL, type BridgeChannel, type CallResult, type ChannelEvent, type SuperegoBridge, type SuperegoEvent } from '../shared.ts'

class BridgeError extends Error {
  kind: string
  constructor(kind: string, message: string) { super(message); this.kind = kind }
}

const bridge: SuperegoBridge = {
  async call(machine, method, params) {
    const response = await ipcRenderer.invoke(CHANNEL.call, machine, method, params) as CallResult
    if (!response.ok) throw new BridgeError(response.error.kind, response.error.message)
    return response.result
  },
  machines: () => ipcRenderer.invoke(CHANNEL.machines),
  artifactUrl,
  onEvent(listener) {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  },
  async channel(machine, kind, params) {
    const response = await ipcRenderer.invoke(CHANNEL.open, machine, kind, params) as CallResult
    if (!response.ok) throw new BridgeError(response.error.kind, response.error.message)
    return held(response.result as string)
  },
}

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
// A page (re)loaded has none of the channels its last one opened.
ipcRenderer.send(CHANNEL.reset)

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
  return {
    write: (bytes) => { if (!closed) ipcRenderer.send(CHANNEL.write, id, bytes) },
    onData: (listener) => { reader = listener; for (const bytes of waiting.splice(0)) read(bytes) },
    onClose: (listener) => { if (closed) listener(closed.reason); else closers.add(listener) },
    close: () => { if (!closed) ipcRenderer.send(CHANNEL.close, id) },
  }
}

contextBridge.exposeInMainWorld('superego', bridge)
