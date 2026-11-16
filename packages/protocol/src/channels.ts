// Channels: byte streams carried on a peer's JSON-RPC lines, so bulk data (an attachment now, a terminal later) can't
// stall a keystroke. Each is opened by a call, carries base64 chunks as notifications, and sends only within the credit
// the receiver grants: a window to start, topped up by acks as the receiver takes each chunk. Chunks are bulk data in the
// peer's writer (see rpc.ts); opens, acks and aborts are control and go first.
//
//   ch.open  {ch, kind, params, window} → {window}    either side opens; the other accepts by kind
//   ch.data  {ch, data}                                base64, at most a chunk, within credit
//   ch.end   {ch}                                      no more data from this side (after its data)
//   ch.ack   {ch, bytes}                               the receiver took `bytes`: that much more credit
//   ch.abort {ch, message}                             either side gives up; both forget the channel
import { RpcError, type RpcPeer } from './rpc.ts'

/** How much one data message carries, at most. */
export const CHUNK = 64 * 1024
/** How much a receiver lets a sender have in flight, unacknowledged. */
export const WINDOW = 512 * 1024

type ChannelOpen = { ch: string; kind: string; params?: unknown; window: number }

/** Accepts a channel the other side opened; throw to refuse it. Set `onData` before returning to read what comes. */
export type ChannelAcceptor = (channel: Channel, params: any) => void | Promise<void>

/** One byte stream on a peer: write to it and end it, read what the other side sends, or give up. */
export interface Channel {
  readonly id: string
  readonly kind: string
  /** Settles when the other side has ended its half (resolves) or either side aborted (rejects). */
  readonly ended: Promise<void>
  /** Queue `bytes`; resolves once all of it is handed to the transport, so a writer that awaits keeps pace. */
  write(bytes: Uint8Array): Promise<void>
  /** No more data from this side, after what is queued. */
  end(): void
  /** Give up: drop what is queued and tell the other side. */
  abort(message?: string): void
  /** Read what the other side sends. Each chunk is acknowledged once `handler` is done with it (its promise settles). */
  onData(handler: (bytes: Uint8Array) => void | Promise<void>): void
}

/** A channel as its peer's `Channels` drives it: the credit, acks and ends behind `Channel`. */
class PeerChannel implements Channel {
  readonly id: string
  readonly kind: string
  #channels: Channels
  #credit: number
  #chunk: number
  #queue: { bytes?: Uint8Array; sent?: () => void; failed?: (error: Error) => void }[] = []
  #endQueued = false
  #endSent = false
  #endReceived = false
  #aborted: Error | undefined
  #window: number
  #received = 0
  #acked = 0
  #reading: Promise<void> = Promise.resolve()
  #onData: ((bytes: Uint8Array) => void | Promise<void>) | undefined
  #waiting: Uint8Array[] = []
  #removeSource: () => void
  #settle!: { resolve(): void; reject(error: Error): void }
  /** Settles when the other side has ended its half (resolves) or either side aborted (rejects). */
  readonly ended: Promise<void>

  constructor(channels: Channels, id: string, kind: string, credit: number, window: number) {
    this.#channels = channels
    this.id = id
    this.kind = kind
    this.#credit = credit
    this.#chunk = Math.max(1, Math.min(CHUNK, credit))
    this.#window = window
    this.ended = new Promise((resolve, reject) => { this.#settle = { resolve, reject } })
    this.ended.catch(() => {})
    this.#removeSource = channels.peer.addSource({ next: () => this.#next() })
  }

  /** Queue `bytes`; resolves once all of it is handed to the transport, so a writer that awaits keeps pace. */
  write(bytes: Uint8Array): Promise<void> {
    if (this.#aborted) return Promise.reject(this.#aborted)
    if (this.#endQueued) return Promise.reject(new RpcError('ended', 'Channel already ended'))
    if (!bytes.length) return Promise.resolve()
    return new Promise((resolve, reject) => {
      for (let at = 0; at < bytes.length; at += this.#chunk) {
        const last = at + this.#chunk >= bytes.length
        this.#queue.push({ bytes: bytes.subarray(at, at + this.#chunk), ...(last ? { sent: resolve, failed: reject } : {}) })
      }
      this.#channels.peer.pump()
    })
  }

  /** No more data from this side, after what is queued. */
  end(): void {
    if (this.#endQueued || this.#aborted) return
    this.#endQueued = true
    this.#queue.push({})
    this.#channels.peer.pump()
  }

  /** Give up: drop what is queued and tell the other side. */
  abort(message = 'Aborted'): void {
    if (this.#aborted) return
    this.#channels.peer.notify('ch.abort', { ch: this.id, message })
    this.fail(new RpcError('aborted', message))
  }

  /** Read what the other side sends. Each chunk is acknowledged once `handler` is done with it (its promise settles). */
  onData(handler: (bytes: Uint8Array) => void | Promise<void>): void {
    this.#onData = handler
    for (const bytes of this.#waiting.splice(0)) this.#deliver(bytes)
  }

  receive(bytes: Uint8Array) {
    if (this.#aborted || this.#endReceived) return
    this.#received += bytes.length
    if (this.#received - this.#acked > this.#window) return this.abort('Sent past its credit')
    if (this.#onData) this.#deliver(bytes)
    else this.#waiting.push(bytes)
  }

  #deliver(bytes: Uint8Array) {
    const handler = this.#onData!
    this.#reading = this.#reading.then(async () => {
      if (this.#aborted) return
      try { await handler(bytes) } catch (error) { return this.abort(error instanceof Error ? error.message : String(error)) }
      this.#acked += bytes.length
      if (!this.#aborted) this.#channels.peer.notify('ch.ack', { ch: this.id, bytes: bytes.length })
    })
  }

  /** The other side accepted, granting its window. */
  opened(window: number) {
    this.#chunk = Math.max(1, Math.min(CHUNK, window))
    this.grant(window)
  }

  grant(bytes: number) {
    this.#credit += bytes
    this.#channels.peer.pump()
  }

  /** The other side ended its half; settles once every chunk before it was read. */
  endReceived() {
    if (this.#endReceived || this.#aborted) return
    this.#endReceived = true
    void this.#reading.then(() => {
      if (this.#aborted) return
      this.#settle.resolve()
      this.#done()
    })
  }

  fail(error: Error) {
    if (this.#aborted) return
    this.#aborted = error
    for (const item of this.#queue.splice(0)) item.failed?.(error)
    this.#settle.reject(error)
    this.#removeSource()
    this.#channels.forget(this.id)
  }

  #done() {
    if (this.#endSent && this.#endReceived) {
      this.#removeSource()
      this.#channels.forget(this.id)
    }
  }

  #next(): string | undefined {
    const head = this.#queue[0]
    if (!head || this.#aborted) return undefined
    if (!head.bytes) {
      this.#queue.shift()
      this.#endSent = true
      if (this.#endReceived) queueMicrotask(() => this.#done())
      return line('ch.end', { ch: this.id })
    }
    if (head.bytes.length > this.#credit) return undefined
    this.#queue.shift()
    this.#credit -= head.bytes.length
    head.sent?.()
    return line('ch.data', { ch: this.id, data: toBase64(head.bytes) })
  }
}

const line = (method: string, params: unknown) => JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n'

const all = new WeakMap<RpcPeer, Channels>()

/** The channels on one peer. One per peer: get it with `Channels.of(peer)`. */
export class Channels {
  readonly peer: RpcPeer
  #open = new Map<string, PeerChannel>()
  #acceptors = new Map<string, ChannelAcceptor>()
  #prefix = Math.random().toString(36).slice(2, 8)
  #next = 1

  static of(peer: RpcPeer): Channels {
    let channels = all.get(peer)
    if (!channels) all.set(peer, (channels = new Channels(peer)))
    return channels
  }

  private constructor(peer: RpcPeer) {
    this.peer = peer
    peer.handle('ch.open', async ({ ch, kind, params, window }: ChannelOpen) => {
      const accept = this.#acceptors.get(kind)
      if (!accept) throw new RpcError('unknown_channel', `No channel of kind ${kind} here`)
      if (typeof ch !== 'string' || this.#open.has(ch)) throw new RpcError('invalid', 'Bad channel id')
      const channel = new PeerChannel(this, ch, kind, Number(window) || 0, WINDOW)
      this.#open.set(ch, channel)
      try { await accept(channel, params ?? {}) } catch (error) { channel.fail(error as Error); throw error }
      return { window: WINDOW }
    })
    peer.on('ch.data', ({ ch, data }: { ch: string; data: string }) => this.#open.get(ch)?.receive(fromBase64(data)))
    peer.on('ch.ack', ({ ch, bytes }: { ch: string; bytes: number }) => this.#open.get(ch)?.grant(Number(bytes) || 0))
    peer.on('ch.end', ({ ch }: { ch: string }) => this.#open.get(ch)?.endReceived())
    peer.on('ch.abort', ({ ch, message }: { ch: string; message?: string }) => this.#open.get(ch)?.fail(new RpcError('aborted', message ?? 'Aborted')))
    peer.onClose((reason) => { for (const channel of [...this.#open.values()]) channel.fail(reason) })
  }

  /** Accept channels of `kind` the other side opens. */
  accept(kind: string, acceptor: ChannelAcceptor): void {
    this.#acceptors.set(kind, acceptor)
  }

  /** Open a channel of `kind` on the other side; it is refused if that side doesn't accept the kind. */
  async open(kind: string, params?: unknown): Promise<Channel> {
    const ch = `${this.#prefix}${this.#next++}`
    // Known before the answer, so data sent right behind it finds the channel.
    const channel = new PeerChannel(this, ch, kind, 0, WINDOW)
    this.#open.set(ch, channel)
    try {
      const { window } = await this.peer.call<{ window: number }>('ch.open', { ch, kind, params, window: WINDOW } satisfies ChannelOpen)
      channel.opened(Number(window) || 0)
    } catch (error) {
      channel.fail(error as Error)
      throw error
    }
    return channel
  }

  /** @internal */
  forget(id: string) {
    this.#open.delete(id)
  }
}

export function toBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64')
  let text = ''
  for (let at = 0; at < bytes.length; at += 0x8000) text += String.fromCharCode(...bytes.subarray(at, at + 0x8000))
  return btoa(text)
}

export function fromBase64(data: string): Uint8Array {
  if (typeof Buffer !== 'undefined') return Buffer.from(data, 'base64')
  const text = atob(data)
  const bytes = new Uint8Array(text.length)
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i)
  return bytes
}
