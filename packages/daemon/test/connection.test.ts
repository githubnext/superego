import { mkdtemp, rm } from 'node:fs/promises'
import { createConnection, createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { Channels, FORWARD, lineSplitter, RpcPeer } from '@superego/protocol'
import { serveConnection } from '../src/connection.ts'

let dir: string
let server: Server
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'superego-connection-')) })
afterEach(async () => { server?.close(); await rm(dir, { recursive: true, force: true }) })

/** A server whose connections hang up after `silence` once they have pinged; and a client to it. */
async function connect(silence: number) {
  const path = join(dir, 'sock')
  server = createServer((socket) => {
    socket.setEncoding('utf8')
    const peer = new RpcPeer((line) => socket.destroyed || socket.write(line))
    const connection = serveConnection(peer, { hangUp: () => socket.destroy(), silence })
    for (const [method, handler] of Object.entries(connection.handlers)) peer.handle(method, handler)
    socket.on('data', lineSplitter((line) => peer.receive(line)))
    socket.on('drain', () => peer.drain())
    socket.on('close', () => { peer.close(); connection.close() })
  })
  await new Promise<void>((resolve) => server.listen(path, resolve))
  const socket: Socket = createConnection(path)
  socket.setEncoding('utf8')
  const peer = new RpcPeer((line) => socket.destroyed || socket.write(line))
  socket.on('data', lineSplitter((line) => peer.receive(line)))
  socket.on('drain', () => peer.drain())
  const closed = new Promise<boolean>((resolve) => socket.on('close', () => resolve(true)))
  return { peer, socket, closed }
}

const within = <T>(promise: Promise<T>, ms: number) => Promise.race([promise, new Promise<false>((resolve) => setTimeout(() => resolve(false), ms))])

it('hangs up on a peer that pinged and then fell silent', async () => {
  const { peer, closed } = await connect(300)
  await peer.call('ping', {})
  expect(await within(closed, 1500)).toBe(true)
})

it('keeps a peer that keeps pinging, and one that never pings', async () => {
  const pinging = await connect(300)
  await pinging.peer.call('ping', {})
  const timer = setInterval(() => void pinging.peer.call('ping', {}).catch(() => {}), 80)
  expect(await within(pinging.closed, 800)).toBe(false)
  clearInterval(timer)
  pinging.socket.destroy()
  server.close()

  const quiet = await connect(300)
  expect(await within(quiet.closed, 800)).toBe(false)
  quiet.socket.destroy()
})

it('refuses an upload id still held, so a reused id cannot upset the accounting', async () => {
  const { peer, socket } = await connect(10_000)
  const upload = async (data: string) => {
    await peer.call('ch.open', { ch: 'same', kind: 'upload', params: { name: 'a.txt', mimeType: 'text/plain', size: data.length }, window: 1 << 20 })
    peer.notify('ch.data', { ch: 'same', data: Buffer.from(data).toString('base64') })
    peer.notify('ch.end', { ch: 'same' })
  }
  const ended = new Promise<void>((resolve) => peer.on('ch.end', () => resolve()))
  await upload('first')
  await ended
  await expect(upload('other')).rejects.toMatchObject({ kind: 'invalid' })
  socket.destroy()
})

it('forwards a channel to a port on its loopback, both ways and each half-close, and refuses anything else', async () => {
  const { peer, socket } = await connect(10_000)
  // An echo server that answers once the client has ended its half, as an HTTP/1.0 server might.
  const echo = createServer({ allowHalfOpen: true }, (conn) => {
    const got: Buffer[] = []
    conn.on('data', (b) => got.push(b))
    conn.on('end', () => conn.end(Buffer.concat(got).toString().toUpperCase()))
  })
  await new Promise<void>((resolve) => echo.listen(0, '127.0.0.1', resolve))
  const port = (echo.address() as { port: number }).port
  try {
    const channel = await Channels.of(peer).open(FORWARD, { port })
    const got: Uint8Array[] = []
    channel.onData((bytes) => { got.push(bytes) })
    await channel.write(new TextEncoder().encode('hello '))
    await channel.write(new Uint8Array(200_000).fill(97))
    channel.end()
    await channel.ended
    const text = Buffer.concat(got).toString()
    expect(text.slice(0, 6)).toBe('HELLO ')
    expect(text.length).toBe(200_006)

    await expect(Channels.of(peer).open(FORWARD, { port, host: 'example.com' })).rejects.toThrow(/loopback only/)
    echo.close()
    await expect(Channels.of(peer).open(FORWARD, { port })).rejects.toThrow(/Nothing answers/)
  } finally {
    echo.close()
    socket.destroy()
  }
})
