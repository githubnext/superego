// The machines, as the app's main process has them: a link to this computer's daemon (started if need be, and
// outliving the app) and to every enabled machine in `machines.json` (see @superego/client's links.ts); what they say,
// passed on; the threads each has, which the app follows whatever the windows show; updating another machine's
// Superego; the profile UIs from other machines this computer lets run in its windows; and the actions on all of it.
import { hostname } from 'node:os'
import { join } from 'node:path'
import type { BrowserWindow } from 'electron'
import { daemonStarting, socketPath, spawnDaemon } from '@superego/daemon/client'
import { Link, loginInTerminal, MachineLinks, MachineStore, openLocal, runUpdate, UiAllowStore } from '@superego/client'
import {
  arr, AUTH_REJECTED, compareVersions, defineAction, int, lit, obj, opt, RpcError, str, union, bool,
  type AppConfig, type Notifications, type ProfileRef, type ProviderRejection, type Router, type ThreadInfo,
} from '@superego/protocol'
import type { MachineConfig, MachineEntry, MachineUpdate, SuperegoEvent } from '../shared/bridge.ts'
import { APP } from '../shared/app-settings.ts'
import type { AppActionContext } from './app-endpoint.ts'
import { agentsAre, confirm } from './dialogs.ts'
import { createSignInCatcher } from './sign-in-callback.ts'
import { waitUntil } from './wait.ts'

/** Its callbacks are never called while it's being made: what they reach may be made after it. */
export type MachinesOptions = {
  app: AppConfig
  dataDir: string
  headless: boolean
  /** Tell every window. */
  broadcast(event: SuperegoEvent): void
  /** A machine's notification for the windows (the ones followed here are handled here first). */
  onEvent(machine: string, method: string, params: unknown): void
  /** The machines changed: one came, went or changed state, or an update said more. */
  changed(): void
  /** A machine's link connected, or gave up, or dropped. */
  connection(machine: string): void
  /** A machine's threads, as the app now knows them: on (re)connecting, and as they change. */
  threads(machine: string, threads: ThreadInfo[]): void
  /** A machine's providers that rejected its credentials (`auth.rejected`), as for `threads`. */
  rejected(machine: string, rejections: ProviderRejection[]): void
}

export type Machines = ReturnType<typeof createMachines>

export function createMachines({ app: appConfig, dataDir, headless, broadcast, onEvent, changed, connection, threads: tracked, rejected }: MachinesOptions) {
  const socket = socketPath(appConfig, dataDir)
  /** Start the local daemon, detached (quitting the app leaves agents running), unless one is on its way. */
  function startDaemon(): () => boolean {
    const starting = () => daemonStarting(dataDir)
    if (starting()) return starting
    return spawnDaemon(dataDir, [process.execPath, join(import.meta.dirname, 'daemon.js')], { ...process.env, ELECTRON_RUN_AS_NODE: '1' })
  }

  /** This computer's daemon, and a link to every enabled machine in `machines.json`. */
  let local: Link | undefined
  const store = new MachineStore(dataDir)
  const remotes = new MachineLinks({
    app: appConfig, dataDir, store, client: `${appConfig.id}-app`, clientLabel: hostname(),
    onEvent: (machine, method, params) => heard(machine, method, params),
    // The local daemon is a machine connected already: a configured one that turns out to be it is refused.
    others: () => local?.state === 'connected' && local.hello ? [{ label: local.label, id: local.hello.machine.id }] : [],
    onChange: changed,
  })
  const linkOf = (id: string) => id === 'local' ? local : remotes.get(id)
  const allLinks = () => [...(local ? [local] : []), ...remotes.list()]
  /** Each machine's last Update: running, or how it ended, with what it printed. */
  const updates = new Map<string, MachineUpdate>()

  /** This computer, then every configured machine; disabled ones have no link. */
  function entries(): MachineEntry[] {
    const here = local?.entry()
    return [
      ...(here ? [here] : []),
      ...remotes.entries().map((entry): MachineEntry => {
        // Said of a machine that answered once: one never reached runs nothing we know of.
        const drift = entry.version && compareVersions(here?.version, entry.version)
        const update = updates.get(entry.id)
        return { ...entry, ...(drift ? { drift } : {}), ...(update ? { update } : {}) }
      }),
    ]
  }
  function restartLocal() {
    local?.stop()
    const link: Link = new Link({
      id: 'local', label: 'This computer', client: `${appConfig.id}-app`, clientLabel: hostname(), open: () => openLocal(socket, startDaemon),
      onEvent: (method, params) => { if (local === link) heard('local', method, params) },
    })
    local = link
    link.start()
  }
  /** Reconnect a machine here, and the local daemon's own link there (it reaches the machines too), when it has one. */
  function restartLink(id: string) {
    remotes.restart(id)
    if (local?.state === 'connected') void local.call('machine.reconnect', { id }).catch(() => {})
  }

  /**
   * The profile UIs from other machines this computer lets run in its windows, for the exact sources allowed. The
   * window hashes what a machine serves and asks; a machine has no say. The CLI allows too (`profile allow-ui`).
   */
  const uiAllowed = new UiAllowStore(dataDir)
  uiAllowed.onChange(() => {
    broadcast({ machine: APP, method: 'profileUi.allowed', params: uiAllowed.list() })
    broadcast({ machine: APP, method: 'profileUi.declined', params: uiAllowed.declinedList() })
  })
  uiAllowed.watch()

  /**
   * Each machine's threads, followed whatever the windows show: for the menu bar, the app icon and notifications; and
   * its rejected providers, for notifications.
   */
  const threadsOf = new Map<string, ThreadInfo[]>()
  const watchSubs = new Map<string, string>()
  const rejectedSubs = new Map<string, string>()
  const track = (machine: string, threads: ThreadInfo[]) => {
    threadsOf.set(machine, threads)
    tracked(machine, threads)
  }
  const signIns = createSignInCatcher((machine, params) => linkOf(machine)?.call('auth.respond', params) ?? Promise.resolve())
  function heard(machine: string, method: string, params: unknown) {
    if (!linkOf(machine)) return
    if (method === '$connection') {
      changed()
      connection(machine)
      if ((params as { state: string }).state === 'connected') {
        void (linkOf(machine)!.call('threads.watch', {}) as Promise<{ sub: string; value: ThreadInfo[] }>).then(({ sub, value }) => {
          watchSubs.set(machine, sub)
          track(machine, value)
        }).catch(() => {})
        void (linkOf(machine)!.call('value.watch', { key: AUTH_REJECTED }) as Promise<{ sub: string; value: ProviderRejection[] | null }>).then(({ sub, value }) => {
          rejectedSubs.set(machine, sub)
          rejected(machine, value ?? [])
        }).catch(() => {})
      }
      return
    }
    if (method === 'value.changed') {
      const { sub, value } = params as Notifications['value.changed']
      if (rejectedSubs.get(machine) === sub) rejected(machine, (value ?? []) as ProviderRejection[])
    }
    if (method === 'threads.changed') {
      const { sub, value } = params as Notifications['threads.changed']
      if (watchSubs.get(machine) === sub) track(machine, value)
    }
    // Another computer's sign-in: its browser redirect comes back here (sign-in-callback.ts).
    if (method === 'auth.event' && machine !== 'local') {
      const { flow, event } = params as Notifications['auth.event']
      signIns.heard(machine, flow, event)
    }
    onEvent(machine, method, params)
  }
  const threads = (machine: string) => threadsOf.get(machine) ?? []
  const working = (machine: string) => threads(machine).filter((t) => t.status.state === 'working')

  /** Tell windows how updates go, a few times a second at most: the install prints a lot. */
  let updatesQueued = false
  const publishUpdates = () => {
    if (updatesQueued) return
    updatesQueued = true
    setTimeout(() => { updatesQueued = false; changed() }, 150)
  }

  /**
   * Run a machine's own install script there (pull, install, build, restart its daemon), its output shown on the
   * machine's row as it goes, then reconnect to the new daemon. The restart interrupts agents at work there: asked
   * first, on `window` when given.
   */
  async function update(id: string, window?: BrowserWindow): Promise<{ updated: boolean }> {
    const config = store.get(id)
    if (!config) throw new RpcError(id === 'local' ? 'invalid' : 'not_found', id === 'local' ? `This computer's ${appConfig.name} is updated by hand.` : `No machine ${id}`)
    if (updates.get(id)?.state === 'running') throw new RpcError('busy', `${config.label} is updating already.`)
    const busy = working(id).length
    if (busy && !headless && !await confirm({
      type: 'warning', buttons: ['Update and Restart', 'Cancel'], defaultId: 1, cancelId: 1,
      message: `${agentsAre(busy)} working on ${config.label}`,
      detail: `Updating restarts ${appConfig.name} there: agents stop mid-turn and pick up again after. Threads and their history are kept.`,
    }, window)) return { updated: false }
    const pid = linkOf(id)?.hello?.machine.pid
    const update: MachineUpdate = { state: 'running', log: '' }
    const set = (patch: Partial<MachineUpdate>) => { updates.set(id, Object.assign(update, patch)); publishUpdates() }
    set({})
    try {
      await runUpdate(config, appConfig, { now: busy > 0, onOutput: (text) => set({ log: (update.log + text).slice(-20_000) }) })
      // The daemon there restarted: reach the new one now, rather than when the old link notices.
      restartLink(id)
      await waitUntil(() => {
        const link = linkOf(id)
        return link?.state === 'connected' && link.hello && link.hello.machine.pid !== pid ? true : undefined
      }, 60_000, new RpcError('update_failed', `Updated, but ${config.label} did not answer again.`))
      set({ state: 'done' })
      return { updated: true }
    } catch (error) {
      set({ state: 'failed', error: error instanceof Error ? error.message : String(error) })
      throw error
    }
  }

  /** The actions on machines, and on the profile UIs they serve. */
  function registerActions(router: Router<AppActionContext>) {
    router.register(defineAction({
      id: 'machine.add', title: 'Add a machine', runs: 'app', expose: ['ui', 'cli'],
      params: obj({ label: opt(str()), target: opt(str()), command: opt(str()), via: opt(str()) }),
      run: (params) => store.add(params),
    }))
    router.register(defineAction({
      id: 'machine.edit', title: 'Change a machine', runs: 'app', expose: ['ui', 'cli'],
      params: obj({ id: str(), label: opt(str()), target: opt(str()), command: opt(str()), via: opt(str()), enabled: opt(bool()) }),
      async run({ id, ...patch }) { await store.update(id, patch as Partial<MachineConfig>); return null },
    }))
    router.register(defineAction({
      id: 'machine.remove', title: 'Remove a machine', runs: 'app', expose: ['ui', 'cli'],
      params: obj({ id: str() }),
      async run({ id }) { await store.remove(id); await uiAllowed.revoke(id); return null },
    }))
    const uiSource = obj({
      machine: str(), profile: obj({ scope: union([lit('user'), lit('project')]), name: str(), dir: str() }), hash: str(),
      files: arr(obj({ path: str(), size: int() })),
    })
    router.register(defineAction({
      id: 'profile.allowUi', title: "Let a machine's profile UI run in this window", runs: 'app', expose: ['ui'],
      params: uiSource,
      async run({ machine, profile, hash, files }) {
        // This computer's own profiles are its daemon's to allow.
        if (!store.get(machine)) throw new RpcError('not_found', `No machine ${machine}`)
        await uiAllowed.allow({ machine, profile: profile as ProfileRef, hash, files })
        return null
      },
    }))
    router.register(defineAction({
      id: 'profile.declineUi', title: "Not now: don't ask about a machine's profile UI again until it changes", runs: 'app', expose: ['ui'],
      params: uiSource,
      async run({ machine, profile, hash, files }) {
        if (!store.get(machine)) throw new RpcError('not_found', `No machine ${machine}`)
        await uiAllowed.decline({ machine, profile: profile as ProfileRef, hash, files })
        return null
      },
    }))
    router.register(defineAction({
      id: 'profile.revokeUi', title: "Revoke a machine's profile UI in this app's windows", runs: 'app', expose: ['ui'],
      params: obj({ machine: str(), dir: str() }),
      async run({ machine, dir }) { await uiAllowed.revoke(machine, dir); return null },
    }))
    router.register(defineAction({
      id: 'machine.trust', title: 'Trust the machine answering now', runs: 'app', expose: ['ui', 'cli'],
      params: obj({ id: str() }),
      async run({ id }) { await store.forgetIdentity(id); restartLink(id); return null },
    }))
    router.register(defineAction({
      id: 'machine.reconnect', title: 'Reconnect a machine', runs: 'app', expose: ['ui', 'cli'],
      params: obj({ id: str() }),
      run({ id }) { if (id === 'local') restartLocal(); else restartLink(id); return null },
    }))
    router.register(defineAction({
      id: 'machine.login', title: 'Log in to a machine', runs: 'app', expose: ['ui', 'cli'],
      params: obj({ id: str() }),
      /** Opens a terminal where ssh may ask for what it needs, and reconnects once it has left a login behind. Headless: no terminal. */
      run({ id }) {
        const config = store.get(id)
        if (!config) throw new RpcError('not_found', `No machine ${id}`)
        if (headless) throw new RpcError('headless', 'No terminal is opened in headless mode')
        void loginInTerminal(config, { dataDir }).done.then((up) => { if (up) restartLink(id) })
        return null
      },
    }))
  }

  return {
    /** Link up: this computer's daemon, and every enabled machine. */
    start() { restartLocal(); remotes.follow() },
    /** The link to this computer's daemon. */
    local: () => local,
    linkOf, allLinks, entries, restartLocal, threads, working, update, registerActions, uiAllowed,
    /** Every machine's threads, of the machines there are links to. */
    allThreads: () => [...threadsOf].flatMap(([machine, list]) => linkOf(machine) ? list.map((thread) => ({ machine, thread })) : []),
    /** Let every link go, and stop catching sign-ins: the app is quitting. */
    stop() { signIns.close(); for (const link of allLinks()) link.stop() },
  }
}
