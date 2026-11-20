import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { RpcError, RpcPeer } from '@superego/protocol'
import type { Transport } from '@superego/client'
import { Link } from '@superego/client'
import { openVia } from '../src/transports.ts'

const states = (open: () => Promise<Transport>) => {
  const seen: string[] = []
  const link = new Link({ id: 'box', label: 'Box', open, onEvent: (method, params) => { if (method === '$connection') seen.push((params as { state: string }).state) } })
  return { link, seen }
}

describe('a link whose ssh needs a login', () => {
  it('is in the needs-login state, not an error, and stops trying until asked', async () => {
    let opens = 0
    const { link, seen } = states(async () => {
      opens++
      throw new RpcError('needs_login', 'ssh needs you to log in')
    })
    link.start()
    await new Promise((resolve) => setTimeout(resolve, 1500))
    link.stop()
    expect(opens).toBe(1)
    expect(link.state).toBe('needs-login')
    expect(link.entry()).toMatchObject({ state: 'needs-login', errorKind: 'needs_login', error: 'ssh needs you to log in' })
    expect(seen).toEqual(['connecting', 'needs-login'])
  })

  it('gives a host key problem a state of its own, with ssh\'s message', async () => {
    let opens = 0
    const { link } = states(async () => { opens++; throw new RpcError('host_key_changed', 'The host key changed') })
    link.start()
    await new Promise((resolve) => setTimeout(resolve, 1200))
    link.stop()
    expect(opens).toBe(1)
    expect(link.entry()).toMatchObject({ state: 'host-key', error: 'The host key changed', errorKind: 'host_key_changed' })
  })

  it('still retries an unreachable machine', async () => {
    let opens = 0
    const { link } = states(async () => { opens++; throw new RpcError('unreachable', 'no route') })
    link.start()
    await vi.waitFor(() => expect(opens).toBeGreaterThan(1), { timeout: 5_000 })
    link.stop()
  })

  it('carries what hello says about the daemon surviving a logout', async () => {
    const peer = new RpcPeer(() => {})
    const transport: Transport = { peer, closed: new Promise(() => {}), close: () => {} }
    peer.call = (async () => ({ version: 2, features: [], methods: [], extensions: [], api: '2.1.0', client: 'c1', machine: { id: 'm', hostname: 'h', platform: 'linux', pid: 1, dataDir: '/', build: 'b', keepsRunning: { service: null, afterLogout: false } } })) as typeof peer.call
    const { link } = states(async () => transport)
    link.start()
    await vi.waitFor(() => expect(link.state).toBe('connected'))
    link.stop()
    expect(link.entry()).toMatchObject({ state: 'connected', keepsRunning: { service: null, afterLogout: false } })
  })
})

describe('a link whose transport opens but never answers', () => {
  it('gives up on hello after a while, closes the transport and tries again', async () => {
    let opens = 0
    let closes = 0
    const seen: { state: string; errorKind?: string }[] = []
    const link = new Link({
      id: 'box', label: 'Box', helloTimeout: 100,
      open: async () => { opens++; return { peer: new RpcPeer(() => true), closed: new Promise(() => {}), close: () => { closes++ } } },
      onEvent: (method, params) => { if (method === '$connection') seen.push(params as { state: string; errorKind?: string }) },
    })
    link.start()
    await vi.waitFor(() => expect(opens).toBeGreaterThan(1), { timeout: 5_000 })
    link.stop()
    expect(closes).toBeGreaterThanOrEqual(opens - 1)
    expect(seen[1]).toMatchObject({ state: 'disconnected', errorKind: 'timeout' })
  })
})

describe('a link to a command that takes the connection and never answers', () => {
  it('shows connecting, then the timeout, tries again, and leaves none of its processes behind', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'superego-mute-'))
    const pids = join(dir, 'pids')
    const seen: { state: string; errorKind?: string }[] = []
    // A shell, and a child of its own holding the pipes: closing must take both.
    const link = new Link({
      id: 'box', label: 'Box', helloTimeout: 200,
      open: () => openVia(`echo $$ >> '${pids}'; sleep 300 & echo $! >> '${pids}'; wait`),
      onEvent: (method, params) => { if (method === '$connection') seen.push(params as { state: string; errorKind?: string }) },
    })
    link.start()
    // Tried again, and that second shell and its child started too.
    // No file yet until the first shell has written to it.
    const started = () => { try { return readFileSync(pids, 'utf8').trim().split('\n').map(Number) } catch { return [] } }
    await vi.waitFor(() => { expect(seen.length).toBeGreaterThanOrEqual(3); expect(started().length).toBeGreaterThanOrEqual(4) }, { timeout: 5_000 })
    link.stop()
    expect(seen.slice(0, 3)).toMatchObject([{ state: 'connecting' }, { state: 'disconnected', errorKind: 'timeout' }, { state: 'connecting' }])
    const alive = () => started().filter((pid) => { try { process.kill(pid, 0); return true } catch { return false } })
    await vi.waitFor(() => expect(alive()).toEqual([]), { timeout: 5_000 })
    rmSync(dir, { recursive: true, force: true })
  })
})
