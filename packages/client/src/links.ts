// The links to the machines in `machines.json`, kept in step with the file: one per enabled machine, started, stopped or
// restarted as its route changes. Identity is not the route: the first daemon to answer at a target is remembered, and
// later a different one there is refused until the user trusts it; one machine reached two ways is refused too. The
// app's main process keeps one set, and so does a daemon that reaches the others (see hub.ts).
import { RpcError, type AppConfig } from '@superego/protocol'
import { checkIdentity } from './identity.ts'
import { Link, type LinkOptions } from './link.ts'
import type { MachineStore } from './machines.ts'
import { routeOf, type MachineConfig, type MachineEntry } from './shared.ts'
import { openMachine } from './transports.ts'

export type MachineLinksOptions = {
  app: AppConfig
  /** Where ssh's shared login (ControlMaster) lives: the data dir. */
  dataDir: string
  store: MachineStore
  /** What the links say they are in hello. */
  client: string
  clientLabel?: string
  onEvent(machine: string, method: string, params: unknown): void
  /** The set of links changed (one started, stopped or restarted). */
  onChange?(): void
  /** Daemons reached some other way, which none of these may be too: the app's own local link. */
  others?(): { label: string; id: string }[]
  /** The daemon keeping these links, which never links to itself. */
  self?: string
  heartbeat?: LinkOptions['heartbeat']
}

export class MachineLinks {
  #options: MachineLinksOptions
  #links = new Map<string, Link>()
  /** The route each link was started on: a changed route is a new link. */
  #routes = new Map<string, string>()
  /** Each link's config as it started, so one that gave up (a stranger answered, say) tries again once it changes. */
  #configs = new Map<string, string>()
  #closed = false

  constructor(options: MachineLinksOptions) {
    this.#options = options
  }

  get(id: string): Link | undefined { return this.#links.get(id) }
  list(): Link[] { return [...this.#links.values()] }

  /** Every configured machine, linked or not (disabled ones have no link). */
  entries(): MachineEntry[] {
    return this.#options.store.list().map((config): MachineEntry => {
      const remote = { route: routeOf(config, this.#options.app), enabled: config.enabled, ssh: !config.via }
      const link = this.#links.get(config.id)
      const colour = config.colour ? { colour: config.colour } : {}
      return link ? { ...link.entry(), label: config.label, remote, ...colour } : { id: config.id, label: config.label, state: 'disabled', remote, ...colour }
    })
  }

  /** Follow the store, the file included (another process edits it too); returns how to stop following. */
  follow(): () => void {
    const off = this.#options.store.onChange(() => this.sync())
    this.#options.store.watch()
    this.sync()
    return off
  }

  /** Start, restart or stop links to match the configured machines. */
  sync() {
    if (this.#closed) return
    const configs = this.#options.store.list()
    for (const [id, link] of this.#links) {
      const config = configs.find((c) => c.id === id)
      const gaveUp = link.state !== 'connected' && link.state !== 'connecting' && JSON.stringify(config) !== this.#configs.get(id)
      if (!config?.enabled || routeOf(config, this.#options.app) !== this.#routes.get(id) || gaveUp) this.#drop(id, link)
    }
    for (const config of configs) {
      if (!config.enabled || this.#links.has(config.id)) continue
      this.#routes.set(config.id, routeOf(config, this.#options.app))
      this.#configs.set(config.id, JSON.stringify(config))
      const link = this.#link(config)
      this.#links.set(config.id, link)
      link.start()
    }
    this.#options.onChange?.()
  }

  /** Drop a machine's link and connect again: after a login, a reinstall, or trusting whoever answers now. */
  restart(id: string) {
    const link = this.#links.get(id)
    if (link) this.#drop(id, link)
    this.sync()
  }

  close() {
    this.#closed = true
    for (const [id, link] of this.#links) this.#drop(id, link)
  }

  #drop(id: string, link: Link) {
    link.stop()
    this.#links.delete(id)
    this.#routes.delete(id)
    this.#configs.delete(id)
  }

  #link(config: MachineConfig) {
    const { app, dataDir, store, self } = this.#options
    const link: Link = new Link({
      id: config.id, label: config.label, client: this.#options.client,
      ...(this.#options.clientLabel ? { clientLabel: this.#options.clientLabel } : {}),
      ...(this.#options.heartbeat ? { heartbeat: this.#options.heartbeat } : {}),
      open: () => openMachine(config, app, dataDir),
      // A link that was dropped says nothing more.
      onEvent: (method, params) => { if (this.#links.get(config.id) === link) this.#options.onEvent(config.id, method, params) },
      verify: (hello) => {
        const target = config.via ? 'that command' : config.target
        if (self && hello.machine.id === self) throw new RpcError('duplicate_machine', `${target} reaches this machine itself, which doesn't link to itself`)
        const current = store.get(config.id)
        const connected = [
          ...(this.#options.others?.() ?? []),
          ...this.list().filter((other) => other !== link && other.state === 'connected' && other.hello).map((other) => ({ label: other.label, id: other.hello!.machine.id })),
        ]
        checkIdentity(hello, { target, ...(current?.daemonId ? { expected: current.daemonId } : {}) }, connected)
        if (!current?.daemonId) void store.update(config.id, { daemonId: hello.machine.id }).catch(() => {})
      },
    })
    return link
  }
}
