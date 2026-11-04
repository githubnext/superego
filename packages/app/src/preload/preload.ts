import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { CHANNEL, type CallResult, type MuBridge, type MuEvent } from '../shared.ts'

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
  onEvent(listener) {
    const handler = (_event: IpcRendererEvent, event: MuEvent) => listener(event)
    ipcRenderer.on(CHANNEL.event, handler)
    return () => { ipcRenderer.off(CHANNEL.event, handler) }
  },
}

contextBridge.exposeInMainWorld('mu', bridge)
