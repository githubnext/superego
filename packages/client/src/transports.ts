// Transports to a daemon. Locally, its unix socket. Elsewhere, `ssh -T <target> <command>`, where the command
// (`<id> connect --start` by default) splices stdio to that machine's daemon, or any command doing the same (`via`).
// ssh does all authentication; transports parse nothing but lines.
import { spawn } from 'node:child_process'
import { connectSocket, isListening } from '@mu/daemon/client'
import { lineSplitter, RpcError, RpcPeer } from '@mu/protocol'
import { remoteCommand, type AppConfig } from '@mu/protocol'
import type { MachineConfig } from './shared.ts'

export type Transport = { peer: RpcPeer; closed: Promise<void>; close(): void }

/**
 * The daemon on this computer, at `socket`. `start` launches one when nothing answers; how depends on the client (the
 * app runs Electron as Node, the CLI runs Node), so it is the caller's.
 */
export async function openLocal(socket: string, start?: () => void): Promise<Transport> {
  if (start && !(await isListening(socket))) {
    start()
    for (let i = 0; i < 100 && !(await isListening(socket)); i++) await new Promise((resolve) => setTimeout(resolve, 100))
  }
  const { peer, socket: conn } = await connectSocket(socket)
  return { peer, closed: new Promise((resolve) => conn.once('close', () => resolve())), close: () => conn.destroy() }
}

/** A configured machine, by its route. */
export const openMachine = (config: MachineConfig, app: AppConfig) =>
  config.via ? openVia(config.via) : openSsh(config.target, config.command ?? remoteCommand(app))

export function openSsh(target: string, command: string): Promise<Transport> {
  // BatchMode: never prompt (there is no terminal); keys or an agent must do. Keepalives notice a dead network.
  return openStdio('ssh', ['-T', '-o', 'BatchMode=yes', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3', target, command])
}

/** A machine behind any shell command that pipes stdin and stdout to a daemon. */
export function openVia(command: string): Promise<Transport> {
  return openStdio('/bin/sh', ['-c', command])
}

function openStdio(program: string, args: string[]): Promise<Transport> {
  const name = program === 'ssh' ? 'ssh' : 'via'
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { stdio: ['pipe', 'pipe', 'pipe'] })
    let stderr = ''
    const peer = new RpcPeer((line) => { if (child.stdin.writable) child.stdin.write(line) })
    child.stdout.setEncoding('utf8')
    // Login banners and other noise are not JSON-RPC; the peer skips lines it can't parse.
    child.stdout.on('data', lineSplitter((line) => peer.receive(line)))
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-2000) })
    child.stdin.on('error', () => {})
    const closed = new Promise<void>((done) => child.once('close', (code) => {
      const why = stderr.trim().split('\n').filter(Boolean).at(-1)
      peer.close(new RpcError(name, why ? (why.startsWith(`${name}:`) ? why : `${name}: ${why}`) : `${name} exited with ${code}`))
      done()
    }))
    child.once('error', (error) => reject(new RpcError(name, `Could not run ${program}: ${error.message}`)))
    child.once('spawn', () => resolve({ peer, closed, close: () => child.kill() }))
  })
}
