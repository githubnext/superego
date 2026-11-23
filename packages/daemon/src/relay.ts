// A daemon that reaches the other machines: it keeps a link to each one in `machines.json` on its computer (see
// @superego/client's hub.ts, which the host gives it), and passes calls on to them for its own clients (a browser on
// Web access, an agent's thread tools). A client sees the machines with `machines.watch`, calls one with `relay.call`,
// and hears back from it in `relay.event`: a notification for a watch it opened goes to it alone, anything else to
// every connection that has called that machine. Watches a connection opened elsewhere end when it goes.
//
// A call goes with who it's for (a thread's shell, an extension: `Caller`), as `relay.as`, so the machine there refuses
// it the user's consent as this one would. One whose daemon is older and doesn't know `relay.as` would take a plain call
// as the user's: what could be consent isn't passed on to it for a caller at all (see `older`).
import { RpcError, type Caller, type MachineEntry, type Router } from '@superego/protocol'
import { RESERVED } from './extension-host.ts'

/** A machine to add: reached with ssh (`target`, running `command` there if not Superego's own), or `via` any command piping stdio to it. */
export type MachineDraft = { label?: string; target?: string; command?: string; via?: string }
/** What can change of a machine. */
export type MachinePatch = { label?: string; enabled?: boolean; target?: string; command?: string }

/** The machines this daemon reaches, as the host keeps them. Without one, it reaches none. */
export type MachineReach = {
  /** The configured machines, as entries (not this one). */
  list(): MachineEntry[]
  /** Call one through its link. */
  call(machine: string, method: string, params: unknown): Promise<unknown>
  /** Whether one offers `feature`, as its daemon last said (see `offers`): nothing while it never has. */
  offers(machine: string, feature: string): boolean
  /** Add one to the list (`machines.json`): by ssh target, or `via` a command; linked to on its own. */
  add(machine: MachineDraft): Promise<MachineEntry>
  /** Change one: its name, whether it's linked to, or how it's reached. */
  update(id: string, patch: MachinePatch): Promise<MachineEntry>
  /** Take one off the list. */
  remove(id: string): Promise<void>
  /** Their notifications; `$connection` when a link's state changes, `$machines` when the list does. */
  onEvent(listener: (machine: string, method: string, params: unknown) => void): () => void
  reconnect(id: string): void
  close(): void
}

/** What only the link's own connection may say: its hello, its heartbeat, its channels, who its calls are for. */
const UNRELAYED = new Set(['hello', 'ping', 'ch.open', 'relay.as'])

type Peer = {
  /** The machines it called: their news is its news. */
  used: Set<string>
  /** The watches it opened elsewhere, by machine and sub. */
  subs: Set<string>
  notify(machine: string, method: string, params: unknown): void
  closed: boolean
}

const key = (machine: string, sub: string) => `${machine}\n${sub}`

/** The links to the other machines, as createRelay keeps them. */
export type Relay = ReturnType<typeof createRelay>

/**
 * `router`: this machine's actions, to judge by what a call to an older machine could record the user's consent to: the
 * core's are the same there.
 */
export function createRelay(reach: MachineReach | undefined, self: () => MachineEntry, router: Pick<Router<never>, 'consentOf'>) {
  const peers = new Set<Peer>()
  const owners = new Map<string, Peer>()
  const watchers = new Set<(entries: MachineEntry[]) => void>()
  const entries = (): MachineEntry[] => [self(), ...(reach?.list() ?? [])]
  let queued = false
  const changed = () => {
    if (queued) return
    queued = true
    queueMicrotask(() => { queued = false; const list = entries(); for (const watcher of watchers) watcher(list) })
  }
  /** Watches on a machine whose link dropped are gone there; nothing to unwatch later. */
  const forget = (machine: string) => {
    for (const [k, peer] of owners) {
      if (!k.startsWith(`${machine}\n`)) continue
      owners.delete(k)
      peer.subs.delete(k)
    }
  }

  const off = reach?.onEvent((machine, method, params) => {
    if (method === '$connection' || method === '$machines') {
      if (method === '$connection' && (params as MachineEntry).state !== 'connected') forget(machine)
      return changed()
    }
    const sub = (params as { sub?: unknown } | null)?.sub
    const owner = typeof sub === 'string' ? owners.get(key(machine, sub)) : undefined
    if (owner) {
      owner.notify(machine, method, params)
      if (method === 'watch.end') { owners.delete(key(machine, sub as string)); owner.subs.delete(key(machine, sub as string)) }
      return
    }
    // Not a watch anyone here opened (or its answer is still on the way): to whoever uses that machine.
    for (const peer of peers) if (peer.used.has(machine)) peer.notify(machine, method, params)
  })

  const linked = (machine: string) => {
    if (machine === 'local') throw new RpcError('invalid', 'This machine is called directly, not through relay.call')
    if (!reach?.list().some((m) => m.id === machine)) throw new RpcError('not_found', `No machine ${machine} here`)
  }
  /**
   * Why a caller's call isn't passed on to an older machine, which would take it as the user's: one that may record
   * the user's consent there (a core action that does, by this machine's router), one this machine can't judge (an
   * extension's, `action.run` of one), or one that goes on elsewhere (`relay.call`).
   */
  const older = (machine: string, method: string, params: unknown): string | undefined => {
    if (method === 'relay.call') return 'passing a call on again'
    const run = params as { id?: unknown; params?: unknown } | null
    const [id, args] = method === 'action.run' ? [typeof run?.id === 'string' ? run.id : '', run?.params] : [method, params]
    if (!RESERVED.has(id.split('.')[0]!)) return id || method
    return router.consentOf(id, args)
  }
  /** Send a call to `machine` for `caller` (nothing: the user's own). */
  const send = (machine: string, method: string, params: unknown, caller: Caller) => {
    if (!caller.from && !caller.extension) return reach!.call(machine, method, params)
    if (reach!.offers(machine, 'relay-as')) return reach!.call(machine, 'relay.as', { caller, method, params })
    const what = older(machine, method, params)
    if (what) {
      const label = reach!.list().find((m) => m.id === machine)?.label ?? machine
      throw new RpcError('consent', `${what}: ${label} runs an older Superego, which would take it as the user's`, { hint: `Update it (superego machines update ${label}), or ask the user to do it there themselves.` })
    }
    return reach!.call(machine, method, params)
  }

  return {
    entries,
    /** Follow the list; returns how to stop. */
    watch(listener: (entries: MachineEntry[]) => void) { watchers.add(listener); return () => { watchers.delete(listener) } },
    /** Call a machine for `caller` (an extension, for an agent's tools): no events come back. */
    async call(machine: string, method: string, params: unknown, caller: Caller) {
      linked(machine)
      return send(machine, method, params, caller)
    },
    /** The list itself (`machines.json`), as an extension edits it: refused when this daemon keeps none. */
    get list(): Pick<MachineReach, 'add' | 'update' | 'remove'> {
      if (!reach) throw new RpcError('invalid', "This daemon reaches no other machines: the app keeps them, and this one wasn't given them")
      return reach
    },
    reconnect(id: string) {
      if (id === 'local') throw new RpcError('invalid', 'This machine has no link to itself')
      linked(id)
      reach!.reconnect(id)
    },
    /** One connection's relay: what it calls, and the events that come back for it. */
    connect(notify: Peer['notify']) {
      const peer: Peer = { used: new Set(), subs: new Set(), notify, closed: false }
      peers.add(peer)
      return {
        /** `caller`: who it's for (nothing: the user's own), as this connection says it. */
        async call(machine: string, method: string, params: unknown, caller: Caller): Promise<unknown> {
          linked(machine)
          if (typeof method !== 'string' || UNRELAYED.has(method) || method.startsWith('ch.')) throw new RpcError('invalid', `${String(method)} isn't passed on`)
          peer.used.add(machine)
          const result = await send(machine, method, params, caller)
          const sub = (result as { sub?: unknown } | null)?.sub
          if (method === 'unwatch') {
            const k = key(machine, String((params as { sub?: unknown } | null)?.sub))
            if (owners.get(k) === peer) { owners.delete(k); peer.subs.delete(k) }
          } else if (typeof sub === 'string') {
            // Gone while the watch was opened: it ends at once.
            if (peer.closed) void reach!.call(machine, 'unwatch', { sub }).catch(() => {})
            else { owners.set(key(machine, sub), peer); peer.subs.add(key(machine, sub)) }
          }
          return result
        },
        /** It went: end the watches it opened elsewhere. */
        close() {
          peer.closed = true
          peers.delete(peer)
          for (const k of peer.subs) {
            owners.delete(k)
            const [machine, sub] = k.split('\n') as [string, string]
            void reach!.call(machine, 'unwatch', { sub }).catch(() => {})
          }
          peer.subs.clear()
        },
      }
    },
    close() { off?.(); reach?.close() },
  }
}
