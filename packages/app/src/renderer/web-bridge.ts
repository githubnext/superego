// Superego in a browser: the same window as the desktop app, with `window.superego` over a WebSocket to the daemon that served the
// page (its Web access setting), instead of Electron's preload. That daemon is "local", and every machine it reaches is
// here too: calls for them go through it (`relay.call`) and their news comes back from it (`relay.event`). What the
// desktop keeps in its main process (the app's own settings, which remote profile UIs may run) is kept in this browser.
import { FEATURES, PROTOCOL_VERSION, RpcError, RpcPeer, type Hello, type Notifications } from '@superego/protocol'
import { serveSettings, SettingsRegistry, type SettingsStore } from '@superego/settings'
import { carriesFiles, uploadAttachments } from '@superego/client/uploads'
import type { MachineEntry, SuperegoBridge, SuperegoEvent } from '../shared.ts'
import { sameGrant, type UiGrant } from '../ui-trust.ts'
import { askToPair, refused, type Paired } from './pair-gate.ts'

const SETTINGS = 'superego.appSettings'
const UI_TRUST = 'superego.uiTrust'
/** Ping this often, and count the link dead after this long without a word, as the desktop's links do. */
const PING_EVERY = 5_000
const SILENCE = 15_000
/** Unsent bytes past which the WebSocket counts as full, and below which it takes more again. */
const FULL = 1024 * 1024
const ROOM = 256 * 1024

/**
 * A pairing code from the address Settings showed (`#pair=…`), taken out of the address bar at once. It's in the
 * fragment, so it never reached a server, and it works only once: the page trades it for a cookie (see pair-gate.ts).
 */
function takeCode(): string | undefined {
  const given = new URLSearchParams(location.hash.slice(1)).get('pair') ?? undefined
  if (given) history.replaceState(null, '', location.pathname + location.search)
  return given
}

/** Trade a code for this browser's credential: the daemon sets it as an HttpOnly cookie, which this page never sees. */
async function pair(code: string, name = ''): Promise<Paired> {
  const response = await fetch('/pair', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, ...(name ? { name } : {}) }) })
  if (response.ok) return { ok: true }
  const body = await response.json().catch(() => ({})) as { error?: string }
  return { ok: false, error: body.error ?? `The machine said ${response.status}` }
}

/** The remote profile UIs allowed to run in this window (see ../ui-trust.ts), kept in localStorage. */
const uiTrust = {
  list(): UiGrant[] {
    try {
      const parsed: unknown = JSON.parse(localStorage.getItem(UI_TRUST) ?? '[]')
      return Array.isArray(parsed) ? parsed.filter((g): g is UiGrant => [g?.machine, g?.dir, g?.hash].every((v) => typeof v === 'string')) : []
    } catch { return [] }
  },
  save: (grants: UiGrant[]) => localStorage.setItem(UI_TRUST, JSON.stringify(grants)),
  /** One version of a profile's UI; an earlier version of the same profile from that machine is replaced. */
  allow(grant: UiGrant) { this.save([...this.list().filter((g) => !(g.machine === grant.machine && g.dir === grant.dir)), { machine: grant.machine, dir: grant.dir, hash: grant.hash }]) },
  forget(grant: UiGrant) { this.save(this.list().filter((g) => !sameGrant(g, grant))) },
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
  const away = (state: MachineEntry['state']) => setEntries(entries.map((m) => m.state === 'disabled' ? m : { ...m, state }))
  let machinesSub: string | undefined

  // ── The daemon, over a WebSocket that reconnects ───────────────────────────────────────────────────────────────
  let peer: RpcPeer | undefined
  let socket: WebSocket | undefined
  let ready: Promise<RpcPeer>
  let retry = 500
  // Who this browser is to the daemon decides what to show: the app, the pairing form, or why it isn't let in.
  let gate: Promise<void> | undefined
  const admit = (message = '') => {
    gate ??= (async () => {
      const session = await fetch('/session').then(async (r) => ({ status: r.status, ...(await r.json().catch(() => ({}))) as { error?: string; pairing?: boolean } }))
      if (session.status === 401 && session.pairing) await askToPair(pair, message)
      else if (session.status === 401 || session.status === 403) await refused(session.error ?? 'This machine doesn’t let you in.')
    })().finally(() => { gate = undefined; retry = 500; connect() })
  }
  let code = takeCode()
  const connect = () => {
    ready = new Promise((resolve, reject) => {
      if (code) {
        const given = code
        code = undefined
        void pair(given).then((paired) => paired.ok ? connect() : admit(paired.error), () => admit('Can’t reach the machine.'))
        return reject(new RpcError('disconnected', 'Pairing'))
      }
      let opened = false
      // The cookie goes with the upgrade by itself; nothing secret is in the address.
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
        if (method === 'relay.event') {
          const relayed = params as Notifications['relay.event']
          return emit({ machine: relayed.machine, method: relayed.method, params: relayed.params })
        }
        if (method === 'machines.changed') {
          const { sub, value } = params as Notifications['machines.changed']
          if (sub === machinesSub) setEntries(value)
          return
        }
        emit({ machine: 'local', method, params })
      })
      let beat: ReturnType<typeof setInterval> | undefined
      ws.onopen = async () => {
        opened = true
        try {
          const hello = await next.call<Hello>('hello', { client: 'web', version: PROTOCOL_VERSION, features: [...FEATURES] })
          // A link gone quiet (a phone that slept, a network that changed) closes, and this reconnects.
          if (hello.features.includes('heartbeat')) {
            beat = setInterval(() => {
              if (Date.now() - next.lastReceived > SILENCE) ws.close()
              else next.call('ping', {}).catch(() => {})
            }, PING_EVERY)
          }
          const self: MachineEntry = { id: 'local', label: hello.machine.hostname, state: 'connected', machine: { id: hello.machine.id, hostname: hello.machine.hostname }, features: hello.features }
          if (hello.features.includes('relay')) {
            const { sub, value } = await next.call<{ sub: string; value: MachineEntry[] }>('machines.watch', {})
            machinesSub = sub
            setEntries(value.map((m) => m.id === 'local' ? { ...m, ...self } : m))
          } else setEntries([self])
          peer = next
          retry = 500
          resolve(next)
        } catch (error) { reject(error) }
      }
      ws.onclose = (event) => {
        clearInterval(beat)
        next.close()
        peer = undefined
        machinesSub = undefined
        away('disconnected')
        reject(new RpcError('disconnected', 'Not connected'))
        const again = () => { setTimeout(connect, retry); retry = Math.min(retry * 2, 10_000) }
        // Revoked in Settings: pair again.
        if (event.code === 4401) return admit('This browser was removed from the machine. Pair it again.')
        // Refused at the door, or only the network? The socket doesn't say; the daemon does.
        if (opened) return again()
        void fetch('/session').then((r) => r.ok ? again() : admit(), again)
      }
    })
    ready.catch(() => {})
  }
  connect()

  // ── The app's own endpoint, here in the page ───────────────────────────────────────────────────────────────────
  const settings = new SettingsRegistry(store)
  settings.register({
    id: 'appearance', title: 'Appearance', order: 50,
    settings: [
      { key: 'app.font.interface', title: 'Interface font', default: null, type: { type: 'font', nullLabel: 'System' } },
      { key: 'app.font.mono', title: 'Monospace font', default: null, description: 'Code, tool output and paths.', type: { type: 'font', monospace: true, nullLabel: 'System monospace' } },
      { key: 'app.accent', title: 'Accent colour', default: 'color(display-p3 0.155 0.319 0.654)', description: 'Focus rings, primary buttons, links and selection. Any CSS colour.', type: { type: 'color' } },
    ],
  })
  settings.register({
    id: 'keyboard', title: 'Keyboard', order: 65,
    settings: [{ key: 'app.keys', title: 'Shortcuts', default: {}, description: 'Every action that runs without asking for more. Click a shortcut and press new keys; ⌫ removes it, Esc keeps it.', type: { type: 'keymap' } }],
  })
  const subs = new Map<string, () => unknown>()
  const served = serveSettings(settings, (params) => emit({ machine: 'app', method: 'settings.changed', params }), subs)
  const appActions = [
    { id: 'app.settings.set', title: 'Change an app setting', runs: 'app', expose: ['ui'] },
    { id: 'machines.reconnect', title: 'Reconnect a machine', runs: 'app', expose: ['ui'] },
  ]
  const app: Record<string, (params: never) => unknown> = {
    'settings.watch': served['settings.watch'] as never,
    'app.settings.set': async ({ key, value }: { key: string; value: never }) => { await settings.set(key, value); return null },
    'settings.register': async ({ section }: { section: Parameters<SettingsRegistry['register']>[0] }) => {
      try { settings.register(section) } catch { /* registered already, by another mount */ }
      return null
    },
    'unwatch': async ({ sub }: { sub: string }) => { await subs.get(sub)?.(); subs.delete(sub); return null },
    'action.list': async () => appActions,
    'action.log': async () => [],
    'app.ready': async () => ({}),
    'app.desktop': async () => ({ web: true }),
    'service.get': async () => ({ phase: 'current', busy: false }),
    'ui.trust.list': async () => uiTrust.list(),
    'ui.trust.allow': async (grant: UiGrant) => { uiTrust.allow(grant); return null },
    'ui.trust.forget': async (grant: UiGrant) => { uiTrust.forget(grant); return null },
    /** This page's own connection, or the serving daemon's link to another machine. Adding, removing, logging in and installing are the desktop app's. */
    'machines.reconnect': async ({ id }: { id: string }) => {
      if (id !== 'local') return (peer ?? await ready).call('machines.reconnect', { id })
      socket?.close()
      return null
    },
  }

  /** A call on the daemon, its larger attachments sent ahead as uploads when it takes them (see @superego/client's uploads.ts). */
  const send = async (method: string, params: unknown) => {
    const to = peer ?? await ready
    const local = entries.find((m) => m.id === 'local')
    if (local?.features?.includes('uploads') && carriesFiles(method, params)) return to.call(method, await uploadAttachments(to, method, params))
    return to.call(method, params)
  }

  return {
    async call(machine, method, params) {
      if (machine === 'app') {
        const handler = app[method]
        if (!handler) throw new RpcError('unsupported', `${method} is part of the desktop app`)
        return handler(params as never)
      }
      if (machine === 'local') return send(method, params)
      if (!entries.some((m) => m.id === machine)) throw new RpcError('not_found', `No machine ${machine} here`)
      return send('relay.call', { machine, method, params })
    },
    machines: async () => entries,
    artifactUrl: (machine, thread, path) =>
      `/artifact/${machine === 'local' ? '' : `~${encodeURIComponent(machine)}/`}${encodeURIComponent(thread)}/${path.split('/').map(encodeURIComponent).join('/')}`,
    onEvent(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
    web: true,
  }
}
