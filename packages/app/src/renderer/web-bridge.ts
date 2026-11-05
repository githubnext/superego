// mu in a browser: the same window as the desktop app, with `window.mu` over a WebSocket to the daemon that served the
// page (its Web access setting), instead of Electron's preload. That daemon is the one machine, "local". What the desktop
// keeps in its main process (the app's own settings) is kept in this browser.
import { FEATURES, PROTOCOL_VERSION, RpcError, RpcPeer, type Hello } from '@mu/protocol'
import { serveSettings, SettingsRegistry, type SettingsStore } from '@mu/settings'
import type { MachineEntry, MuBridge, MuEvent } from '../shared.ts'

const TOKEN = 'mu.webToken'
const SETTINGS = 'mu.appSettings'

/** The page's token: from the address Settings showed (`#token=…`), kept in this browser, then out of the address bar. */
function takeToken(): string | undefined {
  const hash = new URLSearchParams(location.hash.slice(1))
  const given = hash.get('token')
  if (given) {
    localStorage.setItem(TOKEN, given)
    history.replaceState(null, '', location.pathname + location.search)
  }
  return given ?? localStorage.getItem(TOKEN) ?? undefined
}

/** App settings, kept in localStorage. */
const store: SettingsStore = {
  load: () => { try { return JSON.parse(localStorage.getItem(SETTINGS) ?? '{}') } catch { return {} } },
  save: async (values) => localStorage.setItem(SETTINGS, JSON.stringify(values)),
}

export function webBridge(): MuBridge {
  const listeners = new Set<(event: MuEvent) => void>()
  const emit = (event: MuEvent) => { for (const listener of listeners) listener(event) }
  const token = takeToken()
  let entry: MachineEntry = { id: 'local', label: location.hostname, state: 'connecting' }
  const setEntry = (next: Partial<MachineEntry>) => { entry = { ...entry, ...next }; emit({ machine: '$machines', method: '$machines', params: [entry] }) }

  // ── The daemon, over a WebSocket that reconnects ───────────────────────────────────────────────────────────────
  let peer: RpcPeer | undefined
  let ready: Promise<RpcPeer>
  let retry = 500
  const connect = () => {
    ready = new Promise((resolve, reject) => {
      if (!token) {
        setEntry({ state: 'disconnected', error: 'Open the address shown in Settings → Web access on the machine (it carries a token).' })
        return reject(new RpcError('unauthorized', 'No token'))
      }
      const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/rpc?token=${encodeURIComponent(token)}`)
      const next = new RpcPeer((line) => { if (ws.readyState === WebSocket.OPEN) ws.send(line.trimEnd()) })
      ws.onmessage = (message) => next.receive(String(message.data))
      next.onAny((method, params) => emit({ machine: 'local', method, params }))
      ws.onopen = async () => {
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
        setEntry({ state: 'disconnected', ...(event.code === 1006 && !entry.machine ? { error: 'Not allowed: open the address with its token again.' } : {}) })
        reject(new RpcError('disconnected', 'Not connected'))
        setTimeout(connect, retry)
        retry = Math.min(retry * 2, 10_000)
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
    onEvent(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
    web: true,
  }
}
