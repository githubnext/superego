import { spawn } from 'node:child_process'
import { mkdirSync, openSync } from 'node:fs'
import { join } from 'node:path'
import { app, BrowserWindow, dialog, ipcMain, Notification, session, shell } from 'electron'
import { defaultDataDir, socketPath } from '@mu/daemon/client'
import { RpcError, type Notifications, type SessionInfo } from '@mu/protocol'
import { serveSettings } from '@mu/settings'
import { CHANNEL, type CallResult, type MachineConfig, type MachineEntry, type MuEvent } from '../shared.ts'
import { APP, APP_KEYS, createAppSettings } from './app-settings.ts'
import { checkIdentity, MachineStore, openLocal as openLocalSocket, openMachine, routeOf } from '@mu/client'
import { Link } from './link.ts'
import { MenuBar } from './tray.ts'

const dataDir = defaultDataDir()
const socket = socketPath(dataDir)

/** Start the local daemon, detached: quitting the app leaves agents running. */
function startDaemon() {
  mkdirSync(dataDir, { recursive: true })
  const log = openSync(join(dataDir, 'daemon.log'), 'a')
  spawn(process.execPath, [join(import.meta.dirname, 'daemon.js')], {
    detached: true, stdio: ['ignore', log, log], env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  }).unref()
}
const openLocal = () => openLocalSocket(socket, startDaemon)

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
    /** How mu sits on the desktop now. */
    async 'app.desktop'() { return { menuBar: menuBar.shown, dockHidden: mac && dockHidden() } },
    /** The page is listening for app events: answer with a session it was asked to show before it was. */
    async 'app.ready'() {
      ready.add(contents.id)
      contents.once('destroyed', () => ready.delete(contents.id))
      const what = pending.get(contents.id)
      pending.delete(contents.id)
      return what ?? {}
    },
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
/**
 * A link to a configured machine. Identity is not the route: the first daemon to answer at the target is remembered,
 * and later a different one there is refused until the user trusts it. One machine reached two ways is refused too.
 */
function sshLink(config: MachineConfig) {
  return new Link({
    id: config.id, label: config.label,
    open: () => openMachine(config),
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
  refreshDesktop()
}
machineStore.onChange(syncLinks)
// The CLI edits the same list; pick up its changes.
machineStore.watch()

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
    refreshDesktop()
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
const sessionsOf = new Map<string, SessionInfo[]>()
function track(machine: string, sessions: SessionInfo[], announce: boolean) {
  sessionsOf.set(machine, sessions)
  refreshDesktop()
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
    notification.on('click', () => show({ open: { machine, session: session.id } }))
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

/**
 * One app per data dir: its Electron state lives in the data dir, so the lock that keeps a second launch from opening
 * a second app is per data dir too. A second launch (`mu`, `mu open`) hands its arguments over and exits.
 */
app.setName('mu')
app.setPath('userData', join(dataDir, 'app'))
const primary = app.requestSingleInstanceLock()
/** Set by the quits that really end the app; any other quit, with the menu bar on, only closes the windows. */
let quitting = !primary
if (!primary) app.quit()

type Open = { machine: string; session: string }
/** `--mu-open=<machine>/<session>`, as `mu` passes it. */
function openArgument(argv: string[]): Open | undefined {
  const value = argv.find((arg) => arg.startsWith('--mu-open='))?.slice('--mu-open='.length)
  const slash = value?.lastIndexOf('/') ?? -1
  return value && slash > 0 ? { machine: value.slice(0, slash), session: value.slice(slash + 1) } : undefined
}

/** What a window should show: a session, or Settings. */
type Show = { open?: Open; settings?: boolean }
/** Windows whose page is listening for app events; until then, what to show waits in `pending`. */
const ready = new Set<number>()
const pending = new Map<number, Show>()
function show(what: Show = {}) {
  const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? createWindow()
  if (window.isMinimized()) window.restore()
  window.show()
  window.focus()
  app.focus({ steal: true })
  if (!what.open && !what.settings) return
  if (!ready.has(window.webContents.id)) return pending.set(window.webContents.id, what)
  if (what.open) window.webContents.send(CHANNEL.event, { machine: APP, method: 'app.select', params: what.open })
  if (what.settings) window.webContents.send(CHANNEL.event, { machine: APP, method: 'app.settings', params: null })
}

app.on('second-instance', (_event, argv) => {
  const open = openArgument(argv)
  show(open ? { open } : {})
})

// ── On the desktop: the menu bar item and the Dock icon ─────────────────────────────────────────────────────────────

const headless = Boolean(process.env.MU_HEADLESS)
const mac = process.platform === 'darwin'
const menuBarOn = () => appSettings.get<boolean>(APP_KEYS.menuBar)
const dockHidden = () => menuBarOn() && appSettings.get<boolean>(APP_KEYS.hideDock)

const menuBar = new MenuBar({
  machines: () => machineEntries(),
  sessions: (machine) => sessionsOf.get(machine) ?? [],
  open: () => show(),
  openSession: (machine, session) => show({ open: { machine, session } }),
  openSettings: () => show({ settings: true }),
  quit: () => { quitting = true; app.quit() },
  quitAndStop: () => void quitAndStop(),
}, headless)

/** The Dock icon shows while a window is open, unless hidden in Settings; with no window it goes, if the menu bar has mu. */
function refreshDesktop() {
  menuBar.update(menuBarOn())
  if (!mac || headless) return
  const windows = BrowserWindow.getAllWindows().length > 0
  if (dockHidden() || (!windows && menuBarOn())) app.dock?.hide()
  else void app.dock?.show()
}
appSettings.onChange(refreshDesktop)

/** Quit, and stop this computer's daemon and its agents too, asking first while any are working. */
async function quitAndStop() {
  const working = (sessionsOf.get('local') ?? []).filter((s) => s.status.state === 'working')
  if (working.length && !headless) {
    const { response } = await dialog.showMessageBox({
      type: 'warning', buttons: ['Stop Agents and Quit', 'Cancel'], defaultId: 0, cancelId: 1,
      message: `${working.length === 1 ? 'An agent is' : `${working.length} agents are`} still working`,
      detail: 'Stopping the background process ends their work. Quitting mu alone leaves them running.',
    })
    if (response !== 0) return
  }
  const pid = links.get('local')?.hello?.machine.pid
  quitting = true
  for (const link of links.values()) link.stop()
  if (pid) try { process.kill(pid, 'SIGTERM') } catch {}
  app.quit()
}

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
  window.on('closed', () => refreshDesktop())
  if (process.env.ELECTRON_RENDERER_URL) void window.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void window.loadFile(join(import.meta.dirname, '../renderer/index.html'))
  refreshDesktop()
  return window
}

app.whenReady().then(() => {
  if (!primary) return
  if (headless) app.dock?.hide()
  // Font pickers list the installed fonts (the Local Font Access API); nothing else is granted.
  session.defaultSession.setPermissionRequestHandler((_contents, permission, callback) => callback(permission === 'local-fonts'))
  session.defaultSession.setPermissionCheckHandler((_contents, permission) => permission === 'local-fonts')
  restartLocal()
  syncLinks()
  const window = createWindow()
  const open = openArgument(process.argv)
  if (open) pending.set(window.webContents.id, { open })
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
})

// With the menu bar on, mu stays there without windows; without it, closing the last window quits (except on macOS).
app.on('window-all-closed', () => {
  refreshDesktop()
  if (!mac && !menuBarOn()) app.quit()
})
app.on('before-quit', (event) => {
  // ⌘Q with the menu bar on closes the windows; the menu bar's Quit ends the app.
  if (menuBarOn() && !quitting && !headless) {
    event.preventDefault()
    for (const window of BrowserWindow.getAllWindows()) window.close()
    return
  }
  for (const link of links.values()) link.stop()
})
process.on('SIGTERM', () => { quitting = true; app.quit() })
