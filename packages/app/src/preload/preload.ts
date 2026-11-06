import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { artifactUrl, CHANNEL, type CallResult, type MuBridge, type MuEvent } from '../shared.ts'

class BridgeError extends Error {
  kind: string
  constructor(kind: string, message: string) { super(message); this.kind = kind }
}

const bridge: MuBridge = {
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
}

// One IPC listener for the window; every watch subscribes here instead.
const listeners = new Set<(event: MuEvent) => void>()
ipcRenderer.on(CHANNEL.event, (_event: IpcRendererEvent, event: MuEvent) => { for (const listener of listeners) listener(event) })

contextBridge.exposeInMainWorld('mu', bridge)
