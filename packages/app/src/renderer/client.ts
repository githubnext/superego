// The renderer's view of the daemons: typed calls per machine, and hooks that subscribe to live state and resubscribe
// whenever a machine reconnects.
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { applyImmutable, type Op } from '@earendil-works/chord/delta'
import type { ConversationView } from '@earendil-works/pi-durable'
import type { Client, Feature, Json, MethodName, Notifications, Params, Result, ThreadInfo, SettingsSnapshot } from '@superego/protocol'
import type { MachineEntry, MachineId, SuperegoBridge } from '../shared.ts'
import { useRegistry } from './extension.tsx'
import { fonts } from './fonts.ts'

declare global {
  interface Window { superego: SuperegoBridge }
}

export function machine(id: MachineId): Client {
  return {
    call: <M extends MethodName>(method: M, params: Params<M>) => window.superego.call(id, method, params) as Promise<Result<M>>,
    on: (event, listener) => window.superego.onEvent((e) => { if (e.machine === id && e.method === event) listener(e.params as never) }),
  }
}

/**
 * Whether a machine's daemon offers `feature`: a protocol feature, or `ext:<name>` for an extension set up there now
 * and not switched off (a profile's from when the profile loads). Kept current as the daemon says (`features.changed`);
 * false until it has connected once.
 */
export const has = (machine: MachineEntry | undefined, feature: Feature | `ext:${string}`) => machine?.features?.includes(feature) ?? false

/** The machines from the main process, live. The shell holds one subscription; extensions use `useMachines`. */
export function useMachineList(): MachineEntry[] {
  const [machines, setMachines] = useState<MachineEntry[]>([])
  useEffect(() => {
    let live = true
    void window.superego.machines().then((list) => { if (live) setMachines(list) })
    const off = window.superego.onEvent((event) => { if (event.method === '$machines') setMachines(event.params as MachineEntry[]) })
    return () => { live = false; off() }
  }, [])
  return machines
}

/** The families of the fonts installed here, through the Local Font Access API (kept: see fonts.ts). */
export const loadFonts = (): Promise<string[]> => fonts.load()

/**
 * A watch shared by everyone who wants it: one subscription per (machine, method, params), however many components
 * show it, held while any of them is mounted. It takes the snapshot, then folds notifications in; notifications that
 * arrive before the snapshot's response are folded in after it. Stale data stays while the machine is disconnected, and
 * it watches again when the machine is back, when the daemon stopped the watch itself (it cleared the thread), or after
 * a failed call, once something changes (a subscriber, the connection).
 */
export class SharedWatch<T> {
  value: T | undefined
  readonly listeners = new Set<() => void>()
  /** Whether each of its users wants it running now (connected, say): it runs while any of them does. */
  readonly #wanted = new Map<object, boolean>()
  #stop: (() => void) | undefined
  #release: ReturnType<typeof setTimeout> | undefined
  #ended = false
  readonly id: string
  readonly machineId: MachineId
  readonly method: string
  readonly params: unknown
  readonly fold: (value: T, method: string, params: any) => T
  readonly events: (keyof Notifications)[]
  constructor(id: string, machineId: MachineId, method: string, params: unknown, fold: (value: T, method: string, params: any) => T, events: (keyof Notifications)[]) {
    this.id = id; this.machineId = machineId; this.method = method; this.params = params; this.fold = fold; this.events = events
    // Made while rendering: a render that never commits never subscribes, and leaves nothing behind.
    this.#release = setTimeout(() => { if (!this.listeners.size) this.#end() }, 1000)
  }

  subscribe = (listener: () => void) => {
    clearTimeout(this.#release)
    // Ended before it was subscribed (a render that took long to commit): it's the watch again, unless another is.
    if (this.#ended) {
      this.#ended = false
      if (!watches.has(this.id)) watches.set(this.id, this)
    }
    this.listeners.add(listener)
    this.#run()
    return () => {
      this.listeners.delete(listener)
      // Let go a moment later: a component remounting (a key change, StrictMode) keeps the same subscription.
      if (!this.listeners.size) this.#release = setTimeout(() => { if (!this.listeners.size) this.#end() }, 1000)
    }
  }

  /** Whether `user` wants it running now. */
  want(user: object, wanted: boolean) {
    this.#wanted.set(user, wanted)
    this.#update()
  }

  /** `user` no longer has a say: it stops if nobody left wants it (after a moment, so a user changing its mind in one commit doesn't restart it). */
  unwant(user: object) {
    this.#wanted.delete(user)
    queueMicrotask(() => this.#update())
  }

  get #on() { return [...this.#wanted.values()].some(Boolean) }

  #update() {
    if (this.#on) this.#run()
    else this.#stop?.()
  }

  #set(value: T | undefined) {
    this.value = value
    for (const listener of this.listeners) listener()
  }

  #run() {
    if (this.#stop || !this.#on || !this.listeners.size) return
    const client = machine(this.machineId)
    let sub: string | undefined
    let stopped = false
    const early: { method: string; params: any }[] = []
    const offs = this.events.map((event) => client.on(event, (params: any) => {
      if (sub === undefined) early.push({ method: event, params })
      else if (params.sub === sub && this.value !== undefined) this.#set(this.fold(this.value, event, params))
    }))
    offs.push(client.on('watch.end', (params) => {
      if (sub === undefined || params.sub !== sub || params.reason !== 'stopped' || stopped) return
      stop()
      this.#run()
    }))
    const stop = () => {
      if (stopped) return
      stopped = true
      if (this.#stop === stop) this.#stop = undefined
      for (const off of offs) off()
      if (sub) void client.call('unwatch', { sub }).catch(() => {})
    }
    this.#stop = stop
    ;(client.call as (method: string, params: unknown) => Promise<{ sub: string; value: T }>)(this.method, this.params).then((result) => {
      if (stopped) { void client.call('unwatch', { sub: result.sub }).catch(() => {}); return }
      sub = result.sub
      let next = result.value
      for (const { method, params } of early) if (params.sub === sub) next = this.fold(next, method, params)
      this.#set(next)
    }).catch((error) => {
      // Not watching: the next change (a subscriber, the connection) tries again.
      stop()
      console.error(`${this.method} failed`, error)
    })
  }

  #end() {
    this.#stop?.()
    this.#ended = true
    // Only itself: a watch made since, for the same thing, stays.
    if (watches.get(this.id) === this) watches.delete(this.id)
  }
}

const watches = new Map<string, SharedWatch<any>>()

export function sharedWatch<T>(machineId: MachineId, method: string, params: unknown, fold: (value: T, method: string, params: any) => T, events: (keyof Notifications)[]): SharedWatch<T> {
  const id = `${machineId}\u0000${method}\u0000${JSON.stringify(params)}`
  let watch = watches.get(id) as SharedWatch<T> | undefined
  if (!watch) watches.set(id, watch = new SharedWatch(id, machineId, method, params, fold, events))
  return watch
}

/**
 * Watch `method` with `params` on a machine while `connected` (undefined params: nothing to watch), folding in its
 * notifications (`events`) with `fold`. Every component watching the same thing shares one subscription, which runs
 * while any of them has it connected.
 */
export function useWatch<T>(
  machineId: MachineId, connected: boolean, method: string, params: object | undefined,
  fold: (value: T, method: string, params: any) => T,
  events: (keyof Notifications)[],
): T | undefined {
  const watch = params === undefined ? undefined : sharedWatch(machineId, method, params, fold, events)
  const user = useRef({}).current
  useEffect(() => {
    if (!watch) return
    watch.want(user, connected)
    return () => watch.unwant(user)
  }, [watch, connected])
  return useSyncExternalStore(watch?.subscribe ?? noSubscription, () => watch?.value)
}
const noSubscription = () => () => {}

/** What a watch shows now, outside React, if anything is watching it (else undefined). */
export function watched<T>(machineId: MachineId, method: string, params: object): T | undefined {
  return watches.get(`${machineId}\u0000${method}\u0000${JSON.stringify(params)}`)?.value as T | undefined
}

const replace = <T,>(_value: T, _method: string, params: { value: T }) => params.value

export const useThreads = (machineId: MachineId, connected: boolean) =>
  useWatch<ThreadInfo[]>(machineId, connected, 'threads.watch', {}, replace, ['threads.changed'])

/** The threads on `machineId` that no list shows (extensions' own, like Ego's): for showing one that's selected. */
export const useHiddenThreads = (machineId: MachineId, connected: boolean) =>
  useWatch<ThreadInfo[]>(machineId, connected, 'threads.watch', { hidden: true }, replace, ['threads.changed'])

/**
 * A live value an extension's daemon half publishes (`superego.value`), on `machineId`: null until the extension that
 * publishes it is set up there (a profile's, before the profile loads).
 */
export const useValue = <T,>(machineId: MachineId, connected: boolean, key: string) =>
  useWatch<T>(machineId, connected, 'value.watch', { key }, (value, _method, params: Notifications['value.changed']) => params.key === key ? params.value as T : value, ['value.changed'])

/** Call any method on a machine, including an extension's own (`<extension>.<method>`). */
export const call = <R = unknown,>(machineId: MachineId, method: string, params: unknown = {}) => window.superego.call(machineId, method, params) as Promise<R>

export const useThreadView = (machineId: MachineId, connected: boolean, id: string | undefined) =>
  useWatch<ConversationView>(machineId, connected, 'thread.watch', id === undefined ? undefined : { id },
    (value, method, params: Notifications['watch.ops']) => method === 'watch.ops' ? applyImmutable(value, params.ops as Op[]) : value,
    ['watch.ops'])

export const useSettings = (machineId: MachineId, connected: boolean) =>
  useWatch<SettingsSnapshot>(machineId, connected, 'settings.watch', {}, replace, ['settings.changed'])

/**
 * One of the app's settings (those UI halves declare with `superego.appSettings`, or the core's), and a way to change it.
 * Undefined until the app's settings have loaded.
 */
export function useAppSetting<T extends Json>(key: string): [T | undefined, (value: T) => Promise<unknown>] {
  const snapshot = useSettings('app', true)
  const dispatch = useRegistry().router.dispatch
  return [snapshot?.values[key] as T | undefined, (value: T) => dispatch('app.settings.set', { key, value }, { machine: 'app' })]
}
