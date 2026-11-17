// Forwards: another machine's `localhost:<port>` (a dev server an agent started there), reached from this computer.
// The app listens on this computer's loopback, at the same port when that's free here (so the page's own absolute
// links and redirects to `localhost:<port>` still work) and on another when it isn't, and carries each connection on
// a `forward` channel over the machine's link (@superego/protocol's forward.ts) to that port on the machine's own
// loopback. A forward stays while the app runs: a reload, or the user's browser here, uses it too. A connection made
// while the machine isn't connected is closed at once.
import { createServer, type Server, type Socket } from 'node:net'
import { FORWARD, isLoopback, pipeForward, RpcError } from '@superego/protocol'
import type { Link } from '@superego/client'
import type { MachineEntry } from '../shared/bridge.ts'

export type Forwards = {
  /** Where `url` (on `machine`) loads from on this computer: a localhost address on another machine, forwarded; anything else, as it is. */
  urlFor(machine: string, url: string): Promise<string>
  close(): void
}

/** How many free ports to try when the machine's own port is taken here. */
const TRIES = 5

export function createForwards({ machines, linkOf }: { machines(): MachineEntry[]; linkOf(machine: string): Link | undefined }): Forwards {
  /** Each forward by `<machine> <host> <port>`: the port it listens at here. */
  const held = new Map<string, { port: Promise<number>; servers: Server[] }>()

  const connection = (machine: string, host: string, port: number) => (socket: Socket) => {
    const link = linkOf(machine)
    if (!link || link.state !== 'connected') return void socket.destroy()
    // Until the channel is open, what the browser sends waits in the socket (nothing reads it yet).
    link.channel(FORWARD, { port, host }).then((channel) => pipeForward(channel, socket), (error: Error) => {
      console.error(`Forward to ${host}:${port} on ${machine}:`, error.message)
      socket.destroy()
    })
  }

  /** Listen at `port` on both loopbacks (`localhost` is either, as the browser resolves it): the port, or why not. */
  async function listen(port: number, accept: (socket: Socket) => void): Promise<{ port: number; servers: Server[] }> {
    const servers: Server[] = []
    const on = (host: string, at: number) => new Promise<number>((resolve, reject) => {
      const server = createServer({ allowHalfOpen: true }, accept)
      server.once('error', reject)
      server.listen(at, host, () => {
        server.off('error', reject)
        server.on('error', (error) => console.error(`Forward at ${host}:${at}:`, error))
        servers.push(server)
        resolve((server.address() as { port: number }).port)
      })
    })
    try {
      const got = await on('127.0.0.1', port)
      // A computer without IPv6 has no ::1 to take; a port taken there is taken.
      await on('::1', got).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'EADDRNOTAVAIL' && error.code !== 'EAFNOSUPPORT') throw error })
      return { port: got, servers }
    } catch (error) {
      for (const server of servers) server.close()
      throw error
    }
  }

  async function forward(machine: string, host: string, port: number) {
    const key = `${machine} ${host} ${port}`
    const existing = held.get(key)
    if (existing) return existing.port
    const servers: Server[] = []
    const opened = (async () => {
      const accept = connection(machine, host, port)
      let last: unknown
      for (let attempt = 0; attempt <= TRIES; attempt++) {
        try {
          const listening = await listen(attempt ? 0 : port, accept)
          servers.push(...listening.servers)
          return listening.port
        } catch (error) {
          // Taken here, or not ours to take (a port below 1024 on Linux): another one.
          const code = (error as NodeJS.ErrnoException).code
          if (code !== 'EADDRINUSE' && code !== 'EACCES') throw error
          last = error
        }
      }
      throw last
    })()
    held.set(key, { port: opened, servers })
    opened.catch(() => held.delete(key))
    return opened
  }

  return {
    async urlFor(machine, url) {
      const entry = machines().find((m) => m.id === machine)
      if (!entry) throw new RpcError('unknown_machine', `No machine ${machine}`)
      const parsed = new URL(url)
      if (!entry.remote || !isLoopback(parsed.hostname)) return url
      if (!entry.features?.includes(FORWARD)) {
        throw new RpcError('unsupported', `Superego on ${entry.label} can't forward its localhost here: update it to show this page.`)
      }
      const port = Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80))
      const here = await forward(machine, parsed.hostname.replace(/^\[|\]$/g, ''), port)
      if (here !== port) parsed.port = String(here)
      return parsed.toString()
    },
    close() {
      for (const { servers } of held.values()) for (const server of servers) server.close()
      held.clear()
    },
  }
}
