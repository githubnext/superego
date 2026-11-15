// Transports to a daemon. Locally, its unix socket. Elsewhere, `ssh -T <target> <command>`, where the command
// (`<id> connect --start` by default) splices stdio to that machine's daemon, or any command doing the same (`via`).
// ssh does all authentication; transports parse nothing but lines.
import { spawn } from 'node:child_process'
import { connectSocket, isListening } from '@superego/daemon/client'
import { lineSplitter, RpcError, RpcPeer } from '@superego/protocol'
import type { Transport } from './link.ts'
import { remoteCommand, type AppConfig } from '@superego/protocol'
import { classifySsh, controlPath, linkArgs } from './ssh.ts'
import type { MachineConfig } from './shared.ts'

export type { Transport } from './link.ts'

/**
 * The daemon on this computer, at `socket`. `start` launches one when nothing answers (how depends on the client: the
 * app runs Electron as Node, the CLI runs Node, so it is the caller's), and says whether it's still on its way: it's
 * waited for until it listens or isn't coming.
 */
export async function openLocal(socket: string, start?: () => () => boolean): Promise<Transport> {
  if (start && !(await isListening(socket))) {
    const coming = start()
    while (!(await isListening(socket)) && coming()) await new Promise((resolve) => setTimeout(resolve, 100))
  }
  const { peer, socket: conn } = await connectSocket(socket)
  return { peer, closed: new Promise((resolve) => conn.once('close', () => resolve())), close: () => conn.destroy() }
}

/** A configured machine, by its route. With `dataDir`, ssh rides the shared master there when a login made one. */
export const openMachine = (config: MachineConfig, app: AppConfig, dataDir?: string) =>
  config.via ? openVia(config.via) : openSsh(config.target, config.command ?? remoteCommand(app), dataDir && controlPath(dataDir, config.target))

/** The arguments of `ssh` for a link to `target` running `command`. */
export const sshLinkArgs = (target: string, command: string, control?: string) => ['-T', ...linkArgs(control), '--', target, command]

export function openSsh(target: string, command: string, control?: string): Promise<Transport> {
  return openStdio('ssh', sshLinkArgs(target, command, control))
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
    const peer = new RpcPeer((line) => !child.stdin.writable || child.stdin.write(line))
    child.stdin.on('drain', () => peer.drain())
    child.stdout.setEncoding('utf8')
    // Login banners and other noise are not JSON-RPC; the peer skips lines it can't parse.
    child.stdout.on('data', lineSplitter((line) => peer.receive(line)))
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-2000) })
    child.stdin.on('error', () => {})
    const closed = new Promise<void>((done) => child.once('close', (code) => {
      const why = stderr.trim().split('\n').filter(Boolean).at(-1)
      // ssh's own words for a failed login or host key become kinds a link can act on.
      const known = name === 'ssh' ? classifySsh(stderr, code) : undefined
      if (known) peer.close(new RpcError(known.kind, known.message))
      else peer.close(new RpcError(name, why ? (why.startsWith(`${name}:`) ? why : `${name}: ${why}`) : `${name} exited with ${code}`))
      done()
    }))
    child.once('error', (error) => reject(new RpcError(name, `Could not run ${program}: ${error.message}`)))
    child.once('spawn', () => resolve({ peer, closed, close: () => child.kill() }))
  })
}
