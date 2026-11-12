// A link to one machine's daemon. It connects, says hello, relays notifications, and reconnects with backoff when the
// transport drops. While down, calls fail fast and a client keeps showing what it last knew (stale, not gone). It pings
// a daemon that offers `heartbeat`, so a dead link is noticed in seconds on any transport, not when ssh gives up.
// No Node imports: the app's main process uses it, and a daemon or a browser can.
import { FEATURES, PROTOCOL_VERSION, RpcError, type Hello, type RpcPeer } from '@superego/protocol'
import type { ConnectionState, MachineEntry, MachineId } from './shared.ts'
import { carriesFiles, uploadAttachments } from './uploads.ts'

export type Transport = { peer: RpcPeer; closed: Promise<void>; close(): void }

/** Errors that another attempt can't fix: the link waits for the user (or a restart) instead of retrying. */
const FINAL = new Set(['version_mismatch', 'wrong_machine', 'duplicate_machine', 'needs_login', 'host_key_changed', 'host_key_unknown'])

/** Errors that are a state of their own, not a failure. */
const stateOf = (kind: string): ConnectionState => kind === 'needs_login' ? 'needs-login' : kind.startsWith('host_key') ? 'host-key' : 'disconnected'

export type LinkOptions = {
  id: MachineId
  label: string
  open(): Promise<Transport>
  onEvent(method: string, params: unknown): void
  /** Check who answered before the link counts as connected; throw to refuse it. */
  verify?(hello: Hello): void
  /** What the link calls itself in hello. */
  client?: string
  /** How often to ping, and how long a silence closes the transport (which reconnects), in ms. */
  heartbeat?: { every: number; timeout: number }
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
      ...(this.hello?.machine.keepsRunning ? { keepsRunning: this.hello.machine.keepsRunning } : {}),
    }
  }

  has(feature: string) { return this.hello?.features.includes(feature) ?? false }

  get stopped() { return this.#stopped }

  start() {
    void this.#loop()
  }

  /** Call the daemon. Inline attachments go ahead as uploads on their own channels when it takes them. */
  call(method: string, params: unknown): Promise<unknown> {
    if (!this.#transport || this.state !== 'connected') throw new RpcError('disconnected', `${this.label} is not connected`)
    const peer = this.#transport.peer
    if (this.has('uploads') && carriesFiles(method, params)) return uploadAttachments(peer, method, params).then((sent) => peer.call(method, sent))
    return peer.call(method, params)
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

  /** Ping every few seconds; close the transport after a silence, so the loop reconnects. */
  #heartbeat(transport: Transport, onSilence: () => void) {
    const { every, timeout } = this.#options.heartbeat ?? { every: 5_000, timeout: 15_000 }
    const timer = setInterval(() => {
      if (Date.now() - transport.peer.lastReceived > timeout) {
        onSilence()
        transport.close()
        return
      }
      transport.peer.call('ping', {}).catch(() => {})
    }, every)
    ;(timer as { unref?(): void }).unref?.()
    return () => clearInterval(timer)
  }

  async #loop() {
    while (!this.#stopped) {
      this.#set('connecting')
      let final = false
      try {
        const transport = await this.#options.open()
        this.#transport = transport
        // Channels are this connection's own business, not news for the windows.
        transport.peer.onAny((method, params) => { if (!method.startsWith('ch.')) this.#options.onEvent(method, params) })
        const hello = await transport.peer.call<Hello>('hello', { client: this.#options.client ?? 'superego-app', version: PROTOCOL_VERSION, features: [...FEATURES] })
        if (hello.version !== PROTOCOL_VERSION) {
          throw new RpcError('version_mismatch', `${hello.machine.hostname} speaks protocol generation ${hello.version}, this client ${PROTOCOL_VERSION}`, { hint: 'Update the side that is older.' })
        }
        this.#options.verify?.(hello)
        this.hello = hello
        this.#delay = 500
        this.#set('connected')
        let silent = false
        const stopBeat = hello.features.includes('heartbeat') ? this.#heartbeat(transport, () => { silent = true }) : () => {}
        await transport.closed
        stopBeat()
        this.#transport = undefined
        this.#set('disconnected', silent ? { kind: 'timeout', message: 'No answer; reconnecting' } : { kind: 'closed', message: 'Connection lost' })
      } catch (error) {
        this.#transport?.close()
        this.#transport = undefined
        const kind = error instanceof RpcError ? error.kind : 'error'
        final = FINAL.has(kind)
        const message = error instanceof Error ? error.message : String(error)
        const hint = error instanceof RpcError && error.hint ? ` ${error.hint}` : ''
        this.#set(stateOf(kind), { kind, message: message + hint })
      }
      if (this.#stopped || final) return
      await new Promise((resolve) => setTimeout(resolve, this.#delay))
      this.#delay = Math.min(this.#delay * 2, 30_000)
    }
  }
}
