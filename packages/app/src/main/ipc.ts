// The windows' IPC: their calls (on a machine's daemon, or the app's own endpoint) and the machines list, answered as
// CallResults; and their protocol channels (a terminal's bytes, say), held on the machine's link, each chunk passed to
// its window and read there before the next, and every one of a window's aborted when its page loads again or it goes.
// The preload is the other half (preload.ts).
import { randomUUID } from 'node:crypto'
import { ipcMain, type IpcMainEvent, type IpcMainInvokeEvent, type WebContents } from 'electron'
import { RpcError } from '@superego/protocol'
import type { Link } from '@superego/client'
import { CHANNEL, type CallResult, type ChannelEvent, type MachineEntry } from '../shared/bridge.ts'
import { APP } from '../shared/app-settings.ts'
import type { AppWindow, HeldChannel } from './app-windows.ts'

/** A failure as a window's call answers it: an RPC error keeps its kind. */
export const toCallResult = (error: unknown): CallResult =>
  ({ ok: false, error: { kind: error instanceof RpcError ? error.kind : 'error', message: error instanceof Error ? error.message : String(error) } })

export type IpcOptions = {
  machines(): MachineEntry[]
  linkOf(machine: string): Link | undefined
  /** The open window whose page this is. */
  windowOf(contents: WebContents): AppWindow | undefined
  /** A call on the app's own endpoint, from `window`. */
  callApp(window: AppWindow, method: string, params: unknown): Promise<unknown>
}

export function serveIpc({ machines, linkOf, windowOf, callApp }: IpcOptions) {
  const windowFor = (event: IpcMainInvokeEvent | IpcMainEvent) => {
    const window = windowOf(event.sender)
    if (!window) throw new RpcError('unknown_window', 'Not one of the app\'s windows')
    return window
  }
  const answer = async (run: () => Promise<unknown>): Promise<CallResult> => {
    try { return { ok: true, result: await run() } } catch (error) { return toCallResult(error) }
  }

  ipcMain.handle(CHANNEL.machines, () => machines())
  ipcMain.handle(CHANNEL.call, (event, machine: string, method: string, params: unknown) => answer(() => {
    if (machine === APP) return callApp(windowFor(event), method, params ?? {})
    const link = linkOf(machine)
    if (!link) throw new RpcError('unknown_machine', `No machine ${machine}`)
    return link.call(method, params)
  }))

  ipcMain.handle(CHANNEL.open, (event, machine: string, kind: string, params: unknown) => answer(async () => {
    const window = windowFor(event)
    const link = machine === APP ? undefined : linkOf(machine)
    if (!link) throw new RpcError('unknown_machine', `No machine ${machine}`)
    const channel = await link.channel(kind, params)
    const id = randomUUID()
    const held: HeldChannel = { channel, reads: [], start: () => {} }
    window.channels.set(id, held)
    const send = (message: ChannelEvent) => { if (!window.contents.isDestroyed()) window.contents.send(CHANNEL.data, message) }
    // Read once the window is ready for it (`start`): it knows the channel's id only once this has answered.
    held.start = () => channel.onData((data) => new Promise<void>((read) => {
      if (window.contents.isDestroyed()) return read()
      held.reads.push(read)
      send({ id, data })
    }))
    const closed = (reason?: string) => {
      if (!window.channels.delete(id)) return
      channel.end()
      for (const read of held.reads.splice(0)) read()
      send({ id, closed: true, ...(reason ? { reason } : {}) })
    }
    channel.ended.then(() => closed(), (error: Error) => closed(error.message))
    return id
  }))
  const heldBy = (event: IpcMainEvent, id: string) => windowOf(event.sender)?.channels.get(id)
  ipcMain.on(CHANNEL.write, (event, id: string, bytes: Uint8Array) => { heldBy(event, id)?.channel.write(bytes).catch(() => {}) })
  ipcMain.on(CHANNEL.start, (event, id: string) => { heldBy(event, id)?.start() })
  ipcMain.on(CHANNEL.ack, (event, id: string) => { heldBy(event, id)?.reads.shift()?.() })
  ipcMain.on(CHANNEL.close, (event, id: string) => { heldBy(event, id)?.channel.abort('Closed') })
  ipcMain.on(CHANNEL.reset, (event) => windowOf(event.sender)?.dropChannels())
}
