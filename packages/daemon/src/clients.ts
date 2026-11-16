// Who is connected to this daemon: every connection, what it said it is in `hello`, and a name for people. Clients
// watch the list (`clients.watch`), the action log names who dispatched, and one client can ask another to run a
// window action (`client.perform`): the daemon passes on only the navigation in PERFORMABLE; the target checks again
// and dispatches it.
import { randomBytes } from 'node:crypto'
import { PERFORMABLE, RpcError, type ClientInfo, type Json, type RpcPeer } from '@superego/protocol'

/** What the transport knows about a connection before it says hello: a browser's device, a Tailscale login. */
export type Via = { via: ClientInfo['via']; label?: string; device?: string }

export class Clients {
  #entries = new Map<string, { info: ClientInfo; peer: RpcPeer }>()
  #listeners = new Set<(list: ClientInfo[]) => void>()
  #timer: ReturnType<typeof setTimeout> | undefined

  add(peer: RpcPeer, via: Via = { via: 'socket' }): string {
    const id = `c${randomBytes(4).toString('hex')}`
    const now = Date.now()
    this.#entries.set(id, { peer, info: { id, kind: 'client', label: via.label ?? 'client', connectedAt: now, activeAt: now, via: via.via, ...(via.device ? { device: via.device } : {}) } })
    this.#changed(true)
    return id
  }

  /**
   * What `hello` said. A label the transport gave (a device's name, a login) is kept over the client's own. `from`: the
   * thread whose agent's shell it runs in.
   */
  hello(id: string, kind: string, label: string | undefined, from?: string) {
    const entry = this.#entries.get(id)
    if (!entry) return
    entry.info.kind = kind
    if (from) entry.info.from = from
    else delete entry.info.from
    if (entry.info.via === 'socket' || entry.info.label === 'client') entry.info.label = label?.trim() || kind
    this.#changed(true)
  }

  /** It called something. Told to watchers at most once a second: activity alone isn't worth a stream of updates. */
  touch(id: string) {
    const entry = this.#entries.get(id)
    if (!entry) return
    entry.info.activeAt = Date.now()
    this.#changed(false)
  }

  /** A paired browser's new name, on its live connections too. */
  relabel(device: string, label: string) {
    for (const { info } of this.#entries.values()) if (info.device === device) info.label = label
    this.#changed(true)
  }

  remove(id: string) {
    if (this.#entries.delete(id)) this.#changed(true)
  }

  get(id: string): ClientInfo | undefined {
    const entry = this.#entries.get(id)
    return entry && { ...entry.info }
  }

  list(): ClientInfo[] {
    return [...this.#entries.values()].map(({ info }) => ({ ...info })).sort((a, b) => a.connectedAt - b.connectedAt)
  }

  watch(listener: (list: ClientInfo[]) => void): () => void {
    this.#listeners.add(listener)
    return () => { this.#listeners.delete(listener) }
  }

  /** Pass a window action to another client. It runs there, if that client has it; this only says it was sent. */
  perform(from: string, target: string, action: string, params?: Json) {
    if (!PERFORMABLE.has(action)) throw new RpcError('not_exposed', `${action} isn't one another client may ask a window to run`)
    const source = this.#entries.get(from)
    const entry = this.#entries.get(target)
    if (!source || !entry) throw new RpcError('not_found', `No client ${target} here`)
    entry.peer.notify('client.perform', { from: { ...source.info }, action, ...(params !== undefined ? { params } : {}) })
  }

  #changed(now: boolean) {
    if (now) clearTimeout(this.#timer)
    else if (this.#timer) return
    const emit = () => {
      this.#timer = undefined
      const list = this.list()
      for (const listener of this.#listeners) listener(list)
    }
    if (now) emit()
    else { this.#timer = setTimeout(emit, 1000); this.#timer.unref?.() }
  }
}
