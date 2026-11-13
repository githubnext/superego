// A link to one machine's daemon. It connects, says hello, relays notifications, and reconnects with backoff when the
// transport drops. While down, calls fail fast and the renderer keeps showing what it last knew (stale, not gone).
import { FEATURES, PROTOCOL_VERSION, RpcError, type Hello } from '@superego/protocol'
import type { ConnectionState, MachineEntry, MachineId } from '../shared.ts'

import type { Transport } from '@superego/client'

/** Errors that another attempt can't fix: the link waits for the user (or a restart) instead of retrying. */
const FINAL = new Set(['version_mismatch', 'wrong_machine', 'duplicate_machine'])

export type LinkOptions = {
  id: MachineId
  label: string
  open(): Promise<Transport>
  onEvent(method: string, params: unknown): void
  /** Check who answered before the link counts as connected; throw to refuse it. */
  verify?(hello: Hello): void
}

export class Link {
  readonly id: MachineId
  readonly label: string
  state: ConnectionState = 'connecting'
  error: { kind: string; message: string } | undefined
  /** The last hello from the daemon: who it is and what it offers. Kept while disconnected. */
  hello: Hello | undefined
  #options: LinkOptions
  #transport: Transport | undefined
  #stopped = false
  #delay = 500

  constructor(options: LinkOptions) {
    this.id = options.id
    this.label = options.label
    this.#options = options
  }

  entry(): MachineEntry {
    return {
      id: this.id, label: this.label, state: this.state,
      ...(this.error ? { error: this.error.message, errorKind: this.error.kind } : {}),
      ...(this.hello ? { machine: { id: this.hello.machine.id, hostname: this.hello.machine.hostname }, features: this.hello.features } : {}),
    }
  }

  has(feature: string) { return this.hello?.features.includes(feature) ?? false }

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

  #set(state: ConnectionState, error?: { kind: string; message: string }) {
    if (this.#stopped) return
    this.state = state
    this.error = error
    this.#options.onEvent('$connection', this.entry())
  }

  async #loop() {
    while (!this.#stopped) {
      this.#set('connecting')
      let final = false
      try {
        const transport = await this.#options.open()
        this.#transport = transport
        transport.peer.onAny((method, params) => {
          // What it offers changed since hello (an extension set up, torn down, switched off): `has` follows.
          if (method === 'features.changed' && this.hello) {
            this.hello = { ...this.hello, features: (params as { features: string[] }).features }
            this.#set(this.state)
          }
          this.#options.onEvent(method, params)
        })
        const hello = await transport.peer.call<Hello>('hello', { client: 'superego-app', version: PROTOCOL_VERSION, features: [...FEATURES] })
        this.#options.verify?.(hello)
        this.hello = hello
        this.#delay = 500
        this.#set('connected')
        await transport.closed
        this.#transport = undefined
        this.#set('disconnected', { kind: 'closed', message: 'Connection lost' })
      } catch (error) {
        this.#transport?.close()
        this.#transport = undefined
        const kind = error instanceof RpcError ? error.kind : 'error'
        final = FINAL.has(kind)
        this.#set('disconnected', { kind, message: error instanceof Error ? error.message : String(error) })
      }
      if (this.#stopped || final) return
      await new Promise((resolve) => setTimeout(resolve, this.#delay))
      this.#delay = Math.min(this.#delay * 2, 30_000)
    }
  }
}
