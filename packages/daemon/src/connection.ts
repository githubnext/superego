// What a connection holds besides its subscriptions: a heartbeat, and the files uploaded on it. A client that pings
// (the app's links do, every few seconds) is expected to keep pinging: once it falls silent the daemon hangs up, so a
// peer behind a dead link doesn't keep its watches. One that never pings (the CLI, a script) is never hung up on.
// Uploads come on channels (see @superego/protocol's channels.ts), are held in memory for this connection only, and are
// put back into a message's attachments as inline data when one names them; anything left goes when the connection does.
// A `forward` channel is a TCP connection to a port on this machine's loopback (a window's Browser pane showing a dev server here).
import { connect } from 'node:net'
import { attachmentsIn, Channels, FORWARD, isLoopback, pipeForward, PROTOCOL_VERSION, RpcError, withAttachments, type AppConfig, type AttachmentRef, type RpcPeer } from '@superego/protocol'

/**
 * A client of another protocol generation, refused in words that say which side to update. Generations change only for
 * breaks no feature can bridge; anything else is a feature in hello.
 */
export function versionMismatch(app: AppConfig, hostname: string, version: unknown) {
  const newer = typeof version === 'number' && version > PROTOCOL_VERSION
  return new RpcError('version_mismatch', `${hostname} runs ${app.name} protocol generation ${PROTOCOL_VERSION}, and this client speaks generation ${String(version)}.`, {
    hint: newer ? `Update ${app.name} on ${hostname}.` : `Update ${app.name} on this computer.`,
  })
}

/** How large one upload may be: what one attachment may weigh, which a message is held to too. */
export const UPLOAD_LIMIT = 20 * 1024 * 1024
/** How much one connection may hold in uploads not yet used. */
const HELD_LIMIT = 4 * UPLOAD_LIMIT
/** How long an unused upload is kept. */
const KEEP = 10 * 60_000

export type ConnectionOptions = {
  /** Close the transport. Without it, a silent peer is left for the transport to notice. */
  hangUp?: () => void
  /** How long a peer that pings may be silent, in ms. */
  silence?: number
}

export function serveConnection(peer: RpcPeer, { hangUp, silence = 30_000 }: ConnectionOptions = {}) {
  const uploads = new Map<string, { name: string; mimeType: string; bytes: Buffer; timer: ReturnType<typeof setTimeout> }>()
  let held = 0
  const drop = (id: string) => {
    const upload = uploads.get(id)
    if (!upload) return
    clearTimeout(upload.timer)
    held -= upload.bytes.length
    uploads.delete(id)
  }

  Channels.of(peer).accept('upload', (channel, { name, mimeType, size }: { name?: unknown; mimeType?: unknown; size?: unknown }) => {
    if (typeof name !== 'string' || !name || typeof mimeType !== 'string' || typeof size !== 'number' || size < 0) throw new RpcError('invalid', 'An upload needs a name, a type and a size')
    // The channel's id names the upload: one still held can't be named again (an open one Channels refuses already).
    if (uploads.has(channel.id)) throw new RpcError('invalid', `Upload ${channel.id} is already held on this connection`)
    if (size > UPLOAD_LIMIT) throw new RpcError('too_large', `${name} is larger than ${UPLOAD_LIMIT / 1024 / 1024} MB`)
    if (held + size > HELD_LIMIT) throw new RpcError('too_large', 'Too much uploaded and not yet sent')
    held += size
    const chunks: Uint8Array[] = []
    let received = 0
    channel.onData((bytes) => {
      received += bytes.length
      if (received > size) throw new RpcError('too_large', `${name} is larger than it said`)
      chunks.push(bytes)
    })
    channel.ended.then(() => {
      const bytes = Buffer.concat(chunks)
      if (bytes.length !== size) { held -= size; return channel.abort(`${name} ended short of its size`) }
      uploads.set(channel.id, { name, mimeType, bytes, timer: setTimeout(() => drop(channel.id), KEEP) })
      channel.end()
    }, () => { held -= size })
  })

  Channels.of(peer).accept(FORWARD, async (channel, { port, host = 'localhost' }: { port?: unknown; host?: unknown }) => {
    if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) throw new RpcError('invalid', 'A forward needs a port')
    if (typeof host !== 'string' || !isLoopback(host)) throw new RpcError('invalid', 'A forward reaches this machine\'s loopback only')
    // `localhost` tries each of its addresses (::1, 127.0.0.1): a dev server may listen on either.
    const socket = connect({ host, port, allowHalfOpen: true, autoSelectFamily: true })
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve)
      socket.once('error', (error) => reject(new RpcError('refused', `Nothing answers at ${host}:${port} here (${error.message})`)))
    })
    pipeForward(channel, socket)
  })

  let pinged = false
  let watchdog: ReturnType<typeof setInterval> | undefined
  const handlers = {
    ping: () => {
      if (!pinged && hangUp) {
        pinged = true
        watchdog = setInterval(() => { if (Date.now() - peer.lastReceived > silence) hangUp() }, Math.min(silence / 3, 10_000))
        watchdog.unref?.()
      }
      return null
    },
  }

  return {
    handlers,
    /** A call's params with the uploads its attachments name put back as inline data; each upload is used up. */
    resolve(method: string, params: unknown): unknown {
      const attachments = attachmentsIn(method, params)
      if (!attachments?.some((a) => 'upload' in a)) return params
      const resolved = attachments.map((attachment): AttachmentRef => {
        if (!('upload' in attachment)) return attachment
        const upload = uploads.get(attachment.upload)
        if (!upload) throw new RpcError('not_found', `No upload ${attachment.upload} on this connection`)
        return { name: attachment.name, mimeType: attachment.mimeType, data: upload.bytes.toString('base64') }
      })
      for (const attachment of attachments) if ('upload' in attachment) drop(attachment.upload)
      return withAttachments(method, params, resolved)
    },
    close() {
      clearInterval(watchdog)
      for (const id of [...uploads.keys()]) drop(id)
    },
  }
}
