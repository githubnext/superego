// Superego in a browser: the same window as the desktop app, with `window.superego` over a WebSocket to the daemon that served the
// page (its Web access setting), instead of Electron's preload. That daemon is the one machine, "local". What the desktop
// keeps in its main process (the app's own settings) is kept in this browser.
import { FEATURES, PROTOCOL_VERSION, RpcError, RpcPeer, type Hello } from '@superego/protocol'
import { serveSettings, SettingsRegistry, type SettingsStore } from '@superego/settings'
import type { MachineEntry, SuperegoBridge, SuperegoEvent } from '../shared.ts'
import { askToPair, refused, type Paired } from './pair-gate.ts'

const SETTINGS = 'superego.appSettings'

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

/** App settings, kept in localStorage. */
const store: SettingsStore = {
  load: () => { try { return JSON.parse(localStorage.getItem(SETTINGS) ?? '{}') } catch { return {} } },
  save: async (values) => localStorage.setItem(SETTINGS, JSON.stringify(values)),
}

export function webBridge(): SuperegoBridge {
  const listeners = new Set<(event: SuperegoEvent) => void>()
  const emit = (event: SuperegoEvent) => { for (const listener of listeners) listener(event) }
  let entry: MachineEntry = { id: 'local', label: location.hostname, state: 'connecting' }
  const setEntry = (next: Partial<MachineEntry>) => { entry = { ...entry, ...next }; emit({ machine: '$machines', method: '$machines', params: [entry] }) }

  // ── The daemon, over a WebSocket that reconnects ───────────────────────────────────────────────────────────────
  let peer: RpcPeer | undefined
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
      const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/rpc`)
      const next = new RpcPeer((line) => { if (ws.readyState === WebSocket.OPEN) ws.send(line.trimEnd()) })
      ws.onmessage = (message) => next.receive(String(message.data))
      next.onAny((method, params) => emit({ machine: 'local', method, params }))
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
      ws.onclose = (event) => {
        next.close()
        peer = undefined
        setEntry({ state: 'disconnected' })
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
      return (peer ?? await ready).call(method, params)
    },
    machines: async () => [entry],
    artifactUrl: (_machine, thread, path) => `/artifact/${encodeURIComponent(thread)}/${path.split('/').map(encodeURIComponent).join('/')}`,
    onEvent(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
    web: true,
  }
}
