import { spawn } from 'node:child_process'
import { mkdirSync, openSync } from 'node:fs'
import { join } from 'node:path'
import { app, BrowserWindow, ipcMain, Notification, session, shell } from 'electron'
import { connectSocket, defaultDataDir, isListening, socketPath } from '@mu/daemon/client'
import { RpcError, type Notifications, type SessionInfo } from '@mu/protocol'
import { serveSettings } from '@mu/settings'
import { CHANNEL, DEFAULT_REMOTE_COMMAND, type CallResult, type MachineConfig, type MachineEntry, type MuEvent } from '../shared.ts'
import { APP, APP_KEYS, createAppSettings } from './app-settings.ts'
import { checkIdentity } from './identity.ts'
import { Link, type Transport } from './link.ts'
import { MachineStore } from './machines.ts'
import { openSsh, openVia } from './ssh.ts'

const dataDir = defaultDataDir()
const socket = socketPath(dataDir)

/** Start the local daemon unless one answers. It is detached: quitting the app leaves agents running. */
async function ensureLocalDaemon() {
  if (await isListening(socket)) return
  mkdirSync(dataDir, { recursive: true })
  const log = openSync(join(dataDir, 'daemon.log'), 'a')
  const child = spawn(process.execPath, [join(import.meta.dirname, 'daemon.js')], {
    detached: true, stdio: ['ignore', log, log], env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  })
  child.unref()
  for (let i = 0; i < 100; i++) {
    if (await isListening(socket)) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`The daemon did not start; see ${join(dataDir, 'daemon.log')}`)
}

async function openLocal(): Promise<Transport> {
  await ensureLocalDaemon()
  const { peer, socket: conn } = await connectSocket(socket)
  return { peer, closed: new Promise((resolve) => conn.once('close', () => resolve())), close: () => conn.destroy() }
}

const broadcast = (event: MuEvent) => {
  for (const window of BrowserWindow.getAllWindows()) window.webContents.send(CHANNEL.event, event)
}

const appSettings = createAppSettings(dataDir)

/** The app's own endpoint: its settings, per window so a closed window's subscriptions go with it. */
const appSubs = new Map<number, Map<string, () => unknown>>()
function appEndpoint(contents: Electron.WebContents) {
  let subs = appSubs.get(contents.id)
  if (!subs) {
    const created = subs = new Map()
    appSubs.set(contents.id, created)
    contents.once('destroyed', () => { for (const stop of created.values()) stop(); appSubs.delete(contents.id) })
  }
  const send = (method: string, params: unknown) => { if (!contents.isDestroyed()) contents.send(CHANNEL.event, { machine: APP, method, params }) }
  const handlers: Record<string, (params: any) => Promise<unknown>> = {
    ...serveSettings(appSettings, (params) => send('settings.changed', params), subs),
    async unwatch({ sub }: { sub: string }) { subs.get(sub)?.(); subs.delete(sub); return null },
    'machines.add': (params: { label?: string; target?: string; command?: string; via?: string }) => machineStore.add(params),
    'machines.update': async ({ id, ...patch }: { id: string } & Partial<MachineConfig>) => { await machineStore.update(id, patch); return null },
    'machines.remove': async ({ id }: { id: string }) => { await machineStore.remove(id); return null },
    'machines.trust': async ({ id }: { id: string }) => { await machineStore.forgetIdentity(id); restartLink(id); return null },
    /** Try a machine that gave up (an incompatible or unexpected daemon) again. */
    'machines.reconnect': async ({ id }: { id: string }) => { if (id === 'local') restartLocal(); else restartLink(id); return null },
  }
  return handlers
}

const links = new Map<string, Link>()
function addLink(link: Link) {
  links.set(link.id, link)
  link.start()
}

/** This computer, then every configured machine; disabled ones have no link. */
const machineStore = new MachineStore(dataDir)
const linkConfig = new Map<string, string>()
function machineEntries(): MachineEntry[] {
  const local = links.get('local')
  return [
    ...(local ? [local.entry()] : []),
    ...machineStore.list().map((config): MachineEntry => {
      const remote = { route: routeOf(config), enabled: config.enabled }
      const link = links.get(config.id)
      return link ? { ...link.entry(), label: config.label, remote } : { id: config.id, label: config.label, state: 'disabled', remote }
    }),
  ]
}
/** How a machine is reached, as the user would type it. */
const routeOf = (config: MachineConfig) => config.via ?? `ssh ${config.target} ${config.command ?? DEFAULT_REMOTE_COMMAND}`

/**
 * A link to a configured machine. Identity is not the route: the first daemon to answer at the target is remembered,
 * and later a different one there is refused until the user trusts it. One machine reached two ways is refused too.
 */
function sshLink(config: MachineConfig) {
  return new Link({
    id: config.id, label: config.label,
    open: () => config.via ? openVia(config.via) : openSsh(config.target, config.command ?? DEFAULT_REMOTE_COMMAND),
    onEvent: (method, params) => onMachineEvent(config.id, method, params),
    verify(hello) {
      const current = machineStore.get(config.id)
      const connected = [...links.values()].filter((other) => other.id !== config.id && other.state === 'connected' && other.hello)
        .map((other) => ({ label: other.label, id: other.hello!.machine.id }))
      checkIdentity(hello, { target: config.via ? 'that command' : config.target, ...(current?.daemonId ? { expected: current.daemonId } : {}) }, connected)
      if (!current?.daemonId) void machineStore.update(config.id, { daemonId: hello.machine.id })
    },
  })
}
function restartLocal() {
  links.get('local')?.stop()
  addLink(new Link({ id: 'local', label: 'This computer', open: openLocal, onEvent: (method, params) => onMachineEvent('local', method, params) }))
}
function restartLink(id: string) {
  links.get(id)?.stop()
  links.delete(id)
  linkConfig.delete(id)
  syncLinks()
}

/** Start, restart or stop links to match the configured machines. */
function syncLinks() {
  const configs = machineStore.list()
  for (const [id, link] of links) {
    if (id === 'local') continue
    const config = configs.find((c) => c.id === id)
    const key = config && routeOf(config)
    if (!config?.enabled || key !== linkConfig.get(id)) { link.stop(); links.delete(id); linkConfig.delete(id) }
  }
  for (const config of configs) {
    if (!config.enabled || links.has(config.id)) continue
    linkConfig.set(config.id, routeOf(config))
    addLink(sshLink(config))
  }
  broadcast({ machine: APP, method: '$machines', params: machineEntries() })
}
machineStore.onChange(syncLinks)

/**
 * Notify when a session out of sight starts wanting a look: it finished, failed or needs the user. The app keeps its
 * own subscription to each machine's sessions for this, whatever the windows show.
 */
const lastStatus = new Map<string, SessionInfo['status']['state']>()
const watchSubs = new Map<string, string>()
function onMachineEvent(machine: string, method: string, params: unknown) {
  if (!links.has(machine)) return
  if (method === '$connection') {
    broadcast({ machine: APP, method: '$machines', params: machineEntries() })
    if ((params as { state: string }).state === 'connected') {
      void (links.get(machine)!.call('sessions.watch', {}) as Promise<{ sub: string; value: SessionInfo[] }>).then(({ sub, value }) => {
        watchSubs.set(machine, sub)
        track(machine, value, false)
      }).catch(() => {})
    }
    return
  }
  if (method === 'sessions.changed') {
    const { sub, value } = params as Notifications['sessions.changed']
    if (watchSubs.get(machine) === sub) track(machine, value, true)
  }
  broadcast({ machine, method, params })
}
function track(machine: string, sessions: SessionInfo[], announce: boolean) {
  for (const session of sessions) {
    const key = `${machine}/${session.id}`
    const before = lastStatus.get(key)
    const now = session.status.state
    lastStatus.set(key, now)
    if (!announce || before === now || !['done', 'error', 'blocked'].includes(now)) continue
    if (BrowserWindow.getFocusedWindow() || !appSettings.get<boolean>(APP_KEYS.notifications) || !Notification.isSupported()) continue
    const label = links.get(machine)?.label ?? machine
    const body = now === 'done' ? 'Finished' : now === 'error' ? `Failed${session.status.msg ? `: ${session.status.msg}` : ''}` : 'Needs you'
    const notification = new Notification({ title: session.title, subtitle: label, body })
    notification.on('click', () => {
      const window = BrowserWindow.getAllWindows()[0] ?? createWindow()
      window.show()
      window.focus()
      window.webContents.send(CHANNEL.event, { machine: APP, method: 'app.select', params: { machine, session: session.id } })
    })
    notification.show()
  }
}

ipcMain.handle(CHANNEL.machines, () => machineEntries())
ipcMain.handle(CHANNEL.call, async (event, machine: string, method: string, params: unknown): Promise<CallResult> => {
  try {
    if (machine === APP) {
      const handler = appEndpoint(event.sender)[method]
      if (!handler) throw new RpcError('unknown_method', `Unknown method ${method}`)
      return { ok: true, result: await handler(params ?? {}) }
    }
    const link = links.get(machine)
    if (!link) throw new RpcError('unknown_machine', `No machine ${machine}`)
    return { ok: true, result: await link.call(method, params) }
  } catch (error) {
    return { ok: false, error: { kind: error instanceof RpcError ? error.kind : 'error', message: error instanceof Error ? error.message : String(error) } }
  }
})

function createWindow() {
  const window = new BrowserWindow({
    width: 1100, height: 760, minWidth: 600, minHeight: 400,
    title: 'mu',
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#09090b',
    show: !process.env.MU_HEADLESS,
    webPreferences: { preload: join(import.meta.dirname, '../preload/preload.cjs'), sandbox: true, contextIsolation: true },
  })
  // Links (sign-in pages, docs) open in the browser, never in the app.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  if (process.env.ELECTRON_RENDERER_URL) void window.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void window.loadFile(join(import.meta.dirname, '../renderer/index.html'))
  return window
}

app.whenReady().then(() => {
  // Font pickers list the installed fonts (the Local Font Access API); nothing else is granted.
  session.defaultSession.setPermissionRequestHandler((_contents, permission, callback) => callback(permission === 'local-fonts'))
  session.defaultSession.setPermissionCheckHandler((_contents, permission) => permission === 'local-fonts')
  restartLocal()
  syncLinks()
  createWindow()
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
})

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
app.on('before-quit', () => { for (const link of links.values()) link.stop() })
