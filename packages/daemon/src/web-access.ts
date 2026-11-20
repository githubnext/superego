// Web access: this machine serving the app and its threads to browsers (web.ts), on this computer or over Tailscale,
// to the devices paired with it (web-devices.ts), as the `web` settings say; and the `web.*` actions that pair them.
// Where it's reached is worked out (Tailscale's name for the machine, or loopback's) unless `web.host` names it; on a
// machine with more than one tailscaled, `web.tailscale.socket` says which one serves it.
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { artifactFile, Lifetime, obj, RpcError, str, type Router } from '@superego/protocol'
import type { SettingsRegistry } from '@superego/settings'
import type { Clients } from './clients.ts'
import type { Daemon, DaemonContext, DaemonOptions } from './daemon.ts'
import { defineAction } from './extension.ts'
import { fileIn } from './files.ts'
import type { Relay } from './relay.ts'
import { describeInstance, otherInstances, startServe, stopServe, tailnetNames, type TailscaleState } from './tailscale.ts'
import { serveWeb, webOrigin, type ServedByTailscale, type WebServer } from './web.ts'
import { WebDevices } from './web-devices.ts'

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
  let served: Omit<ServedByTailscale, 'pairOwner' | 'nodeAt'> & { port: number; socket?: string } | undefined
  let names: { at: number; map: Map<string, string> } = { at: 0, map: new Map() }
  const nodeAt = async (address: string) => {
    if (!names.map.has(address) && Date.now() - names.at > 30_000) names = { at: Date.now(), map: await tailnetNames(served?.socket) }
    return names.map.get(address)
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
  const pairOwner = () => settings.get<boolean>('web.tailscale.pairing') === true
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
    if (served) await stopServe(served.port, served.socket)
    served = undefined
    names = { at: 0, map: new Map() }
    tailscale = undefined
    await web?.close()
    web = undefined
    webError = undefined
    if (key) {
      try {
        web = await serveWeb({ root: options.webRoot!, port, devices: webDevices, serve,
          tailscale: () => served && { ...served, pairOwner: pairOwner(), nodeAt },
          origin: () => chosen().origin,
          artifact: async (thread, asked, elsewhere) => {
            const path = artifactFile(asked)
            if (!path) throw new RpcError('invalid', `${asked} is outside the thread's folder`)
            return elsewhere
              ? Buffer.from((await relay.call(elsewhere, 'file.read', { thread, path, base64: true }) as { content: string }).content, 'base64')
              : readFile(fileIn(await cwdOf(thread), path))
          } })
      } catch (error) {
        webError = (error as Error).message
      }
      if (web && access === 'tailscale') {
        tailscale = { state: 'starting' }
        settings.invalidate()
        const prefix = `.tailscale-${randomUUID()}`
        const port = web.port
        tailscale = await startServe(port, prefix, socket)
        if (tailscale.state === 'serving') served = { prefix, name: tailscale.name, ...(tailscale.owner ? { owner: tailscale.owner } : {}), port, ...(socket ? { socket } : {}) }
      }
    }
    settings.invalidate()
  }
  const webAddress = () => web && (chosen().origin ?? (tailscale?.state === 'serving' ? tailscale.url : web.url))
  /** The devices list: paired devices, and the owner's own through Tailscale while those get in without pairing. */
  const webDeviceList = () => webDevices.list().filter((d) => !d.tailscale || (served && !pairOwner()))
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
      { key: 'web.tailscale.pairing', title: 'Require pairing for my Tailscale login too', default: false, type: { type: 'boolean' }, consent: true,
        description: 'Otherwise your own devices on the tailnet get in without pairing.', hidden: () => settings.get('web.access') !== 'tailscale' },
    ],
    data: () => {
      if (settings.get('web.access') === 'tailscale') lookAround()
      return {
        url: webAddress() ?? null, tailscale: tailscale ?? null, devices: webDeviceList(),
        error: webError ?? chosen().error ?? null,
      }
    },
  })
  life.add(webDevices.onChange(() => settings.invalidate()))
  // Pairing switched on for the owner's login: their devices through Tailscale get in no more, as of now.
  let pairingOwner = pairOwner()
  life.add(settings.onChange(() => {
    if (pairOwner() !== pairingOwner && (pairingOwner = pairOwner())) web?.disconnect((id) => id.startsWith('tailscale:'))
  }))
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
    id: 'web.devices', title: 'List the devices paired for web access', expose: ['ui', 'cli'], params: obj({}),
    run: async () => webDeviceList(),
  }))
  router.register(defineAction({
    id: 'web.revoke', title: 'Unpair a device', expose: ['ui', 'cli'], params: obj({ id: str() }),
    async run({ id }) {
      if (id.startsWith('tailscale:')) throw new RpcError('invalid', 'Your own Tailscale login is let in as a whole: require pairing for it instead.')
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
