// The running app's own socket, beside the daemon's: where the command line reaches the app itself (`<id> app profile`),
// for the app's actions exposed to it (`expose: ['cli']`), run for no window. Only this user can reach it, as the
// daemon's socket.
import { chmod, mkdir, rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:net'
import { dirname } from 'node:path'
import { lineSplitter, RpcPeer, type Router } from '@superego/protocol'
import type { AppActionContext } from './app-endpoint.ts'

export type AppSocket = { close(): void }

export async function serveAppSocket(path: string, router: Router<AppActionContext>): Promise<AppSocket> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  // One app per data dir (the single-instance lock), so what's there is a socket left by one that didn't close.
  await rm(path, { force: true })
  const server: Server = createServer((socket) => {
    socket.setEncoding('utf8')
    const peer = new RpcPeer((line) => socket.destroyed || socket.write(line))
    peer.handle('action.list', () => router.list('cli'))
    peer.handleOthers((method) => router.has(method) ? (params) => router.dispatch(method, params, {}, { source: 'cli', exposure: 'cli' }) : undefined)
    socket.on('drain', () => peer.drain())
    socket.on('data', lineSplitter((line) => peer.receive(line)))
    // A client gone mid-answer: its connection closes next, which is all there is to do.
    socket.on('error', () => {})
    socket.on('close', () => peer.close())
  })
  await new Promise<void>((resolve, reject) => server.once('error', reject).listen(path, resolve))
  server.on('error', (error) => console.error('app socket:', error))
  await chmod(path, 0o600)
  return {
    close() {
      server.close()
      void rm(path, { force: true }).catch((error) => console.error('app socket:', error))
    },
  }
}
