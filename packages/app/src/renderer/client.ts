// The renderer's view of the daemons: typed calls per machine, and hooks that subscribe to live state and resubscribe
// whenever a machine reconnects.
import { useEffect, useState } from 'react'
import { applyImmutable, type Op } from '@earendil-works/chord/delta'
import type { ConversationView } from '@earendil-works/pi-durable'
import type { Client, Feature, Json, MethodName, Notifications, Params, Result, SessionInfo, SettingsSnapshot } from '@mu/protocol'
import type { MachineEntry, MachineId, MuBridge } from '../shared.ts'
import { useRegistry } from './extension.tsx'

declare global {
  interface Window { mu: MuBridge }
}

export function machine(id: MachineId): Client {
  return {
    call: <M extends MethodName>(method: M, params: Params<M>) => window.mu.call(id, method, params) as Promise<Result<M>>,
    on: (event, listener) => window.mu.onEvent((e) => { if (e.machine === id && e.method === event) listener(e.params as never) }),
  }
}

/** Whether a machine's daemon offers `feature` (from its hello); unknown until it has connected once. */
export const has = (machine: MachineEntry | undefined, feature: Feature | `ext:${string}`) => machine?.features?.includes(feature) ?? false

/** The machines from the main process, live. The shell holds one subscription; extensions use `useMachines`. */
export function useMachineList(): MachineEntry[] {
  const [machines, setMachines] = useState<MachineEntry[]>([])
  useEffect(() => {
    let live = true
    void window.mu.machines().then((list) => { if (live) setMachines(list) })
    const off = window.mu.onEvent((event) => { if (event.method === '$machines') setMachines(event.params as MachineEntry[]) })
    return () => { live = false; off() }
  }, [])
  return machines
}

/** The families of the fonts installed here, through the Local Font Access API. */
let fontFamilies: Promise<string[]> | undefined
export function loadFonts(): Promise<string[]> {
  const query = (window as unknown as { queryLocalFonts?: () => Promise<{ family: string }[]> }).queryLocalFonts
  if (!query) return Promise.reject(new Error('This build cannot list fonts'))
  fontFamilies ??= query().then((fonts) => [...new Set(fonts.map((font) => font.family))].sort((a, b) => a.localeCompare(b)))
  fontFamilies.catch(() => { fontFamilies = undefined })
  return fontFamilies
}

/**
 * Subscribe to a watch method: take its snapshot, then fold its notifications in. Notifications that arrive before
 * the snapshot's response are buffered by subscription id. Stale data stays when the machine disconnects.
 */
export function useWatch<T>(
  machineId: MachineId, connected: boolean, key: string | undefined,
  start: (client: Client) => Promise<{ sub: string; value: T }>,
  fold: (value: T, method: string, params: any) => T,
  events: (keyof Notifications)[],
): T | undefined {
  const [value, setValue] = useState<T>()
  useEffect(() => { setValue(undefined) }, [machineId, key])
  useEffect(() => {
    if (!connected || key === undefined) return
    const client = machine(machineId)
    let sub: string | undefined
    let stopped = false
    const early: { method: string; params: any }[] = []
    const offs = events.map((event) => client.on(event, (params: any) => {
      if (sub === undefined) early.push({ method: event, params })
      else if (params.sub === sub) setValue((current) => current === undefined ? current : fold(current, event, params))
    }))
    start(client).then((result) => {
      if (stopped) { void client.call('unwatch', { sub: result.sub }).catch(() => {}); return }
      sub = result.sub
      let next = result.value
      for (const { method, params } of early) if (params.sub === sub) next = fold(next, method, params)
      setValue(next)
    }).catch((error) => console.error('watch failed', error))
    return () => {
      stopped = true
      for (const off of offs) off()
      if (sub) void client.call('unwatch', { sub }).catch(() => {})
    }
  }, [machineId, connected, key])
  return value
}

export const useSessions = (machineId: MachineId, connected: boolean) =>
  useWatch<SessionInfo[]>(machineId, connected, 'all', (client) => client.call('sessions.watch', {}),
    (_value, _method, params: Notifications['sessions.changed']) => params.value, ['sessions.changed'])

/** A live value an extension's daemon half publishes (`mu.value`), on `machineId`. */
export const useValue = <T,>(machineId: MachineId, connected: boolean, key: string) =>
  useWatch<T>(machineId, connected, key, (client) => client.call('value.watch', { key }) as Promise<{ sub: string; value: T }>,
    (_value, _method, params: Notifications['value.changed']) => params.value as T, ['value.changed'])

/** Call any method on a machine, including an extension's own (`<extension>.<method>`). */
export const call = <R = unknown,>(machineId: MachineId, method: string, params: unknown = {}) => window.mu.call(machineId, method, params) as Promise<R>

export const useSessionView = (machineId: MachineId, connected: boolean, id: string | undefined) =>
  useWatch<ConversationView>(machineId, connected, id, (client) => client.call('session.watch', { id: id! }),
    (value, method, params: Notifications['watch.ops']) => method === 'watch.ops' ? applyImmutable(value, params.ops as Op[]) : value,
    ['watch.ops'])

export const useSettings = (machineId: MachineId, connected: boolean) =>
  useWatch<SettingsSnapshot>(machineId, connected, 'settings', (client) => client.call('settings.watch', {}),
    (_value, _method, params: Notifications['settings.changed']) => params.value, ['settings.changed'])

/**
 * One of the app's settings (those UI halves declare with `mu.appSettings`, or the core's), and a way to change it.
 * Undefined until the app's settings have loaded.
 */
export function useAppSetting<T extends Json>(key: string): [T | undefined, (value: T) => Promise<unknown>] {
  const snapshot = useSettings('app', true)
  const dispatch = useRegistry().router.dispatch
  return [snapshot?.values[key] as T | undefined, (value: T) => dispatch('app.settings.set', { key, value }, { machine: 'app' })]
}
