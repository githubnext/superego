// Superego in a browser: the same window as the desktop app, with `window.superego` over a WebSocket to the daemon that served the
// page (its Web access setting), instead of Electron's preload. That daemon is the one machine, "local". What the desktop
// keeps in its main process (the app's own settings) is kept in this browser.
import { FEATURES, PROTOCOL_VERSION, RpcError, RpcPeer, type Hello } from '@superego/protocol'
import { serveSettings, SettingsRegistry, withMovedKeys, type SettingsStore } from '@superego/settings'
import { APP_MOVED, LAYOUT_SETTING, withMovedActions, withMovedLayout, type MachineEntry, type SuperegoBridge, type SuperegoEvent, type ThreadNotice } from '../shared.ts'
import { askPairing, LIMITED, type Pairing } from './pair-gate.ts'

const SETTINGS = 'superego.appSettings'

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

/** App settings, kept in localStorage; those kept under an old key (or a shortcut under an old action's id) read as their new one's, as the desktop app's are. */
const store: SettingsStore = withMovedLayout(withMovedActions(withMovedKeys({
  load: () => { try { return JSON.parse(localStorage.getItem(SETTINGS) ?? '{}') } catch { return {} } },
  save: async (values) => localStorage.setItem(SETTINGS, JSON.stringify(values)),
}, APP_MOVED)))

export function webBridge(): SuperegoBridge {
  const listeners = new Set<(event: SuperegoEvent) => void>()
  const emit = (event: SuperegoEvent) => { for (const listener of listeners) listener(event) }
  let entry: MachineEntry = { id: 'local', label: location.hostname, state: 'connecting' }
  const setEntry = (next: Partial<MachineEntry>) => { entry = { ...entry, ...next }; emit({ machine: '$machines', method: '$machines', params: [entry] }) }

  // ── The daemon, over a WebSocket that reconnects ───────────────────────────────────────────────────────────────
  let peer: RpcPeer | undefined
  let ready: Promise<RpcPeer> = Promise.reject(new RpcError('disconnected', 'Not connected'))
  ready.catch(() => {})
  let retry = 500
  // Not paired, or not any more: the page asks for a code (see pair-gate.ts).
  let asking = false
  const ask = (why?: string) => {
    if (asking) return
    asking = true
    setEntry({ state: 'disconnected' })
    void askPairing((code) => pair({ code }), why).then(() => {
      asking = false
      retry = 500
      connect()
    })
  }
  const connect = () => {
    ready = new Promise((resolve, reject) => {
      let opened = false
      const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/rpc`)
      const next = new RpcPeer((line) => { if (ws.readyState === WebSocket.OPEN) ws.send(line.trimEnd()) })
      ws.onmessage = (message) => next.receive(String(message.data))
      next.onAny((method, params) => {
        // What it offers changed since hello: `has` follows.
        if (method === 'features.changed') setEntry({ features: (params as { features: string[] }).features })
        emit({ machine: 'local', method, params })
      })
      ws.onopen = async () => {
        opened = true
        try {
          const hello = await next.call<Hello>('hello', { client: 'web', version: PROTOCOL_VERSION, features: [...FEATURES] })
          peer = next
          retry = 500
          setEntry({ state: 'connected', label: hello.machine.hostname, machine: { id: hello.machine.id, hostname: hello.machine.hostname }, features: hello.features, error: undefined })
          resolve(next)
        } catch (error) { reject(error) }
      }
      ws.onclose = () => {
        next.close()
        peer = undefined
        setEntry({ state: 'disconnected' })
        reject(new RpcError('disconnected', 'Not connected'))
        const again = () => { setTimeout(connect, retry); retry = Math.min(retry * 2, 10_000) }
        // Refused at the door, or only the network? The socket doesn't say; the daemon does.
        if (opened) return again()
        void admitted().then((ok) => ok === 'ok' ? again() : ask(ok === 'limited' ? LIMITED : `This browser isn’t paired with ${location.hostname}.`), again)
      }
    })
    ready.catch(() => {})
  }
  // Web access had one token, kept here; devices pair now, and it's no longer accepted.
  localStorage.removeItem('superego.webToken')
  const ticket = takeTicket()
  // Calls wait for a ticket to be spent, so the first connection is a paired one.
  const starting = !ticket ? Promise.resolve(connect()) : admitted().catch(() => 'wrong' as const)
    // Paired already (a link opened again): the ticket stays unspent.
    .then((state) => state === 'ok' ? 'ok' : pair({ ticket }))
    .then((paired) => paired === 'ok' ? connect() : ask(paired === 'limited' ? LIMITED : 'That link has expired or was used already.'), () => connect())

  // ── The app's own endpoint, here in the page ───────────────────────────────────────────────────────────────────
  const settings = new SettingsRegistry(store)
  settings.register({
    id: 'appearance', title: 'Appearance', order: 50,
    settings: [
      { key: 'app.font.interface', title: 'Interface font', default: null, type: { type: 'font', nullLabel: 'System' } },
      { key: 'app.font.mono', title: 'Monospace font', default: null, description: 'Code, tool output and paths.', type: { type: 'font', monospace: true, nullLabel: 'System monospace' } },
      { key: 'app.accent', title: 'Accent colour', default: 'color(display-p3 0.155 0.319 0.654)', description: 'Focus rings, primary buttons, links and selection. Any CSS colour.', type: { type: 'color' } },
      LAYOUT_SETTING,
    ],
  })
  settings.register({
    id: 'keyboard', title: 'Keyboard', order: 65,
    settings: [{ key: 'app.keys', title: 'Shortcuts', default: {}, description: 'Every action that runs without asking for more. Click a shortcut and press new keys; ⌫ removes it, Esc keeps it.', type: { type: 'keymap' } }],
  })
  const subs = new Map<string, () => unknown>()
  const served = serveSettings(settings, (params) => emit({ machine: 'app', method: 'settings.changed', params }), subs)
  const appActions = [{ id: 'app.settings.set', title: 'Change an app setting', runs: 'app', expose: ['ui'] }]
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
    // A thread wants a look: a Web Notification, once permission is granted (the notifications extension asks).
    // One per thread (its tag), however many tabs show it; clicking it brings this one forward, showing the thread.
    'app.notify': async ({ machine, thread, title, body }: ThreadNotice) => {
      if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return null
      try {
        const notification = new Notification(title, { body, tag: `${machine}/${thread}` })
        notification.onclick = () => {
          window.focus()
          notification.close()
          emit({ machine: 'app', method: 'app.select', params: { machine, thread } })
        }
      } catch { /* a phone's browser, which shows them only from a service worker */ }
      return null
    },
    'service.get': async () => ({ phase: 'current', busy: false }),
  }

  return {
    async call(machine, method, params) {
      if (machine === 'app') {
        const handler = app[method]
        if (!handler) throw new RpcError('unsupported', `${method} is part of the desktop app`)
        return handler(params as never)
      }
      if (machine !== 'local') throw new RpcError('not_found', `No machine ${machine} here`)
      await starting
      return (peer ?? await ready).call(method, params)
    },
    machines: async () => [entry],
    artifactUrl: (_machine, thread, path) => `/artifact/${encodeURIComponent(thread)}/${path.split('/').map(encodeURIComponent).join('/')}`,
    onEvent(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
    web: true,
  }
}
