// Superego in a browser: the same window as the desktop app, with `window.superego` over a WebSocket to the daemon that served the
// page (its Web access setting), instead of Electron's preload. That daemon is "local", and every machine it reaches is
// here too: calls for them go through it (`relay.call`) and their news comes back from it (`relay.event`). What the
// desktop keeps in its main process (the app's own settings) is kept in this browser.
import { Channels, PROTOCOL_VERSION, RpcError, RpcPeer, versionOf, type Channel, type Hello, type Notifications } from '@superego/protocol'
import type { SettingsStore } from '@superego/settings'
import { carriesFiles, uploadAttachments } from '@superego/client/uploads'
import type { BridgeChannel, MachineEntry, SuperegoBridge, SuperegoEvent } from '../shared/bridge.ts'
import { APP } from '../shared/app-settings.ts'
import { pageApp } from './page-app.ts'
import { askPairing, LIMITED, type Pairing } from './pair-gate.ts'

const SETTINGS = 'superego.appSettings'
/** Ping this often, and count the link dead after this long without a word, as the desktop's links do. */
const PING_EVERY = 5_000
const SILENCE = 15_000
/** Unsent bytes past which the WebSocket counts as full, and below which it takes more again. */
const FULL = 1024 * 1024
const ROOM = 256 * 1024

/**
 * A pairing ticket, from the link Settings showed (`#pair=…`): taken out of the address (and so out of history) before
 * anything else, and spent once.
 */
function takeTicket(): string | undefined {
  const ticket = new URLSearchParams(location.hash.slice(1)).get('pair') ?? undefined
  if (ticket) history.replaceState(null, '', location.pathname + location.search)
  return ticket
}

/** Pair this browser with a ticket or a code: the daemon sets its device cookie. */
async function pair(given: { ticket: string } | { code: string }): Promise<Pairing> {
  const response = await fetch('/pair', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(given), credentials: 'same-origin' })
  return response.ok ? 'ok' : response.status === 429 ? 'limited' : 'wrong'
}

/** Whether the daemon lets this browser in (its cookie): the WebSocket only says so by closing. */
async function admitted(): Promise<Pairing> {
  const response = await fetch('/rpc', { cache: 'no-store', credentials: 'same-origin' })
  if (response.status === 429) return 'limited'
  if (response.status === 401) return 'wrong'
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return 'ok'
}

/** App settings, kept in localStorage. */
const store: SettingsStore = {
  load: () => { try { return JSON.parse(localStorage.getItem(SETTINGS) ?? '{}') } catch { return {} } },
  save: async (values) => localStorage.setItem(SETTINGS, JSON.stringify(values)),
}

export function webBridge(): SuperegoBridge {
  const listeners = new Set<(event: SuperegoEvent) => void>()
  const emit = (event: SuperegoEvent) => { for (const listener of listeners) listener(event) }
  // The machines as the daemon last listed them: itself, then those it reaches. While it's away, all of them are.
  let entries: MachineEntry[] = [{ id: 'local', label: location.hostname, state: 'connecting' }]
  const setEntries = (next: MachineEntry[]) => { entries = next; emit({ machine: '$machines', method: '$machines', params: entries }) }
  /** This page's own daemon's entry, changed. */
  const setEntry = (next: Partial<MachineEntry>) => setEntries(entries.map((m) => m.id === 'local' ? { ...m, ...next } : m))
  /** Away, and every machine reached through it with it. */
  const away = (state: MachineEntry['state']) => setEntries(entries.map((m) => m.state === 'disabled' ? m : { ...m, state }))
  let machinesSub: string | undefined

  // ── The daemon, over a WebSocket that reconnects ───────────────────────────────────────────────────────────────
  let peer: RpcPeer | undefined
  let socket: WebSocket | undefined
  let ready: Promise<RpcPeer> = Promise.reject(new RpcError('disconnected', 'Not connected'))
  ready.catch(() => {})
  let retry = 500
  // Not paired, or not any more: the page asks for a code (see pair-gate.ts).
  let asking = false
  const ask = (why?: string) => {
    if (asking) return
    asking = true
    away('disconnected')
    void askPairing((code) => pair({ code }), why).then(() => {
      asking = false
      retry = 500
      connect()
    })
  }
  const connect = () => {
    ready = new Promise((resolve, reject) => {
      let opened = false
      const ws = socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/rpc`)
      // Full past FULL unsent bytes, as a socket's write says; it takes more once the browser has sent down to ROOM.
      let waiting = false
      const wait = () => {
        if (ws.readyState !== WebSocket.OPEN) return
        if (ws.bufferedAmount > ROOM) { setTimeout(wait, 20); return }
        waiting = false
        next.drain()
      }
      const next = new RpcPeer((line) => {
        if (ws.readyState !== WebSocket.OPEN) return true
        ws.send(line.trimEnd())
        if (ws.bufferedAmount < FULL) return true
        if (!waiting) { waiting = true; setTimeout(wait, 20) }
        return false
      })
      ws.onmessage = (message) => next.receive(String(message.data))
      next.onAny((method, params) => {
        // Channels are this connection's own business, not news for the window.
        if (method.startsWith('ch.')) return
        if (method === 'relay.event') {
          const relayed = params as Notifications['relay.event']
          return emit({ machine: relayed.machine, method: relayed.method, params: relayed.params })
        }
        if (method === 'machines.changed') {
          const { sub, value } = params as Notifications['machines.changed']
          // Its own entry is kept as this page knows it: the extensions it offers, how this connection stands.
          if (sub === machinesSub) setEntries(value.map((m) => m.id === 'local' ? { ...m, ...entries.find((e) => e.id === 'local') } : m))
          return
        }
        // What it offers changed since hello: `has` follows.
        if (method === 'features.changed') {
          const { features, extensions } = params as Notifications['features.changed']
          setEntry({ features, extensions })
        }
        emit({ machine: 'local', method, params })
      })
      let beat: ReturnType<typeof setInterval> | undefined
      ws.onopen = async () => {
        opened = true
        try {
          const hello = await next.call<Hello>('hello', { client: 'web', version: PROTOCOL_VERSION })
          // A link gone quiet (a phone that slept, a network that changed) closes, and this reconnects.
          beat = setInterval(() => {
            if (Date.now() - next.lastReceived > SILENCE) ws.close()
            else next.call('ping', {}).catch(() => {})
          }, PING_EVERY)
          const self: MachineEntry = {
            id: 'local', label: hello.machine.hostname, state: 'connected', machine: { id: hello.machine.id, hostname: hello.machine.hostname },
            features: hello.features, extensions: hello.extensions, version: versionOf(hello),
          }
          const { sub, value } = await next.call<{ sub: string; value: MachineEntry[] }>('machines.watch', {})
          machinesSub = sub
          setEntries(value.map((m) => m.id === 'local' ? self : m))
          peer = next
          retry = 500
          resolve(next)
        } catch (error) { reject(error) }
      }
      ws.onclose = () => {
        clearInterval(beat)
        next.close()
        peer = undefined
        machinesSub = undefined
        away('disconnected')
        reject(new RpcError('disconnected', 'Not connected'))
        const again = () => { setTimeout(connect, retry); retry = Math.min(retry * 2, 10_000) }
        // Refused at the door, or only the network? The socket doesn't say; the daemon does.
        if (opened) return again()
        void admitted().then((ok) => ok === 'ok' ? again() : ask(ok === 'limited' ? LIMITED : `This browser isn’t paired with ${location.hostname}.`), again)
      }
    })
    ready.catch(() => {})
  }
  const ticket = takeTicket()
  // Calls wait for a ticket to be spent, so the first connection is a paired one.
  const starting = !ticket ? Promise.resolve(connect()) : admitted().catch(() => 'wrong' as const)
    // Paired already (a link opened again): the ticket stays unspent.
    .then((state) => state === 'ok' ? 'ok' : pair({ ticket }))
    .then((paired) => paired === 'ok' ? connect() : ask(paired === 'limited' ? LIMITED : 'That link has expired or was used already.'), () => connect())

  // ── The app's own endpoint, here in the page ───────────────────────────────────────────────────────────────────
  const app = pageApp(emit, { store, actions: {
    /** This page's own connection, or the serving daemon's link to another machine. */
    'machine.reconnect': {
      info: { id: 'machine.reconnect', title: 'Reconnect a machine', runs: 'app', expose: ['ui'] },
      run: async ({ id }: { id: string }) => {
        if (id !== 'local') return (peer ?? await ready).call('machine.reconnect', { id })
        socket?.close()
        return null
      },
    },
  } })

  /** A call on the daemon, its larger attachments sent ahead as uploads (see @superego/client's uploads.ts). */
  const send = async (method: string, params: unknown) => {
    await starting
    const to = peer ?? await ready
    if (carriesFiles(method, params)) return to.call(method, await uploadAttachments(to, method, params))
    return to.call(method, params)
  }

  return {
    async call(machine, method, params) {
      if (machine === APP) return app.call(method, params)
      if (machine === 'local') return send(method, params)
      if (!entries.some((m) => m.id === machine)) throw new RpcError('not_found', `No machine ${machine} here`)
      return send('relay.call', { machine, method, params })
    },
    machines: async () => entries,
    // Only to this page's own daemon: a channel isn't relayed to the machines it reaches.
    async channel(machine, kind, params) {
      if (machine !== 'local') throw new RpcError('unsupported', 'In a browser, this works only on the machine that serves the page')
      await starting
      return bridgeChannel(await Channels.of(peer ?? await ready).open(kind, params))
    },
    // Another machine's, through this daemon: `<thread>@<machine>` (see the daemon's web.ts).
    artifactUrl: (machine, thread, path) =>
      `/artifact/${encodeURIComponent(machine === 'local' ? thread : `${thread}@${machine}`)}/${path.split('/').map(encodeURIComponent).join('/')}`,
    onEvent(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
    web: true,
  }
}

/** A protocol channel as a bridge hands it to the window. */
export function bridgeChannel(channel: Channel): BridgeChannel {
  const listeners = new Set<(reason?: string) => void>()
  let closed: { reason?: string } | undefined
  const end = (reason?: string) => {
    if (closed) return
    closed = reason ? { reason } : {}
    // Its own half too, once the other side ended: nothing more will be written.
    channel.end()
    for (const listener of listeners) listener(reason)
  }
  channel.ended.then(() => end(), (error: Error) => end(error.message))
  return {
    write: (bytes) => { channel.write(bytes).catch(() => {}) },
    onData: (listener) => channel.onData(listener),
    onClose: (listener) => { if (closed) listener(closed.reason); else listeners.add(listener) },
    close: () => channel.abort('Closed'),
  }
}
