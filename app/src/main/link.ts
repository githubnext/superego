// A link to one machine's daemon. It connects, says hello, relays notifications, and reconnects with backoff when the
// transport drops. While down, calls fail fast and the renderer keeps showing what it last knew (stale, not gone).
import { PROTOCOL_VERSION, RpcError, type RpcPeer } from '@mu/protocol'
import type { ConnectionState, MachineEntry, MachineId } from '../shared.ts'

export type Transport = { peer: RpcPeer; closed: Promise<void>; close(): void }

export class Link {
  readonly id: MachineId
  readonly label: string
  state: ConnectionState = 'connecting'
  error: string | undefined
  #open: () => Promise<Transport>
  #transport: Transport | undefined
  #onEvent: (method: string, params: unknown) => void
  #stopped = false
  #delay = 500

  constructor(id: MachineId, label: string, open: () => Promise<Transport>, onEvent: (method: string, params: unknown) => void) {
    this.id = id
    this.label = label
    this.#open = open
    this.#onEvent = onEvent
  }

  entry(): MachineEntry {
    return { id: this.id, label: this.label, state: this.state, ...(this.error ? { error: this.error } : {}) }
  }

  get stopped() { return this.#stopped }

  start() {
    void this.#loop()
  }

  call(method: string, params: unknown) {
    if (!this.#transport || this.state !== 'connected') throw new RpcError('disconnected', `${this.label} is not connected`)
    return this.#transport.peer.call(method, params)
  }

  stop() {
    this.#stopped = true
    this.#transport?.close()
  }

  #set(state: ConnectionState, error?: string) {
    if (this.#stopped) return
    this.state = state
    this.error = error
    this.#onEvent('$connection', this.entry())
  }

  async #loop() {
    while (!this.#stopped) {
      this.#set('connecting')
      try {
        const transport = await this.#open()
        this.#transport = transport
        transport.peer.onAny((method, params) => this.#onEvent(method, params))
        await transport.peer.call('hello', { client: 'mu-app', version: PROTOCOL_VERSION })
        this.#delay = 500
        this.#set('connected')
        await transport.closed
        this.#transport = undefined
        this.#set('disconnected', 'Connection lost')
      } catch (error) {
        this.#transport?.close()
        this.#transport = undefined
        this.#set('disconnected', error instanceof Error ? error.message : String(error))
      }
      if (this.#stopped) return
      await new Promise((resolve) => setTimeout(resolve, this.#delay))
      this.#delay = Math.min(this.#delay * 2, 30_000)
    }
  }
}
