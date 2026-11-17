// Forwards: a remote machine's localhost, reached from this computer through the machine's link. Here the "machine" is
// a daemon's connection half (serveConnection) on an in-memory peer, and its "dev server" listens on this computer,
// so its port is taken here: the forward listens at another, and the page loads through it, redirects and cookies too.
import { createServer, type Server } from 'node:http'
import { afterEach, expect, it } from 'vitest'
import { Channels, RpcPeer } from '@superego/protocol'
import { serveConnection } from '@superego/daemon'
import type { Link } from '@superego/client'
import { createForwards, type Forwards } from '../src/main/forwards.ts'
import type { MachineEntry } from '../src/shared/bridge.ts'

let server: Server | undefined
let forwards: Forwards | undefined
afterEach(() => { server?.close(); forwards?.close() })

function machine() {
  let client: RpcPeer
  const daemon: RpcPeer = new RpcPeer((line) => { queueMicrotask(() => client.receive(line)); return true })
  client = new RpcPeer((line) => { queueMicrotask(() => daemon.receive(line)); return true })
  serveConnection(daemon)
  return { state: 'connected', channel: (kind: string, params: unknown) => Channels.of(client).open(kind, params) } as unknown as Link
}

it('loads a remote machine\'s localhost through its link, at another port when its own is taken here', async () => {
  server = createServer((request, response) => {
    if (request.url === '/') return void response.writeHead(302, { location: '/home', 'set-cookie': 'who=me' }).end()
    response.writeHead(200, { 'content-type': 'text/plain' }).end(`home, ${request.headers.cookie ?? 'no cookie'}`)
  })
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  const link = machine()
  const entries: MachineEntry[] = [
    { id: 'local', label: 'This computer', state: 'connected', features: ['forward'] },
    { id: 'box', label: 'workbox', state: 'connected', features: ['forward'], remote: { route: 'ssh box', enabled: true, ssh: true } },
    { id: 'old', label: 'oldbox', state: 'connected', features: [], remote: { route: 'ssh old', enabled: true, ssh: true } },
  ]
  forwards = createForwards({ machines: () => entries, linkOf: (id) => id === 'box' ? link : undefined })

  // This computer's own, and anything not localhost: as they are.
  expect(await forwards.urlFor('local', `http://localhost:${port}/`)).toBe(`http://localhost:${port}/`)
  expect(await forwards.urlFor('box', 'https://example.com/docs')).toBe('https://example.com/docs')
  await expect(forwards.urlFor('old', `http://localhost:${port}/`)).rejects.toThrow(/update it/)

  const url = await forwards.urlFor('box', `http://localhost:${port}/`)
  const here = Number(new URL(url).port)
  expect(here).not.toBe(port)
  expect(await forwards.urlFor('box', `http://localhost:${port}/other`)).toBe(`http://localhost:${here}/other`)
  const first = await fetch(url, { redirect: 'manual' })
  expect(first.status).toBe(302)
  expect(first.headers.get('location')).toBe('/home')
  const page = await fetch(new URL('/home', url), { headers: { cookie: first.headers.get('set-cookie')! } })
  expect(await page.text()).toBe('home, who=me')
  // A big body comes through whole, at the channel's pace.
  server.removeAllListeners('request')
  server.on('request', (_request, response) => response.end('x'.repeat(3_000_000)))
  expect((await (await fetch(url)).text()).length).toBe(3_000_000)
})

it('listens at the machine\'s own port when it\'s free here, so links and redirects to it still work', async () => {
  // A port free here: found by taking one and letting it go.
  const probe = createServer()
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const port = (probe.address() as { port: number }).port
  await new Promise((resolve) => probe.close(resolve))
  const entries: MachineEntry[] = [{ id: 'box', label: 'workbox', state: 'connected', features: ['forward'], remote: { route: 'ssh box', enabled: true, ssh: true } }]
  forwards = createForwards({ machines: () => entries, linkOf: () => undefined })
  expect(await forwards.urlFor('box', `http://localhost:${port}/app?x=1`)).toBe(`http://localhost:${port}/app?x=1`)
  // Not connected: a page asked for gets its connection closed, not left hanging.
  await expect(fetch(`http://127.0.0.1:${port}/`)).rejects.toThrow()
})
