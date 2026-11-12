import { describe, expect, it } from 'vitest'
import { RpcError, RpcPeer } from '@superego/protocol'
import type { Transport } from '@superego/client'
import { Link } from '../src/main/link.ts'

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
    await new Promise((resolve) => setTimeout(resolve, 1800))
    link.stop()
    expect(opens).toBeGreaterThan(1)
  })

  it('carries what hello says about the daemon surviving a logout', async () => {
    const peer = new RpcPeer(() => {})
    const transport: Transport = { peer, closed: new Promise(() => {}), close: () => {} }
    peer.call = (async () => ({ version: 1, features: ['keeps-running'], methods: [], machine: { id: 'm', hostname: 'h', platform: 'linux', pid: 1, dataDir: '/', build: 'b', keepsRunning: { service: null, afterLogout: false } } })) as typeof peer.call
    const { link } = states(async () => transport)
    link.start()
    await new Promise((resolve) => setTimeout(resolve, 100))
    link.stop()
    expect(link.entry()).toMatchObject({ state: 'connected', keepsRunning: { service: null, afterLogout: false } })
  })
})
