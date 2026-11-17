// Forwards: a TCP connection to a port on a machine's own loopback, carried on a channel (channels.ts) of kind
// `forward`, {port, host?}. The app listens on its computer's loopback and opens one per connection, so a page there
// loads from the remote machine's `localhost` (a dev server an agent started there). Only loopback: what the machine
// serves to itself, not a way onto its network.
import type { Channel } from './channels.ts'

/** The channel kind: a daemon that offers the `forward` feature accepts it. */
export const FORWARD = 'forward'

/** The hosts that are a machine's own loopback, as a socket names them (IPv6 without a URL's brackets). */
const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1'])
export const isLoopback = (hostname: string) => LOOPBACK.has(hostname.toLowerCase())

/** The byte stream a forward joins a channel to: a TCP socket, as Node has it. */
export interface ForwardSocket {
  write(bytes: Uint8Array, callback?: (error?: Error | null) => void): boolean
  end(): unknown
  destroy(error?: Error): unknown
  pause(): unknown
  resume(): unknown
  readonly destroyed: boolean
  on(event: 'data', listener: (bytes: Uint8Array) => void): unknown
  on(event: 'end', listener: () => void): unknown
  on(event: 'error', listener: (error: Error) => void): unknown
  on(event: 'close', listener: (hadError: boolean) => void): unknown
  once(event: 'drain', listener: () => void): unknown
  once(event: 'close', listener: (hadError: boolean) => void): unknown
}

/**
 * Join a channel and a socket both ways, each at the other's pace: the socket is paused while the channel sends, and
 * a chunk from the channel is taken once the socket has written it. Each side's end is passed on (the socket must allow
 * half-open); a failure on either aborts the channel and destroys the socket.
 */
export function pipeForward(channel: Channel, socket: ForwardSocket) {
  let failed = false
  const fail = (message: string) => {
    if (failed) return
    failed = true
    channel.abort(message)
    socket.destroy()
  }
  socket.on('data', (bytes) => {
    socket.pause()
    channel.write(bytes).then(() => socket.resume(), (error: Error) => fail(error.message))
  })
  socket.on('end', () => channel.end())
  socket.on('error', (error) => fail(error.message))
  socket.on('close', (hadError) => { if (hadError) fail('The connection failed') })
  channel.onData((bytes) => new Promise<void>((resolve) => {
    if (socket.destroyed) return resolve()
    if (socket.write(bytes)) return resolve()
    const done = () => resolve()
    socket.once('drain', done)
    socket.once('close', done)
  }))
  channel.ended.then(() => socket.end(), (error: Error) => {
    failed = true
    socket.destroy(error)
  })
}
