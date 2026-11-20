// Web access: this machine serving the app and its threads to browsers (web.ts), on this computer or over Tailscale,
// to the devices paired with it, or approved (web-devices.ts), as the `web` settings say; and the `web.*` actions that
// pair, approve and revoke them.
// Where it's reached is worked out (Tailscale's name for the machine, or loopback's) unless `web.host` names it; on a
// machine with more than one tailscaled, `web.tailscale.socket` says which one serves it.
import { join } from 'node:path'
import { Lifetime, obj, RpcError, str, type Router } from '@superego/protocol'
import type { SettingsRegistry } from '@superego/settings'
import type { Clients } from './clients.ts'
import type { Daemon, DaemonContext, DaemonOptions } from './daemon.ts'
import { readArtifact } from './artifacts.ts'
import { defineAction } from './extension.ts'
import type { Relay } from './relay.ts'
import { describeInstance, otherInstances, startServe, stopServe, whois, type TailnetNode, type TailscaleState } from './tailscale.ts'
import { serveWeb, webOrigin, type ServedByTailscale, type WebServer } from './web.ts'
import { WebDevices } from './web-devices.ts'

/** The socket Tailscale serve proxies to, in a folder of its own in the data folder; undefined when the path is too long for one. */
function serveSocketOf(dataDir: string): string | undefined {
  const path = join(dataDir, 'web', 'tailscale.sock')
  return Buffer.byteLength(path) < 100 ? path : undefined
}

export async function openWebAccess({ options, settings, router, clients, relay, serve, cwdOf }: {
  options: Pick<DaemonOptions, 'dataDir' | 'webRoot'>
  settings: SettingsRegistry
  router: Router<DaemonContext>
  clients: Clients
  relay: Relay
  /** The daemon's own, for a browser's connection. */
  serve: Daemon['serve']
  /** A thread's folder, for the artifacts it serves. */
  cwdOf(thread: string): Promise<string>
}) {
  const webDevices = await WebDevices.open(options.dataDir)
  /** What it listens to, let go of as it closes: no change after that serves again. */
  const life = new Lifetime('Web access')
  let web: WebServer | undefined
  let webKey = ''
  let webError: string | undefined
  /** Tailscale serve: how setting it up went, and while it serves, what requests through it look like. */
  let tailscale: TailscaleState | undefined
  let served: Omit<ServedByTailscale, 'whois'> & { port: number; target: string; socket?: string } | undefined
  /** The tailnet devices requests came from lately, by address: asked of tailscaled once in a while, not each request. */
  let nodes = new Map<string, { at: number; node: Promise<TailnetNode | undefined> }>()
  const nodeAt = (address: string) => {
    const now = Date.now()
    for (const [at, known] of nodes) if (now - known.at > 10_000) nodes.delete(at)
    const known = nodes.get(address) ?? { at: now, node: whois(address, served?.socket) }
    nodes.set(address, known)
    // One that failed is asked again next time.
    known.node.catch(() => { if (nodes.get(address) === known) nodes.delete(address) })
    return known.node
  }
  /** The tailscaled to serve through: its socket, or undefined for the default one. */
  const socketOf = () => settings.get<string>('web.tailscale.socket') || undefined
  /** The origin `web.host` names, if any; a value that isn't one (written by hand) is said in Settings, and ignored. */
  const chosen = (): { origin?: string; error?: string } => {
    try {
      const origin = webOrigin(settings.get<string>('web.host') ?? '')
      return origin ? { origin } : {}
    } catch (error) { return { error: `Host: ${(error as Error).message}` } }
  }
  /** The tailnets this machine's tailscaleds are on, by socket ('' the default's), to choose one by. */
  let tailnets = new Map<string, string>()
  let lookedAt = 0
  const lookAround = () => {
    if (Date.now() - lookedAt < 30_000) return
    lookedAt = Date.now()
    const sockets = otherInstances()
    if (!sockets.length) return
    void Promise.all(['', ...sockets].map(async (socket) => [socket, await describeInstance(socket || undefined)] as const)).then((found) => {
      const next = new Map(found.filter((entry): entry is [string, string] => Boolean(entry[1])))
      if (JSON.stringify([...next]) !== JSON.stringify([...tailnets])) { tailnets = next; settings.invalidate() }
    })
  }
  /** Serve (or stop serving) browsers as the Web access settings say, whenever they change; one change at a time. */
  let webQueue = Promise.resolve()
  const applyWeb = () => (webQueue = webQueue.then(applyWebNow, applyWebNow))
  const applyWebNow = async () => {
    const access = settings.get<string>('web.access') ?? 'off'
    const port = settings.get<number>('web.port') ?? 7777
    const socket = access === 'tailscale' ? socketOf() : undefined
    const key = access === 'off' || !options.webRoot ? '' : `${access}:${port}:${socket ?? ''}`
    if (key === webKey) return
    webKey = key
    if (served) await stopServe(served, served.socket)
    served = undefined
    nodes = new Map()
    tailscale = undefined
    await web?.close()
    web = undefined
    webError = undefined
    if (key) {
      // Where serve proxies to (see tailscale.ts): too long a path for a socket (a data folder deep down) is said, and
      // not served through, rather than put somewhere others could open it.
      const target = access === 'tailscale' ? serveSocketOf(options.dataDir) : undefined
      try {
        web = await serveWeb({ root: options.webRoot!, port, devices: webDevices, serve,
          ...(target ? { serveSocket: target } : {}),
          tailscale: () => served && { ...served, whois: nodeAt },
          origin: () => chosen().origin,
          artifact: async (thread, path, elsewhere) => elsewhere
            ? Buffer.from((await relay.call(elsewhere, 'artifact.read', { thread, path }) as { content: string }).content, 'base64')
            : readArtifact(await cwdOf(thread), path) })
      } catch (error) {
        webError = (error as Error).message
      }
      if (web && access === 'tailscale') {
        if (!target) tailscale = { state: 'error', message: `The data folder's path (${options.dataDir}) is too long for the socket Tailscale serve proxies to: use a shorter one.` }
        else {
          tailscale = { state: 'starting' }
          settings.invalidate()
          const ends = { port: web.port, target }
          tailscale = await startServe(ends, socket)
          if (tailscale.state === 'serving') served = { name: tailscale.name, ...(tailscale.owner ? { owner: tailscale.owner } : {}), ...ends, ...(socket ? { socket } : {}) }
        }
      }
    }
    settings.invalidate()
  }
  const webAddress = () => web && (chosen().origin ?? (tailscale?.state === 'serving' ? tailscale.url : web.url))
  settings.register({
    id: 'web', title: 'Web access', order: 80, ui: 'web',
    description: 'Use this machine from a browser or a phone: it serves the app and its threads to the devices you pair.',
    settings: [
      { key: 'web.access', title: 'Serve the app', default: 'off', type: { type: 'choice', options: [
        { value: 'off', label: 'Off' }, { value: 'local', label: 'To this computer' }, { value: 'tailscale', label: 'Over Tailscale' },
      ] }, consent: true, disabled: () => options.webRoot ? undefined : 'This daemon has no web app to serve.' },
      { key: 'web.port', title: 'Port', default: 7777, type: { type: 'number', min: 1024, max: 65535, step: 1 } },
      { key: 'web.tailscale.socket', title: 'Tailnet', default: '', consent: true,
        description: 'This machine runs more than one tailscaled: the one to serve through.',
        type: () => {
          const current = socketOf()
          const sockets = [...new Set([...otherInstances(), ...(current ? [current] : [])])]
          return { type: 'choice', options: [
            { value: '', label: tailnets.get('') ?? 'The default tailscaled' },
            ...sockets.map((socket) => ({ value: socket, label: tailnets.has(socket) ? `${tailnets.get(socket)} · ${socket}` : socket })),
          ] }
        },
        hidden: () => settings.get('web.access') !== 'tailscale' || (!socketOf() && !otherInstances().length) },
      { key: 'web.host', title: 'Host', default: '', consent: true, type: { type: 'string', placeholder: 'Automatic' },
        description: 'The name browsers reach it at, if not the one it works out: a hostname, or an origin like http://box.lan:7777.',
        validate: (value) => { try { webOrigin(String(value)); return undefined } catch (error) { return (error as Error).message } } },
    ],
    data: () => {
      if (settings.get('web.access') === 'tailscale') lookAround()
      return {
        url: webAddress() ?? null, tailscale: tailscale ?? null, devices: webDevices.list(),
        error: webError ?? chosen().error ?? null,
      }
    },
  })
  life.add(webDevices.onChange(() => settings.invalidate()))
  const webOn = () => { if (!web) throw new RpcError('web_off', 'Web access is off: turn it on in Settings → Web access.') }
  router.register(defineAction({
    id: 'web.pair', title: 'Pair a device for web access', expose: ['ui', 'cli'], consent: true, params: obj({}),
    async run() {
      webOn()
      const { ticket, code, expires } = webDevices.pair()
      return { link: `${webAddress()}/#pair=${ticket}`, code, expires }
    },
  }))
  router.register(defineAction({
    id: 'web.devices', title: 'List the devices paired for web access, and those waiting', expose: ['ui', 'cli'], params: obj({}),
    run: async () => webDevices.list(),
  }))
  // From any client already in (this computer's app or command line, a device paired or approved): never the device
  // asking, which isn't connected, nor an agent.
  router.register(defineAction({
    id: 'web.approve', title: 'Approve a device of yours on the tailnet', expose: ['ui', 'cli'], consent: true, params: obj({ id: str() }),
    async run({ id }) {
      const device = await webDevices.approve(id)
      if (!device) throw new RpcError('not_found', `No device ${id} waiting`)
      return device
    },
  }))
  router.register(defineAction({
    id: 'web.revoke', title: 'Unpair a device', expose: ['ui', 'cli'], params: obj({ id: str() }),
    async run({ id }) {
      if (!(await webDevices.revoke(id))) throw new RpcError('not_found', `No device ${id}`)
      return null
    },
  }))
  router.register(defineAction({
    id: 'web.rename', title: 'Rename a paired device', expose: ['ui', 'cli'], params: obj({ id: str(), name: str() }),
    async run({ id, name }) {
      const device = await webDevices.rename(id, name)
      if (!device) throw new RpcError('not_found', `No device ${id}`)
      clients.relabel(id, device.name)
      return device
    },
  }))
  life.add(settings.onChange(() => void applyWeb()))
  await applyWeb()
  return {
    /** Stop listening to the settings, and serving once the change being made is. */
    async close() {
      life.dispose()
      await webQueue
      await web?.close()
      await webDevices.saved()
    },
  }
}
