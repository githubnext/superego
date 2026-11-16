// A link to one machine's daemon. It connects, says hello, relays notifications, and reconnects with backoff when the
// transport drops. While down, calls fail fast and a client keeps showing what it last knew (stale, not gone). It pings
// the daemon, so a dead link is noticed in seconds on any transport, not when ssh gives up.
// No Node imports: the app's main process uses it, and a daemon or a browser can.
import { Channels, offers, PROTOCOL_VERSION, RpcError, versionOf, type Channel, type Hello, type Notifications, type RpcPeer } from '@superego/protocol'
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
  /** What the link calls itself in hello: its kind, and a name for people (the computer it runs on). */
  client?: string
  clientLabel?: string
  /** How often to ping, and how long a silence closes the transport (which reconnects), in ms. */
  heartbeat?: { every: number; timeout: number }
  /** How long hello may take once the transport is open, in ms; past it the transport is closed and tried again. */
  helloTimeout?: number
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
      ...(this.hello ? { machine: { id: this.hello.machine.id, hostname: this.hello.machine.hostname }, features: this.hello.features, extensions: this.hello.extensions, keepsRunning: this.hello.machine.keepsRunning, version: versionOf(this.hello) } : {}),
    }
  }

  /** Whether the daemon offers `feature`: `threads`, `ext:git`, `ext:git@^1.2` (see `offers`). */
  has(feature: string) { return offers(this.hello, feature) }

  get stopped() { return this.#stopped }

  start() {
    void this.#loop()
  }

  /** Call the daemon. Inline attachments go ahead as uploads on their own channels. */
  call(method: string, params: unknown): Promise<unknown> {
    if (!this.#transport || this.state !== 'connected') throw new RpcError('disconnected', `${this.label} is not connected`)
    const peer = this.#transport.peer
    if (carriesFiles(method, params)) return uploadAttachments(peer, method, params).then((sent) => peer.call(method, sent))
    return peer.call(method, params)
  }

  /** Open a channel of `kind` on the daemon (a terminal's, say): it ends with this connection, and isn't opened again. */
  channel(kind: string, params: unknown): Promise<Channel> {
    if (!this.#transport || this.state !== 'connected') throw new RpcError('disconnected', `${this.label} is not connected`)
    return Channels.of(this.#transport.peer).open(kind, params)
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
        transport.peer.onAny((method, params) => {
          // Channels are this connection's own business, not news for the windows.
          if (method.startsWith('ch.')) return
          // What it offers changed since hello (an extension set up, torn down, switched off): `has` follows.
          if (method === 'features.changed' && this.hello) {
            const { features, extensions } = params as Notifications['features.changed']
            this.hello = { ...this.hello, features, extensions }
            this.#set(this.state)
          }
          this.#options.onEvent(method, params)
        })
        // A transport that opened but never answers (a via command that hangs, a daemon wedged) would otherwise stay
        // connecting for good. Long enough for `connect --start` to start a daemon on the far side first.
        const hello = await within(transport.peer.call<Hello>('hello', {
          client: this.#options.client ?? 'superego-app', version: PROTOCOL_VERSION,
          ...(this.#options.clientLabel ? { label: this.#options.clientLabel } : {}),
        }), this.#options.helloTimeout ?? 30_000, () => new RpcError('timeout', `${this.label} did not answer`))
        if (hello.version !== PROTOCOL_VERSION) {
          throw new RpcError('version_mismatch', `${hello.machine.hostname} speaks protocol generation ${hello.version}, this client ${PROTOCOL_VERSION}`, { hint: 'Update the side that is older.' })
        }
        this.#options.verify?.(hello)
        this.hello = hello
        this.#delay = 500
        this.#set('connected')
        let silent = false
        const stopBeat = this.#heartbeat(transport, () => { silent = true })
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

/** `promise`, or `error()` after `ms`. */
function within<T>(promise: Promise<T>, ms: number, error: () => Error): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(error()), ms) })
  return Promise.race([promise, late]).finally(() => clearTimeout(timer))
}
