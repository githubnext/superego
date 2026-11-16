// One connection's methods: the reads and watches a client calls (`thread.list`, `file.read`, `value.watch`, …), every
// action under its id, and extensions' methods, each looked up as it's called. Params are checked first: a malformed
// call is `invalid_params`, as an action's is. What it watches ends with it.
import { randomUUID } from 'node:crypto'
import {
  arr, bool, EXTENSION_API, lit, num, obj, opt, paramsParser, PROTOCOL_VERSION, RpcError, str, union, unknown, type ExtensionAbout, type JsonSchema, type KeepsRunning,
  type MachineInfo, type Methods, type Notifications, type RpcPeer,
} from '@superego/protocol'
import { serveSettings } from '@superego/settings'
import type { Clients, Via } from './clients.ts'
import { serveConnection, versionMismatch } from './connection.ts'
import type { ExtensionHost } from './extension-host.ts'
import type { threadFiles } from './files.ts'
import type { DaemonContext, Host } from './host.ts'
import type { ProfileHost } from './profile-host.ts'
import type { Relay } from './relay.ts'
import type { Threads } from './threads.ts'

const thread = str()
const EXPOSURE = union([lit('ui'), lit('cli'), lit('outside')])
const PROFILE_REF = { scope: union([lit('user'), lit('project')]), name: str(), dir: str() }
/** A method's params, open to more: a newer client may send what an older daemon of its generation doesn't know yet. */
const params = (properties: Parameters<typeof obj>[0]) => obj(properties, { open: true })
/**
 * What each method takes. `hello` isn't checked: a client of another generation is told so (`version_mismatch`), not
 * that its hello is malformed.
 */
const PARAMS: Record<string, JsonSchema> = {
  'client.perform': params({ client: str(), action: str(), params: opt(unknown()) }),
  'relay.call': params({ machine: str(), method: str(), params: opt(unknown()) }),
  'thread.list': params({ archived: opt(bool()), hidden: opt(bool()) }),
  'file.read': params({ thread, path: str(), base64: opt(bool()) }),
  'file.stat': params({ thread, paths: arr(str()) }),
  'file.find': params({ thread, name: str() }),
  'file.watch': params({ thread, path: str() }),
  'profile.ui': params(PROFILE_REF),
  'profile.module': params({ ...PROFILE_REF, path: str() }),
  'thread.history': params({ thread, before: num(), limit: opt(num()) }),
  'thread.lastAnswer': params({ thread }),
  'thread.watch': params({ thread }),
  'threads.watch': params({ hidden: opt(bool()) }),
  'value.watch': params({ key: str(), scope: opt(str()) }),
  unwatch: params({ sub: str() }),
  'action.list': params({ exposure: opt(EXPOSURE) }),
  'action.run': params({ id: str(), params: opt(unknown()), exposure: opt(EXPOSURE) }),
  // Each extension is anyone's JSON, taken as far as it reads (see the extension host's declare).
  'extension.declare': params({ extensions: arr(unknown()) }),
  'extension.inspect': params({ thread: opt(str()) }),
}
const parsers = new Map(Object.entries(PARAMS).map(([method, schema]) => [method, paramsParser(method, schema)]))

export type Served = {
  host: Host
  machine: MachineInfo
  /** Whether this daemon outlives a logout, for hello. */
  keepsRunning(): KeepsRunning
  clients: Clients
  relay: Relay
  extensions: ExtensionHost
  profiles: ProfileHost
  threads: Threads
  files: ReturnType<typeof threadFiles>
  outsideMayStart(): boolean
}

/** Serve one connection: its methods registered on `peer`, until the returned cleanup, as it disconnects. */
export function serveClient(peer: RpcPeer, { via, hangUp }: { via?: Via; hangUp?: () => void }, served: Served): () => void {
  const { host, machine, clients, relay, extensions, profiles, threads, files } = served
  const { options, settings, router, values } = host
  const subs = new Map<string, () => unknown>()
  const connection = serveConnection(peer, { ...(hangUp ? { hangUp } : {}) })
  const notify = <N extends keyof Notifications>(event: N, params: Notifications[N]) => peer.notify(event, params)
  let client = 'client'
  const self = clients.add(peer, via)
  /** Who dispatched, for the action log. */
  const by = () => { const info = clients.get(self); return info && { id: info.id, kind: info.kind, label: info.label } }
  const relayed = relay.connect((machine, method, params) => notify('relay.event', { machine, method, params }))
  /** A new watch's id: it lasts until unwatched, or the connection ends. */
  const sub = () => randomUUID()
  // Reads and watches; every intent is an action, served below under its id.
  const handlers: Record<string, (params: any) => unknown> = {
    async hello({ version, client: name, label }: Methods['hello']['params']) {
      if (version !== PROTOCOL_VERSION) throw versionMismatch(options.app, machine.hostname, version)
      if (typeof name === 'string') client = name
      clients.hello(self, client, typeof label === 'string' ? label : undefined)
      return {
        version: PROTOCOL_VERSION, ...extensions.offer(), api: EXTENSION_API, machine: { ...machine, keepsRunning: served.keepsRunning() }, client: self,
        methods: [...new Set([...peer.methods, ...router.list().map((a) => a.id), ...extensions.methodIds()])],
      }
    },
    async 'clients.watch'() {
      const id = sub()
      subs.set(id, clients.watch((value) => notify('clients.changed', { sub: id, value })))
      return { sub: id, value: clients.list() }
    },
    async 'client.perform'({ client: target, action, params }: Methods['client.perform']['params']) {
      clients.perform(self, target, action, params)
      return null
    },
    async 'machines.watch'() {
      const id = sub()
      subs.set(id, relay.watch((value) => notify('machines.changed', { sub: id, value })))
      return { sub: id, value: relay.entries() }
    },
    'relay.call': ({ machine: target, method, params }: Methods['relay.call']['params']) => relayed.call(target, method, params),
    'thread.list': ({ archived, hidden }: Methods['thread.list']['params']) => threads.list({ archived: Boolean(archived), hidden: Boolean(hidden) }),
    'agent.models': async () => host.agent.catalog(),
    'file.read': ({ thread: id, path, base64 }: Methods['file.read']['params']) => files.read(id, path, base64),
    // Which version of each file there is, without its bytes: what the window checks its images against.
    'file.stat': async ({ thread: id, paths }: Methods['file.stat']['params']) => ({ files: await files.stat(id, paths) }),
    'file.find': ({ thread: id, name }: Methods['file.find']['params']) => files.find(id, name),
    // A profile's UI is its code too: served only for a real profile folder, and only once it is allowed.
    'profile.ui': (ref: Methods['profile.ui']['params']) => profiles.ui(ref),
    'profile.module': ({ path, ...ref }: Methods['profile.module']['params']) => profiles.module(ref, path),
    'thread.history': ({ thread: id, before, limit }: Methods['thread.history']['params']) => threads.history(id, before, limit),
    'thread.lastAnswer': async ({ thread: id }: Methods['thread.lastAnswer']['params']) => ({ text: (await threads.lastAnswer(id)) ?? null }),
    async 'thread.watch'({ thread: id }: Methods['thread.watch']['params']) {
      const watching = sub()
      // Held before the watch starts, so one that ends at once (its thread cleared meanwhile) still says so. Its end
      // is told on the next turn, never before the answer that tells the client its sub.
      let stop: (() => void) | undefined
      subs.set(watching, () => stop?.())
      try {
        const watch = await threads.watchTranscript(id, (ops) => notify('watch.ops', { sub: watching, ops }), (reason) => {
          if (subs.delete(watching)) setImmediate(() => notify('watch.end', { sub: watching, reason }))
        })
        stop = watch.stop
        // Stopped meanwhile (the connection closed): nobody will stop it later.
        if (!subs.has(watching)) watch.stop()
        return { sub: watching, value: watch.value }
      } catch (error) {
        subs.delete(watching)
        throw error
      }
    },
    async 'threads.watch'({ hidden = false }: Methods['threads.watch']['params']) {
      const id = sub()
      let last = ''
      const push = async () => {
        const value = await threads.list({ hidden: Boolean(hidden) })
        const json = JSON.stringify(value)
        if (json !== last) { last = json; notify('threads.changed', { sub: id, value }) }
      }
      subs.set(id, host.onChanged(push))
      const value = await threads.list({ hidden: Boolean(hidden) })
      last = JSON.stringify(value)
      return { sub: id, value }
    },
    'settings.watch': serveSettings(settings, (params) => notify('settings.changed', params), subs)['settings.watch'],
    async 'file.watch'({ thread: id, path }: Methods['file.watch']['params']) {
      const watching = sub()
      const { content, stop } = await files.watch(id, path, (content) => notify('file.changed', { sub: watching, content }))
      subs.set(watching, stop)
      return { sub: watching, content }
    },
    'value.watch': ({ key, scope }: Methods['value.watch']['params']) => {
      const id = sub()
      const { value, stop } = values.watch(key, scope, (value) => notify('value.changed', { sub: id, key, value }))
      subs.set(id, stop)
      return { sub: id, value }
    },
    async unwatch({ sub }: Methods['unwatch']['params']) {
      const stop = subs.get(sub)
      subs.delete(sub)
      await stop?.()
      return null
    },
    /** Every action here, as data: id, title, params schema, who may run it; given `exposure`, those it may run now. */
    'action.list': async ({ exposure }: Methods['action.list']['params']) => router.list(exposure).filter((a) => exposure !== 'outside' || a.id !== 'thread.start' || served.outsideMayStart()),
    /** Run an action by id, as `exposure` (the command line passes `cli`); params may be strings to coerce. */
    'action.run': ({ id, params, exposure }: Methods['action.run']['params']) =>
      router.dispatch(id, params, { notify, source: client, ...(exposure ? { exposure } : {}) }, { source: exposure ?? client, client: by(), ...(exposure ? { exposure } : {}) }),
    /** The newest dispatches on this machine, oldest first. */
    'action.log': async () => router.log(),
    /** The window's extensions, as each declares itself: those without a daemon half become known here (see declare). */
    'extension.declare': async ({ extensions: abouts }: { extensions: ExtensionAbout[] }) => { extensions.declare(abouts); return null },
    'extension.inspect': ({ thread }: Methods['extension.inspect']['params']) => extensions.inspect(thread),
    ...connection.handlers,
  }
  const ctx = (): DaemonContext => ({ notify: (event, params) => notify(event as keyof Notifications, params as never), source: client })
  const open = (method: string, handler: (params: unknown) => unknown) => {
    const parse = parsers.get(method)
    return (params: unknown) => {
      if (host.state.restarting && method !== 'hello') throw new RpcError('restarting', 'The daemon is restarting. Try again in a moment.')
      clients.touch(self)
      const resolved = connection.resolve(method, params)
      return handler(parse ? parse(resolved) : resolved)
    }
  }
  const disconnect = extensions.connect(peer)
  for (const [method, handler] of Object.entries(handlers)) peer.handle(method, open(method, handler))
  // Actions under their ids, and extensions' methods: looked up as they're called, so a profile's registered since
  // this connection opened are there too.
  peer.handleOthers((method) => {
    if (router.has(method)) return open(method, (params) => router.dispatch(method, params, ctx(), { source: client, client: by() }))
    const read = extensions.method(method)
    return read && open(method, read)
  })
  return () => {
    disconnect()
    connection.close()
    clients.remove(self)
    relayed.close()
    for (const stop of subs.values()) void stop()
    subs.clear()
  }
}
