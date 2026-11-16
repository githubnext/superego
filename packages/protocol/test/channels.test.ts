import { mkdtemp, rm } from 'node:fs/promises'
import { createConnection, createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CHUNK, Channels, lineSplitter, RpcPeer, WINDOW } from '../src/index.ts'

// Two peers over a real unix socket, each wired as the daemon's transports are: writes report a full buffer, drains resume.
let dir: string
let server: Server
const sockets: Socket[] = []
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'superego-channels-')) })
afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.destroy()
  server?.close()
  await rm(dir, { recursive: true, force: true })
})

function wire(socket: Socket) {
  sockets.push(socket)
  socket.setEncoding('utf8')
  const peer = new RpcPeer((line) => socket.destroyed || socket.write(line))
  socket.on('drain', () => peer.drain())
  socket.on('data', lineSplitter((line) => peer.receive(line)))
  socket.on('close', () => peer.close())
  return peer
}

async function pair(): Promise<{ a: RpcPeer; b: RpcPeer }> {
  const path = join(dir, 'sock')
  const accepted = new Promise<RpcPeer>((resolve) => { server = createServer((socket) => resolve(wire(socket))) })
  await new Promise<void>((resolve) => server.listen(path, resolve))
  const a = wire(createConnection(path))
  return { a, b: await accepted }
}

const bytes = (size: number) => { const b = new Uint8Array(size); for (let i = 0; i < size; i++) b[i] = i % 251; return b }

describe('channels', () => {
  it('carries bytes in order and ends both halves', async () => {
    const { a, b } = await pair()
    const received: Uint8Array[] = []
    Channels.of(b).accept('echo', (channel, params) => {
      expect(params).toEqual({ name: 'x' })
      channel.onData((chunk) => { received.push(chunk) })
      void channel.ended.then(() => channel.end())
    })
    const channel = await Channels.of(a).open('echo', { name: 'x' })
    const sent = bytes(3 * 1024 * 1024 + 17)
    await channel.write(sent)
    channel.end()
    await channel.ended
    expect(Buffer.concat(received).equals(Buffer.from(sent))).toBe(true)
  })

  it('sends no more than its credit to a reader that does not read', async () => {
    const { a, b } = await pair()
    // What reaches the reader's side, read or not.
    let arrived = 0
    let full!: () => void
    const filled = new Promise<void>((resolve) => { full = resolve })
    const receive = b.receive.bind(b)
    b.receive = (line) => {
      const { method, params } = JSON.parse(line) as { method?: string; params?: { data: string } }
      if (method === 'ch.data') arrived += Buffer.from(params!.data, 'base64').length
      if (arrived >= WINDOW) full()
      receive(line)
    }
    b.handle('ping', () => 'pong')
    let got = 0
    let release!: () => void
    const held = new Promise<void>((resolve) => { release = resolve })
    Channels.of(b).accept('slow', (channel) => { channel.onData(async (chunk) => { got += chunk.length; await held }) })
    const channel = await Channels.of(a).open('slow')
    const done = channel.write(bytes(4 * WINDOW))
    await filled
    // Whatever the sender wrote before this call has arrived once it's answered: the window, and not a byte more.
    expect(await a.call('ping')).toBe('pong')
    expect(arrived).toBe(WINDOW)
    // The first chunk is taken and held; nothing is acknowledged, so the sender stops at the window.
    expect(got).toBe(CHUNK)
    release()
    await done
  })

  it('answers a call while a large upload is in flight', async () => {
    const { a, b } = await pair()
    let got = 0
    let flowing!: () => void
    const inFlight = new Promise<void>((resolve) => { flowing = resolve })
    // A reader slower than the link: a megabyte each 50 ms.
    Channels.of(b).accept('upload', (channel) => {
      channel.onData(async (chunk) => { got += chunk.length; flowing(); await new Promise((resolve) => setTimeout(resolve, chunk.length / (1024 * 1024) * 50)) })
      void channel.ended.then(() => channel.end())
    })
    b.handle('ping', () => 'pong')
    const channel = await Channels.of(a).open('upload')
    const size = 32 * 1024 * 1024
    const upload = channel.write(bytes(size)).then(() => { channel.end(); return channel.ended })
    await inFlight
    const started = Date.now()
    expect(await a.call('ping')).toBe('pong')
    expect(Date.now() - started).toBeLessThan(250)
    expect(got).toBeLessThan(size)
    await upload
    expect(got).toBe(size)
  })

  it('refuses a kind nobody accepts, and fails channels when the connection closes', async () => {
    const { a, b } = await pair()
    Channels.of(b).accept('hold', (channel) => { channel.onData(() => new Promise(() => {})) })
    await expect(Channels.of(a).open('nothing')).rejects.toMatchObject({ kind: 'unknown_channel' })
    const channel = await Channels.of(a).open('hold')
    const write = channel.write(bytes(4 * WINDOW))
    sockets[0]!.destroy()
    await expect(write).rejects.toBeTruthy()
    await expect(channel.ended).rejects.toBeTruthy()
  })

  it('aborts on either side', async () => {
    const { a, b } = await pair()
    Channels.of(b).accept('refuse', (channel) => { channel.onData(() => { throw new Error('No thanks') }) })
    const channel = await Channels.of(a).open('refuse')
    await channel.write(bytes(10))
    await expect(channel.ended).rejects.toMatchObject({ kind: 'aborted', message: 'No thanks' })
  })
})
