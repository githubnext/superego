// A machine over ssh: `ssh -T <target> <command>`, where the command (`mu connect --start` by default) splices stdio to
// that machine's daemon. ssh does all authentication; the transport parses nothing but lines.
import { spawn } from 'node:child_process'
import { lineSplitter, RpcError, RpcPeer } from '@mu/protocol'
import type { Transport } from './link.ts'

export function openSsh(target: string, command: string): Promise<Transport> {
  return new Promise((resolve, reject) => {
    // BatchMode: never prompt (there is no terminal); keys or an agent must do. Keepalives notice a dead network.
    const child = spawn('ssh', ['-T', '-o', 'BatchMode=yes', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3', target, command], {
      stdio: ['pipe', 'pipe', 'pipe'],
    })
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
      peer.close(new RpcError('ssh', why ? (why.startsWith('ssh:') ? why : `ssh: ${why}`) : `ssh exited with ${code}`))
      done()
    }))
    child.once('error', (error) => reject(new RpcError('ssh', `Could not run ssh: ${error.message}`)))
    child.once('spawn', () => resolve({ peer, closed, close: () => child.kill() }))
  })
}
