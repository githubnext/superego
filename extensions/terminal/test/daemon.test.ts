// terminal's daemon half against a real daemon, over its socket: a pane's shell started by attaching, typed to, read
// back, resized, attached again with its scrollback, reporting status (OSC 7501), and stopped as its pane closes, its
// thread is archived, or it exits.
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { connectSocket, listen, openDaemon } from '@superego/daemon'
import { Channels, defineApp, PROTOCOL_VERSION, type Hello, type Pane, type RpcPeer, type ThreadInfo } from '@superego/protocol'
import { terminalExtension } from '../src/daemon.ts'
import { IO, RESIZE } from '../src/shared.ts'

const app = defineApp({ name: 'test', id: 'termtest' })
let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'superego-terminal-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

const until = async (check: () => boolean | Promise<boolean>, what = 'it') => {
  for (let i = 0; i < 400; i++) { if (await check()) return; await new Promise((r) => setTimeout(r, 25)) }
  throw new Error(`timed out waiting for ${what}`)
}
const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }

async function open() {
  process.env.TERMTEST_MODEL = 'faux'
  const data = join(dir, 'data')
  await mkdir(data, { recursive: true })
  const extension = terminalExtension({ shell: () => ({ file: '/bin/sh', args: [] }) })
  const daemon = await openDaemon({ app, dataDir: data, defaultCwd: dir, agentsDir: join(dir, 'agents'), extensions: [extension] })
  const server = await listen(daemon, join(data, 's.sock'))
  const sockets: { destroy(): void }[] = []
  const connect = async () => {
    const { peer, socket } = await connectSocket(join(data, 's.sock'))
    sockets.push(socket)
    const hello = await peer.call<Hello>('hello', { client: 'test', version: PROTOCOL_VERSION })
    return { peer, hello }
  }
  const close = async () => { for (const s of sockets) s.destroy(); server.close(); await daemon.close(); delete process.env.TERMTEST_MODEL }
  return { connect, close }
}

/** A window's end of a terminal: what it was replayed, what came after, and typing. */
async function attach(peer: RpcPeer, thread: string, pane: string, size = { cols: 80, rows: 24 }) {
  const channel = await Channels.of(peer).open(IO, { thread, pane, ...size })
  const decoder = new TextDecoder()
  let header = ''
  let replay = -1
  const seen = { replayed: '', live: '' }
  channel.onData((bytes) => {
    let at = 0
    while (replay < 0 && at < bytes.length) {
      const c = bytes[at++]!
      if (c === 0x0a) replay = Number(header)
      else header += String.fromCharCode(c)
    }
    const rest = bytes.subarray(at)
    const back = Math.min(replay, rest.length)
    seen.replayed += decoder.decode(rest.subarray(0, back))
    replay -= back
    seen.live += decoder.decode(rest.subarray(back))
  })
  return {
    seen, channel,
    type: (text: string) => channel.write(new TextEncoder().encode(text)),
    waitFor: (text: string) => until(() => seen.live.includes(text), JSON.stringify(text)),
  }
}

async function terminalPane(peer: RpcPeer, params?: unknown) {
  const thread = await peer.call<ThreadInfo>('thread.create', { cwd: dir })
  const pane = await peer.call<Pane>('pane.open', { id: thread.id, kind: 'terminal', ...(params ? { params } : {}) })
  return { thread: thread.id, pane: pane.id }
}

it('starts a shell in the thread\'s folder as a window attaches, and passes typing and output both ways', async () => {
  const { connect, close } = await open()
  const { peer, hello } = await connect()
  expect(hello.features).toContain('ext:terminal')
  const { thread, pane } = await terminalPane(peer)
  const term = await attach(peer, thread, pane)
  await term.type('echo "hi-$((40+2))"; pwd; echo "$TERM $ELECTRON_RUN_AS_NODE."\n')
  await term.waitFor('hi-42')
  await term.waitFor(dir.replace(/^\/private/, ''))
  await term.waitFor('xterm-256color .')
  // Resized: the shell sees its new size.
  await peer.call(RESIZE, { thread, pane, cols: 100, rows: 30 })
  await term.type('stty size\n')
  await term.waitFor('30 100')
  await close()
})

it('keeps the shell while no window is attached, and replays what it printed to the next one', async () => {
  const { connect, close } = await open()
  const first = await connect()
  const { thread, pane } = await terminalPane(first.peer)
  const term = await attach(first.peer, thread, pane)
  await term.type('echo $$; echo "before-$((1+1))"\n')
  await term.waitFor('before-2')
  const pid = Number(/^(\d+)\r?$/m.exec(term.seen.live)![1])
  // The window goes (a reload): the shell stays, and keeps going.
  term.channel.abort('reload')
  await new Promise((r) => setTimeout(r, 100))
  expect(alive(pid)).toBe(true)
  // Another client attaches: it's replayed the scrollback, then sees what's new.
  const second = await connect()
  const again = await attach(second.peer, thread, pane)
  await until(() => again.seen.replayed.includes('before-2'), 'the scrollback')
  await again.type('echo "after-$((2+1))"\n')
  await again.waitFor('after-3')
  expect(again.seen.replayed).not.toContain('after-3')
  await close()
  await until(() => !alive(pid), 'the shell to stop with the daemon')
})

it('stops the shell when its pane closes or its thread is archived', async () => {
  const { connect, close } = await open()
  const { peer } = await connect()
  const pidOf = async (thread: string, pane: string) => {
    const term = await attach(peer, thread, pane)
    await term.type('echo "pid=$$"\n')
    await until(() => /pid=\d+/.test(term.seen.live), 'its pid')
    return Number(/pid=(\d+)/.exec(term.seen.live)![1])
  }
  const closing = await terminalPane(peer)
  const one = await pidOf(closing.thread, closing.pane)
  await peer.call('pane.close', { id: closing.thread, pane: closing.pane })
  await until(() => !alive(one), 'the shell to stop as its pane closed')
  await expect(Channels.of(peer).open(IO, { thread: closing.thread, pane: closing.pane })).rejects.toThrow(/No terminal pane/)

  const archiving = await terminalPane(peer)
  const two = await pidOf(archiving.thread, archiving.pane)
  const other = await peer.call<Pane>('pane.open', { id: archiving.thread, kind: 'terminal', params: { n: 2 } })
  const three = await pidOf(archiving.thread, other.id)
  expect(three).not.toBe(two)
  await peer.call('thread.archive', { id: archiving.thread })
  await until(() => !alive(two) && !alive(three), 'both shells to stop as the thread was archived')
  await close()
})

it('closes the pane when its shell exits cleanly, and starts it again on a key otherwise', async () => {
  const { connect, close } = await open()
  const { peer } = await connect()
  const { thread, pane } = await terminalPane(peer)
  const term = await attach(peer, thread, pane)
  await term.type('exit 3\n')
  await term.waitFor('Exited with 3')
  await term.type('x')
  await term.type('echo "back-$((5+5))"\n')
  await term.waitFor('back-10')
  await term.type('exit\n')
  const panes = async () => (await peer.call<ThreadInfo[]>('thread.list', {})).find((t) => t.id === thread)!.panes ?? []
  await until(async () => (await panes()).length === 0, 'the pane to close')
  await close()
})

it("reports what a program in it says (OSC 7501), and a blocked one blocks its thread", async () => {
  const { connect, close } = await open()
  const { peer } = await connect()
  const { thread, pane } = await terminalPane(peer)
  const { value: initial } = await peer.call<{ value: unknown }>('value.watch', { key: 'terminal.status', scope: thread })
  expect(initial).toEqual({})
  const term = await attach(peer, thread, pane)
  const msg = Buffer.from('Allow rm?').toString('base64')
  await term.type(`printf '\\033]7501;state=blocked:kind=permission:app=demo:msg=${msg}\\007'\n`)
  const status = async () => (await peer.call<ThreadInfo[]>('thread.list', {})).find((t) => t.id === thread)!.status
  await until(async () => (await status()).state === 'blocked', 'the thread to be blocked')
  expect(await status()).toMatchObject({ state: 'blocked', kind: 'permission', msg: 'Allow rm?' })
  await term.type(`printf '\\033]7501;state=clear\\033\\\\'\n`)
  await until(async () => (await status()).state !== 'blocked', 'the thread to be unblocked')
  await close()
})
