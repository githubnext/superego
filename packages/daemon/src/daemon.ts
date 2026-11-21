// The Superego daemon: one per user per machine. It owns a pi-durable Harness on SQLite, the thread catalog, and every
// live subscription. Clients (the Electron app, the CLI, a remote app over ssh) speak the protocol in @superego/protocol.
//
// openDaemon puts it together from its parts, each a module of its own sharing one `Host` (host.ts): the extension host
// (extension-host.ts), the profile host (profile-host.ts), the threads (threads.ts), the core's actions (actions.ts),
// each connection's methods (handlers.ts), and Web access (web-access.ts).
import { randomUUID } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import { homedir, hostname, platform } from 'node:os'
import { join, resolve as resolvePath } from 'node:path'
import { createRegistry, Harness, type Storage } from '@earendil-works/pi-durable'
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node'
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node'
import { AUTH_REJECTED, Lifetime, ONBOARDED, createRouter, threadEnv, type AppConfig, type MachineInfo, type RpcPeer } from '@superego/protocol'
import { SettingsRegistry, type SettingsStore } from '@superego/settings'
import { FileSettingsStore } from '@superego/settings/file'
import { registerCoreActions } from './actions.ts'
import { createAgentSettings, type LocalServer } from './agent-settings.ts'
import { createAuthFlows } from './auth-flows.ts'
import { readCommit } from './build.ts'
import { Clients, type Via } from './clients.ts'
import { coreExtensions } from './core-extensions.ts'
import { whereYouRun } from './where.ts'
import { createExtensionHost } from './extension-host.ts'
import type { DaemonExtension } from './extension.ts'
import { threadFiles } from './files.ts'
import { createWindowImages } from './window-images.ts'
import { serveClient } from './handlers.ts'
import { context, type DaemonContext, type Host } from './host.ts'
import { createProfileHost } from './profile-host.ts'
import { Allowances, provideSdk } from './profiles.ts'
import { ProfileSources } from './profile-sources.ts'
import { createRelay, type MachineReach } from './relay.ts'
import * as sdk from './sdk.ts'
import { keepsRunning } from './service.ts'
import { createThreads } from './threads.ts'
import { Values } from './values.ts'
import { openWebAccess } from './web-access.ts'
import { writeOnce } from './write-atomic.ts'

export { OUTSIDE_THREADS } from './actions.ts'
export type { DaemonContext }

export type DaemonOptions = {
  app: AppConfig
  dataDir: string
  /** Defaults to `settings.json` in `dataDir`. */
  settingsStore?: SettingsStore
  /** Defaults to SQLite in `dataDir`. */
  storage?: Storage
  /** The app's extensions (their daemon halves), set up in order. */
  extensions?: DaemonExtension[]
  /** Where threads work when created without a cwd. */
  defaultCwd?: string
  /** The build of the code running, reported in `hello`. */
  build?: string
  /** The git commit of the code running, reported in `hello`; defaults to this checkout's (none outside git). */
  commit?: { commit: string; committedAt: number } | null
  /** Called once a restart was accepted and answered, with what to add to the successor's environment; the host closes the daemon and exits. */
  onRestart?: (env: Record<string, string>) => void
  /** The app's window build (index.html and assets), served to browsers when Web access is on. */
  webRoot?: string
  /** The folder agents share: skills in `skills/`, standing instructions in `AGENTS.md`. Defaults to `~/.agents`. */
  agentsDir?: string
  /**
   * How long an extension's `setup` (and a profile's modules loading) may take, in ms, before it's given up on and torn
   * down, so one that hangs doesn't hold up every profile after it. 15s by default.
   */
  setupTimeout?: number
  /** How long an extension's `agentParts` may take at submit, in ms, before the turn goes on without its parts. 5s by default. */
  agentPartsLimit?: number
  /**
   * The other machines this daemon reaches (see relay.ts), given its own identity so it never links to itself. The host
   * builds it from @superego/client (the app's daemon: `machineHub`); without it, this daemon reaches only itself.
   */
  reach?: (self: MachineInfo) => MachineReach
  /** The user's login shell's environment, for keys the daemon's own lacks (login-env.ts); unset, its own only. */
  loginEnv?: () => Promise<Record<string, string>>
  /** The local model servers first-run setup looks for (Ollama's and LM Studio's usual addresses unset). */
  localServers?: LocalServer[]
}

export type Daemon = {
  machine: MachineInfo
  settings: SettingsRegistry
  /**
   * Register this daemon's methods on a connection's peer; returns a cleanup for when it disconnects. `via`: what the
   * transport knows of it. `hangUp` closes the transport, for a peer that stopped answering its heartbeat.
   */
  serve(peer: RpcPeer, transport?: { via?: Via; hangUp?: () => void }): () => void
  /**
   * Settles once the profiles of the threads in use, loaded in the background as it starts, are loaded (or failed to,
   * which is logged): from then on, what it offers (`hello`'s extensions) has theirs.
   */
  profilesLoaded: Promise<void>
  close(): Promise<void>
}

/**
 * This machine's identity, created once and kept in the data dir: two daemons starting at once agree on whichever
 * wrote it first (see writeOnce).
 */
async function machineId(dataDir: string) {
  const path = join(dataDir, 'machine-id')
  const existing = (await readFile(path, 'utf8').catch(() => '')).trim()
  if (existing) return existing
  await writeOnce(path, randomUUID())
  return (await readFile(path, 'utf8')).trim()
}

export async function openDaemon(options: DaemonOptions): Promise<Daemon> {
  // Started from an agent's shell (a command line there started it), it isn't that agent's: nothing it runs (a terminal
  // pane, an MCP server) carries that thread's mark, and its threads' shells get their own.
  delete process.env[threadEnv(options.app)]
  await mkdir(options.dataDir, { recursive: true, mode: 0o700 })
  const settings = new SettingsRegistry(options.settingsStore ?? new FileSettingsStore(join(options.dataDir, 'settings.json')))
  const flows = createAuthFlows()
  const agent = await createAgentSettings(settings, options.dataDir, options.app, flows, {
    ...(options.loginEnv ? { loginEnv: options.loginEnv } : {}), ...(options.localServers ? { localServers: options.localServers } : {}),
  })
  // Profiles and their extensions import from 'superego'; this is what they get.
  provideSdk({ ...sdk })
  const defaultCwd = options.defaultCwd ?? process.cwd()
  const setupTimeout = options.setupTimeout ?? 15_000
  const listeners = new Set<() => void>()
  let queued = false
  const host: Host = {
    options, settings, agent, flows,
    router: createRouter<DaemonContext>(),
    registry: createRegistry(),
    values: new Values(),
    mounted: new Map(),
    changed() {
      if (queued) return
      queued = true
      queueMicrotask(() => { queued = false; for (const listener of listeners) listener() })
    },
    onChanged(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    state: { restarting: false, closing: false },
    defaultCwd,
    folderOf: (cwd) => cwd?.trim() ? resolvePath(cwd.trim().replace(/^~(?=\/|$)/, homedir())) : defaultCwd,
    // The folder agents share: standing instructions in AGENTS.md (see agents-md.ts), and the skills extension's skills.
    agentsDir: options.agentsDir ?? join(homedir(), '.agents'),
    profileSources: new ProfileSources(options.dataDir),
    allowances: new Allowances(options.dataDir),
    profileKeys: new Map(),
    setupTimeout,
    inTime: setupTimeout < 1000 ? `${setupTimeout}ms` : `${Math.round(setupTimeout / 1000)}s`,
  }
  const { mounted } = host

  // The parts, each reaching those made after it as it needs them.
  const extensions = createExtensionHost(host, { profiles: () => profiles, threads: () => threads, relay: () => relay })
  const profiles = createProfileHost(host, extensions, { threads: () => threads })
  const storage = options.storage ?? await openNodeSqliteStorage(join(options.dataDir, `${options.app.id}.sqlite`))
  const harness = await Harness.open(storage, {
    models: agent.models,
    registry: host.registry,
    // Attribution names the app to providers that show it; without a url there is nothing to show.
    identity: { attribution: options.app.url ? { name: options.app.name, url: options.app.url } : null },
    // An agent's commands run marked with its thread (<ID>_THREAD): the command line, run there, says so (see threadEnv).
    env: ({ cwd, conversationId }) => new NodeExecutionEnv({ cwd: cwd ?? defaultCwd, shellEnv: { [threadEnv(options.app)]: threads.threadOf(conversationId) ?? `conversation-${conversationId}` } }),
    // A thread without a profile selects the built-ins only: profiles' extensions are installed too, but are theirs.
    settings: () => ({ extensions: extensions.partsFor(extensions.withoutFor()) }),
  }, context)
  const threads = createThreads(host, { harness, extensions, profiles })
  const files = threadFiles({ cwdOf: async (id) => (await threads.get(id)).meta.cwd })
  const images = createWindowImages({ dataDir: options.dataDir, processor: agent.images.processor, file: files.resolve, block: threads.imageBlock })

  const machine: MachineInfo = {
    id: await machineId(options.dataDir), hostname: hostname(), platform: platform(), pid: process.pid, dataDir: options.dataDir,
    build: options.build ?? 'dev',
    ...(options.commit === undefined ? readCommit(import.meta.dirname) : options.commit ?? {}),
  }
  // Whether this daemon outlives a logout, for hello: asked now, then again in the background at most once a minute,
  // so hello never waits on loginctl.
  let keeps = { at: Date.now(), value: await keepsRunning(options.app), asking: false }
  const kept = () => {
    if (Date.now() - keeps.at > 60_000 && !keeps.asking) {
      keeps.asking = true
      void keepsRunning(options.app).then((value) => { keeps = { at: Date.now(), value, asking: false } }, () => { keeps = { ...keeps, at: Date.now(), asking: false } })
    }
    return keeps.value
  }
  /** Who is connected, for `clients.watch` and the action log (see clients.ts). */
  const clients = new Clients({ hostname: machine.hostname, windowKinds: [`${options.app.id}-app`, 'web'] })
  /** The daemon's own: what it set up for its life (the bundled extensions), undone as it closes. */
  const daemonLife = new Lifetime('The daemon')
  // The other machines, reached through links this daemon keeps (see relay.ts); this one first, as 'local'.
  const relay = createRelay(options.reach?.(machine), () => ({
    id: 'local', label: machine.hostname, state: 'connected', machine: { id: machine.id, hostname: machine.hostname }, ...extensions.offer(),
    keepsRunning: kept(),
  }))
  daemonLife.add(() => relay.close())
  const { outsideMayStart } = registerCoreActions(host, { harness, machine, threads, profiles, files, relay })

  // The core's own, then the bundled ones: for the daemon's life, each giving every thread its agent parts unless the
  // thread goes without it.
  const core = coreExtensions({ agentsDir: host.agentsDir, where: () => whereYouRun(machine.hostname, clients.windows()), panesOf: extensions.panesOf, openPane: threads.openPane, images: agent.images.processor, note: threads.note })
  for (const extension of core) daemonLife.add(await extensions.setUpBuiltin(extension, 'core'))
  for (const extension of options.extensions ?? []) daemonLife.add(await extensions.setUpBuiltin(extension, 'bundled'))
  extensions.registerSwitches()

  // Mount everything once so statuses (and anything a previous process left running) are live from the start; and
  // learn which thread each subagent's conversation is of, before any resumed run asks.
  await threads.learnConversations()
  await threads.list()
  await threads.list({ hidden: true })
  // A run cut off by the last stop resumes where it was, maybe inside a profile's tool: its profile is loaded first, so
  // the tool is there to carry on with (a profile that no longer loads leaves the run to end as interrupted).
  // One whose profile moved meanwhile runs it from where it is now.
  for (const [id, m] of mounted) {
    if (!m.live?.run || !m.meta.profile) continue
    const ref = await threads.rebound(id).catch((error: Error) => { console.error(`Thread ${id}: ${error.message}`); return m.meta.profile! })
    if (ref) await profiles.profileOf(ref).catch((error: Error) => console.error(`Profile ${ref.name}: ${error.message}`))
  }
  harness.resume()
  // Waiting on threads gone since (deleted, say) no longer; a provider whose credentials changed while the daemon was
  // down is retried. Then the value says which are rejected (ProviderRejection[]), as it keeps saying.
  for (const rejection of agent.rejections.all()) for (const id of Object.keys(rejection.threads)) if (!mounted.has(id)) agent.rejections.release(id)
  for (const provider of agent.changedSinceRejected()) void threads.retrySignIn(provider)
  const setRejected = host.values.core(AUTH_REJECTED, null)
  let rejectedJson = ''
  const publishRejected = () => {
    const now = threads.rejectedNow()
    const json = JSON.stringify(now)
    if (json === rejectedJson) return
    rejectedJson = json
    setRejected(now)
  }
  publishRejected()
  daemonLife.add(host.onChanged(publishRejected))
  daemonLife.add(agent.rejections.onChange(host.changed))
  daemonLife.add(agent.onCredentials((provider) => void threads.retrySignIn(provider)))
  // The profiles of the threads in use, loaded in the background: their facts and what they go without show without
  // waiting for a turn. An archived thread's load when it's brought back.
  const loadingProfiles = (async () => {
    // Those whose profile moved while the daemon was down are bound to where it is now first (see rebound).
    for (const [id, m] of mounted) {
      if (!m.meta.archived && m.meta.profile) await threads.rebound(id).catch((error: Error) => console.error(`Thread ${id}: ${error.message}`))
    }
    const refs = new Map([...mounted.values()].filter((m) => !m.meta.archived && m.meta.profile).map((m) => [m.meta.profile!.dir, m.meta.profile!]))
    for (const ref of refs.values()) await profiles.profileOf(ref).catch((error: Error) => console.error(`Profile ${ref.name}: ${error.message}`))
  })()

  const daemon: Daemon = {
    machine,
    settings,
    profilesLoaded: loadingProfiles,
    serve: (peer, transport = {}) => serveClient(peer, transport, {
      host, machine, keepsRunning: kept, clients, relay, extensions, profiles, threads, files, images, outsideMayStart,
    }),
    async close() {
      host.state.closing = true
      await loadingProfiles
      // Deaf to settings first: a change from here on starts nothing.
      extensions.close()
      await webAccess.close()
      // Profiles' extensions first, then the bundled ones: each step tried whatever the others did.
      profiles.unloadAll()
      const disposed = daemonLife.dispose()
      flows.close()
      for (const m of mounted.values()) await m.stop()
      // Runs stopped before extensions' work is waited for: a tool call cut off as its extension ends was interrupted.
      await harness.close(context)
      // Their work still finishing (a write, a process stopping): those torn down before (a profile reloaded) too.
      await disposed
      await extensions.ended()
      // Then what's saved last: nothing writes in the data folder once this resolves.
      await agent.close()
      await settings.close()
      await agent.rejections.saved()
    },
  }

  settings.register({ id: 'clients', title: 'Connected', order: 85, ui: 'clients', settings: [], description: 'Who is using this machine right now.' })
  // Whether first-run setup was done (or skipped) here.
  settings.register({
    id: 'onboarding', title: 'Onboarding',
    settings: [{ key: ONBOARDED, title: 'Setup done', default: false, type: { type: 'boolean' }, hidden: () => true }],
  })
  const webAccess = await openWebAccess({
    options, settings, router: host.router, clients, relay, serve: daemon.serve, cwdOf: async (id) => (await threads.get(id)).meta.cwd,
  })
  return daemon
}
