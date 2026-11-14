import { chmod, mkdir, rm } from 'node:fs/promises'
import { createConnection, createServer, type Server, type Socket } from 'node:net'
import { dirname } from 'node:path'
import { lineSplitter, RpcPeer } from '@superego/protocol'
import type { Daemon } from './daemon.ts'

/** Whether something answers on `path`. */
export function isListening(path: string) {
  return new Promise<boolean>((resolve) => {
    const socket = createConnection(path)
    socket.once('connect', () => { socket.destroy(); resolve(true) })
    socket.once('error', () => resolve(false))
  })
}

/** Serve `daemon` on a unix socket only this user can reach. SSH is the only way in from elsewhere. */
export async function listen(daemon: Daemon, path: string): Promise<Server> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  if (await isListening(path)) throw new Error(`A daemon is already listening on ${path}`)
  await rm(path, { force: true })
  const server = createServer((socket) => attach(daemon, socket))
  await new Promise<void>((resolve, reject) => server.once('error', reject).listen(path, resolve))
  await chmod(path, 0o600)
  return server
}

function attach(daemon: Daemon, socket: Socket) {
  socket.setEncoding('utf8')
  const peer = new RpcPeer((line) => socket.destroyed || socket.write(line))
  const cleanup = daemon.serve(peer, { hangUp: () => socket.destroy() })
  socket.on('drain', () => peer.drain())
  socket.on('data', lineSplitter((line) => peer.receive(line)))
  socket.on('error', () => {})
  socket.on('close', () => { peer.close(); cleanup() })
}

/** A client peer over the daemon's socket. */
export function connectSocket(path: string): Promise<{ peer: RpcPeer; socket: Socket }> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path)
    socket.once('error', reject)
    socket.once('connect', () => {
      socket.off('error', reject)
      socket.setEncoding('utf8')
      const peer = new RpcPeer((line) => socket.destroyed || socket.write(line))
      socket.on('drain', () => peer.drain())
      socket.on('data', lineSplitter((line) => peer.receive(line)))
      socket.on('error', () => {})
      socket.on('close', () => peer.close())
      resolve({ peer, socket })
    })
  })
}
