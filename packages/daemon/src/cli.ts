#!/usr/bin/env node
// mu's command line. `mu daemon` runs the daemon; `mu connect` bridges stdio to it, which is how a remote machine is
// reached (`ssh host mu connect`); the rest are small conveniences over the protocol.
import { spawn } from 'node:child_process'
import { createConnection } from 'node:net'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { PROTOCOL_VERSION, type MethodName, type Params, type Result } from '@mu/protocol'
import { serveDaemon } from './serve.ts'
import { defaultDataDir, socketPath } from './paths.ts'
import { connectSocket, isListening } from './server.ts'

const [command = 'help', ...args] = process.argv.slice(2)
const dataDir = defaultDataDir()
const socket = socketPath(dataDir)

async function runDaemon() {
  await serveDaemon({ dataDir, socket, defaultCwd: process.env.MU_CWD })
}

/** Start a daemon in the background unless one answers, and wait until it does. */
async function ensureDaemon() {
  if (await isListening(socket)) return
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'daemon'], { detached: true, stdio: 'ignore', env: process.env })
  child.unref()
  for (let i = 0; i < 100; i++) {
    if (await isListening(socket)) return
    await sleep(100)
  }
  throw new Error('The daemon did not start')
}

/** Splice stdio to the daemon's socket without parsing anything: the transport stays dumb, ssh does auth. */
async function bridge() {
  if (args.includes('--start')) await ensureDaemon()
  const conn = createConnection(socket)
  conn.on('error', (error) => { console.error(`mu connect: ${error.message}`); process.exit(1) })
  process.stdin.pipe(conn)
  conn.pipe(process.stdout)
  conn.on('close', () => process.exit(0))
}

async function call<M extends MethodName>(method: M, params: Params<M>): Promise<Result<M>> {
  await ensureDaemon()
  const { peer, socket: conn } = await connectSocket(socket)
  await peer.call('hello', { client: 'mu-cli', version: PROTOCOL_VERSION })
  const result = await peer.call<Result<M>>(method, params)
  conn.end()
  return result
}

const commands: Record<string, () => Promise<unknown>> = {
  daemon: runDaemon,
  connect: bridge,
  ls: async () => {
    for (const s of await call('session.list', {})) console.log(`${s.id}\t${s.status.state}\t${s.title}\t${s.cwd}`)
  },
  new: async () => console.log((await call('session.create', { cwd: args[0] ?? process.cwd() })).id),
  send: async () => console.log(await call('session.submit', { id: args[0]!, text: args.slice(1).join(' ') })),
  help: async () => console.log('usage: mu daemon | connect [--start] | ls | new [cwd] | send <id> <text>'),
}

const run = commands[command] ?? commands.help!
run().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exit(1) })
