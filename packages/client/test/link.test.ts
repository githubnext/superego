import { readFile, mkdtemp, rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { connectSocket, listen, openDaemon } from '@superego/daemon'
import { defineApp, lineSplitter, PROTOCOL_VERSION, RpcPeer, type Hello, type ThreadInfo } from '@superego/protocol'
import { Link, openLocal, upload, type Transport } from '../src/index.ts'

for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_OAUTH_TOKEN', 'OPENAI_API_KEY']) delete process.env[key]

let dir: string
const cleanups: (() => unknown)[] = []
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'superego-link-')) })
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  await rm(dir, { recursive: true, force: true })
})

const until = async (check: () => boolean | Promise<boolean>, ms = 5000) => {
  const end = Date.now() + ms
  while (!(await check())) {
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

async function daemon() {
  process.env.SUPEREGO_MODEL = 'faux'
  const daemon = await openDaemon({ app: defineApp({ name: 'superego', id: 'superego' }), dataDir: dir, defaultCwd: dir, agentsDir: join(dir, 'agents') })
  const socket = join(dir, 'superego.sock')
  const server = await listen(daemon, socket)
  cleanups.push(async () => { server.close(); await daemon.close() })
  return socket
}

function link(open: () => Promise<Transport>, heartbeat?: { every: number; timeout: number }) {
  const states: { state: string; errorKind?: string }[] = []
  const link = new Link({ id: 'm', label: 'm', open, onEvent: (method, params) => { if (method === '$connection') states.push(params as { state: string }) }, ...(heartbeat ? { heartbeat } : {}) })
  link.start()
  cleanups.push(() => link.stop())
  return { link, states }
}

const base64 = (size: number) => { const b = Buffer.alloc(size); for (let i = 0; i < size; i++) b[i] = 32 + (i % 90); return b }

describe('link', () => {
  it('closes and reconnects when the daemon stops answering pings', async () => {
    // A daemon that answers hello, and pings only while `answering`.
    let answering = true
    let connections = 0
    const path = join(dir, 'fake.sock')
    const server: Server = createServer((socket) => {
      connections++
      socket.setEncoding('utf8')
      const peer = new RpcPeer((line) => socket.destroyed || socket.write(line))
      socket.on('data', lineSplitter((line) => { if (answering || !line.includes('"ping"')) peer.receive(line) }))
      socket.on('error', () => {})
      peer.handle('hello', (): Hello => ({ version: PROTOCOL_VERSION, features: ['heartbeat'], methods: ['hello', 'ping'], machine: { id: 'x', hostname: 'fake', platform: 'test', pid: 1, dataDir: dir, build: 'b' } }))
      peer.handle('ping', () => null)
    })
    await new Promise<void>((resolve) => server.listen(path, resolve))
    cleanups.push(() => server.close())
    const { link: l, states } = link(() => openLocal(path), { every: 50, timeout: 300 })
    await until(() => l.state === 'connected')
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(l.state).toBe('connected')
    answering = false
    await until(() => states.some((s) => s.errorKind === 'timeout'), 2000)
    answering = true
    await until(() => l.state === 'connected' && connections === 2, 3000)
  })

  it('sends large attachments ahead as uploads, and answers calls meanwhile', async () => {
    const socket = await daemon()
    let acks = 0
    const { link: l } = link(async () => { const transport = await openLocal(socket); transport.peer.on('ch.ack', () => acks++); return transport })
    await until(() => l.state === 'connected')
    expect(l.has('uploads')).toBe(true)
    const thread = await l.call('thread.create', { title: 'files' }) as ThreadInfo
    const big = base64(12 * 1024 * 1024)
    const sending = l.call('action.run', { id: 'thread.submit', params: { id: thread.id, text: 'see', attachments: [
      { name: 'big.txt', mimeType: 'text/plain', data: big.toString('base64') },
      { name: 'small.txt', mimeType: 'text/plain', data: Buffer.from('tiny').toString('base64') },
    ] } })
    const started = Date.now()
    await l.call('thread.list', {})
    expect(Date.now() - started).toBeLessThan(500)
    await sending
    expect(acks).toBeGreaterThan(100)
    expect((await readFile(join(dir, 'attachments', thread.id, 'big.txt'))).equals(big)).toBe(true)
    expect(await readFile(join(dir, 'attachments', thread.id, 'small.txt'), 'utf8')).toBe('tiny')
  })
})

describe('uploads', () => {
  it('are named in a message on the same connection, once', async () => {
    const socket = await daemon()
    const { peer, socket: conn } = await connectSocket(socket)
    cleanups.push(() => conn.destroy())
    await peer.call('hello', { client: 'test', version: PROTOCOL_VERSION })
    const thread = await peer.call<ThreadInfo>('thread.create', { title: 'up' })
    const id = await upload(peer, { name: 'notes.md', mimeType: 'text/markdown', bytes: Buffer.from('# Notes') })
    await peer.call('thread.submit', { id: thread.id, text: '', attachments: [{ name: 'notes.md', mimeType: 'text/markdown', upload: id }] })
    expect(await readFile(join(dir, 'attachments', thread.id, 'notes.md'), 'utf8')).toBe('# Notes')
    await expect(peer.call('thread.submit', { id: thread.id, text: 'again', attachments: [{ name: 'notes.md', mimeType: 'text/markdown', upload: id }] }))
      .rejects.toMatchObject({ kind: 'not_found' })
  })

  it('are refused past the size limit', async () => {
    const socket = await daemon()
    const { peer, socket: conn } = await connectSocket(socket)
    cleanups.push(() => conn.destroy())
    await expect(upload(peer, { name: 'huge.bin', mimeType: 'application/octet-stream', bytes: new Uint8Array(21 * 1024 * 1024) })).rejects.toMatchObject({ kind: 'too_large' })
  })
})
