// Where an agent runs, next to the user: said only when a window is on another computer (the app over ssh, a browser
// through Tailscale), so `localhost` here isn't theirs; on one computer, nothing.
import { mkdtemp, rm } from 'node:fs/promises'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { defineApp, PROTOCOL_VERSION, RpcPeer, type ThreadInfo } from '@superego/protocol'
import { connectSocket, listen, openDaemon } from '../src/index.ts'
import { Clients } from '../src/clients.ts'
import { watchTailnets, type Tailnet } from '../src/tailscale.ts'
import { whereYouRun } from '../src/where.ts'
import { until } from './until.ts'

for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_OAUTH_TOKEN', 'OPENAI_API_KEY']) delete process.env[key]
const SUPEREGO = defineApp({ name: 'superego', id: 'superego' })
let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'superego-where-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }); delete process.env.SUPEREGO_REPLAY_SPEED })

it('tells the agent where it runs when the user\'s window is on another computer, and nothing when it is on this one', async () => {
  process.env.SUPEREGO_MODEL = 'faux'
  process.env.SUPEREGO_REPLAY_SPEED = '0'
  const daemon = await openDaemon({ app: SUPEREGO, dataDir: dir, defaultCwd: dir, agentsDir: join(dir, 'agents') })
  const server = await listen(daemon, join(dir, 'superego.sock'))
  const connect = async (client: string, label?: string) => {
    const { peer, socket } = await connectSocket(join(dir, 'superego.sock'))
    await peer.call('hello', { client, version: PROTOCOL_VERSION, ...(label ? { label } : {}) })
    return { peer, close: () => socket.destroy() }
  }
  const cli = await connect('superego-cli', 'the-mac')
  /** What a new thread's agent was told. */
  const told = async () => {
    const thread = await cli.peer.call<ThreadInfo>('thread.start', { prompt: 'where am I?' })
    await until(async () => (await cli.peer.call<ThreadInfo[]>('thread.list', {})).find((t) => t.id === thread.id)?.status.state === 'done')
    const { value } = await cli.peer.call<{ value: { entries: unknown[] } }>('thread.watch', { thread: thread.id })
    return JSON.stringify(value.entries)
  }

  // No window at all (the command line isn't one, wherever it is), and a window on this computer: nothing.
  expect(await told()).not.toContain('localhost')
  const here = await connect('superego-app', hostname())
  expect(await told()).not.toContain('localhost')

  const there = await connect('superego-app', 'the-mac')
  expect(await told()).toContain('The user may be in a window on this machine or on another computer (the-mac)')
  here.close()
  await until(async () => !JSON.stringify(await cli.peer.call('clients.watch', {})).includes(hostname()))
  const remote = await told()
  expect(remote).toContain('The user\'s window is on another computer (the-mac), so `localhost` here isn\'t `localhost` for them.')
  expect(remote).toContain('Never give the user a localhost address')
  expect(remote).toContain('browser pane\'s `url`')

  // The window gone (asleep), it's still where it was.
  there.close()
  expect(await told()).toContain('(the-mac)')
  cli.close()
  server.close()
  await daemon.close()
})

it('counts windows, not agents\' command lines or other daemons, and tells a browser through Tailscale by its transport', () => {
  const clients = new Clients({ hostname: 'workbox', windowKinds: ['superego-app', 'web'] })
  const peer = new RpcPeer(() => true)
  expect(clients.windows()).toEqual({ here: false, elsewhere: [], browser: false, reached: [] })
  clients.hello(clients.add(peer), 'superego-daemon', 'mbp')
  clients.hello(clients.add(peer), 'superego-cli', 'mbp', 'thread-1')
  expect(clients.windows()).toEqual({ here: false, elsewhere: [], browser: false, reached: [] })
  const app = clients.add(peer)
  clients.hello(app, 'superego-app', 'WorkBox')
  expect(clients.windows()).toEqual({ here: true, elsewhere: [], browser: false, reached: [] })
  clients.remove(app)
  clients.hello(clients.add(peer, { via: 'tailscale', label: 'me@example.com', elsewhere: true, host: 'workbox.tail1.ts.net' }), 'web', undefined)
  expect(clients.windows()).toEqual({ here: false, elsewhere: [], browser: true, reached: ['workbox.tail1.ts.net'] })
  expect(whereYouRun(clients.windows())).toContain('ask how they reach this machine')
  expect(whereYouRun(clients.windows())).not.toContain('browser pane')
  expect(whereYouRun({ here: true, elsewhere: [], browser: false, reached: [] })).toBeUndefined()
})

const work: Tailnet = { tailnet: 'work.example', name: 'box.tail1.ts.net', peers: new Set(['colleagues-mac']) }
const home: Tailnet = { tailnet: 'home.example', name: 'workbox.tail2.ts.net', peers: new Set(['w2q3qrc7j3', 'gh-m5']) }

it('names this machine as it is on its tailnets, and which is theirs, never the hostname alone', () => {
  // The app on a computer of one tailnet: that one's name is theirs.
  const app = whereYouRun({ here: false, elsewhere: ['W2Q3QRC7J3'], browser: false, reached: [] }, [work, home])!
  expect(app).toContain('This machine on their tailnet: workbox.tail2.ts.net (home.example); also box.tail1.ts.net (work.example). If they need an address beyond the browser pane, use that name exactly; never make one up.')
  // A browser: the name it came in by.
  const browser = whereYouRun({ here: false, elsewhere: [], browser: true, reached: ['box.tail1.ts.net'] }, [work, home])!
  expect(browser).toContain('This machine on their tailnet: box.tail1.ts.net (work.example); also workbox.tail2.ts.net (home.example). If they need an address, use that name exactly')
  expect(browser).not.toContain('browser pane')
  // Theirs not known: all of them.
  expect(whereYouRun({ here: false, elsewhere: ['elsewhere'], browser: false, reached: [] }, [work, home]))
    .toContain('This machine\'s tailnet names: box.tail1.ts.net (work.example), workbox.tail2.ts.net (home.example). If they need an address beyond the browser pane, use one of these exactly')
  // No Tailscale: ask.
  expect(whereYouRun({ here: false, elsewhere: ['elsewhere'], browser: false, reached: [] }, []))
    .toContain('If they need an address beyond the browser pane, ask how they reach this machine')
})

it('reads the tailnets in the background, at most once a while, and gives what it last read without waiting', async () => {
  let reads = 0
  let finish: (t: Tailnet[]) => void = () => {}
  const tailnets = watchTailnets(60_000, () => { reads++; return new Promise((resolve) => { finish = resolve }) })
  expect(tailnets()).toEqual([])
  expect(tailnets()).toEqual([])
  expect(reads).toBe(1)
  finish([work])
  await until(() => tailnets().length === 1)
  expect(reads).toBe(1)
})
