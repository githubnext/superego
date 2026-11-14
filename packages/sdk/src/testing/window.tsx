// A window for a test: your UI halves set up in the real registry, drawn by the real shell state over a bridge to fake
// machines (whose methods, values and threads you give) or to test daemons (`testDaemon`), in a DOM of its own
// (happy-dom's, laid over Node's globals while it's mounted). Draw a view or a place, click in it, press keys, change a machine (gone,
// an older Superego) and see what it does.
//
//   const ui = await mountUi({ extensions: [builds], machines: [fakeMachine({ values: { 'builds.queue': [] } })], threads: [thread] })
//   const aside = await ui.render({ place: 'aside', thread: thread.id })
//   expect(aside.text()).toContain('No builds queued')
//   await ui.unmount()
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import {
  defineApp, RELEASED, type ActionInfo, type AppConfig, type ExtensionManifest, type Json, type ProfileRef, type ThreadInfo,
} from '@superego/protocol'
import type { MachineEntry, SuperegoBridge, SuperegoEvent } from '@superego/app/shared'
import {
  bound, LAYOUT, layoutOf, normalize, placedFor, PlacedViews, RegistryProvider, scopedViews, setLocalState, ShellStateProvider,
  useAllThreads, useMachines, useSelection, windowRegistry, type Layout, type Place, type Registry, type UiExtension, type ViewProps,
} from '@superego/app/internals'
import type { TestDaemon } from './daemon.ts'
import { useDom } from './dom.ts'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/** A machine the window talks to: how it answers, and what it says. */
export type TestMachine = {
  id: string
  entry: MachineEntry
  call(method: string, params: unknown): Promise<unknown>
  listen(tell: (method: string, params: unknown) => void): () => void
  /** A fake's: change a live value (whole, or one scope's part) and tell its watchers. */
  setValue?(key: string, value: Json, scope?: string): void
}

export type FakeMachineOptions = {
  id?: string
  label?: string
  /** Its protocol features: the current ones unless given (`[]`: a daemon from before them all). */
  features?: string[]
  /** The extensions set up there, each at its version (a daemon from before versions: none). */
  extensions?: (ExtensionManifest | string)[]
  /** Its threads. */
  threads?: ThreadInfo[]
  /** Its live values, by key: what `value.watch` answers. A scoped value: its scopes' values, by scope. */
  values?: Record<string, Json>
  /** Its methods and actions, by name: what a call answers (thrown: the call fails). */
  methods?: Record<string, (params: any) => unknown>
  /** Its actions as data, for keys and the palette (`action.list`). */
  actions?: ActionInfo[]
  state?: MachineEntry['state']
}

/** A thread to show, with what a daemon would say of it; give what matters to the test. */
export function testThread(thread: Partial<ThreadInfo> = {}): ThreadInfo {
  const id = thread.id ?? `t${++threads}`
  return {
    id, title: `Thread ${id}`, cwd: '/work', createdAt: 0, activeAt: 0, session: { root: '/work', name: 'work' }, status: { state: 'idle' },
    ...thread,
  }
}
let threads = 0

/** The features a daemon of this build offers. */
const CURRENT = [...RELEASED.features]

/**
 * A machine of your making: its threads, values and methods answer the window's calls; any other call fails as an
 * unknown method would. Everything asked of it is in `calls` (the window's, by method).
 */
export function fakeMachine(options: FakeMachineOptions = {}): TestMachine & { calls: { method: string; params: any }[]; setValue(key: string, value: Json, scope?: string): void } {
  const id = options.id ?? 'local'
  const extensions = (options.extensions ?? []).map((e): ExtensionManifest => typeof e === 'string' ? { name: e, version: '1.0.0' } : e)
  const features = [...(options.features ?? CURRENT), ...extensions.map((e) => `ext:${e.name}`)]
  const values = new Map(Object.entries(options.values ?? {}))
  const watches = new Map<string, { key: string; scope?: string; last: string }>()
  const listeners = new Set<(method: string, params: unknown) => void>()
  const calls: { method: string; params: any }[] = []
  let subs = 0
  const partOf = (key: string, scope?: string): Json => {
    const value = values.has(key) ? values.get(key)! : null
    if (scope === undefined) return value
    return value && typeof value === 'object' && !Array.isArray(value) && Object.hasOwn(value, scope) ? value[scope]! : null
  }
  const tell = (method: string, params: unknown) => { for (const listener of listeners) listener(method, params) }
  const machine = {
    id, calls,
    entry: {
      id, label: options.label ?? id, state: options.state ?? 'connected', machine: { id: `${id}-daemon`, hostname: id },
      features, extensions,
    } satisfies MachineEntry,
    async call(method: string, params: any = {}) {
      if (!['value.watch', 'unwatch', 'threads.watch', 'settings.watch', 'extensions.declare', 'action.list'].includes(method)) calls.push({ method, params })
      if (method === 'value.watch') {
        const sub = `v${++subs}`
        const scope = params.scope as string | undefined
        // An older daemon (no scoped-values) watches it whole, whatever it's asked.
        const part = features.includes('scoped-values') ? scope : undefined
        const value = partOf(params.key, part)
        watches.set(sub, { key: params.key, ...(part !== undefined ? { scope: part } : {}), last: JSON.stringify(value) })
        return { sub, value }
      }
      if (method === 'unwatch') { watches.delete(params.sub); return null }
      if (method === 'threads.watch') return { sub: `t${++subs}`, value: params.hidden ? [] : options.threads ?? [] }
      if (method === 'thread.list') return params.archived ? [] : options.threads ?? []
      if (method === 'settings.watch') return { sub: `s${++subs}`, value: { sections: [], values: {} } }
      if (method === 'extensions.declare') return null
      if (method === 'action.list') return options.actions ?? []
      const run = options.methods?.[method] ?? (method === 'action.run' ? options.methods?.[params.id] : undefined)
      if (!run) throw Object.assign(new Error(`Unknown method ${method === 'action.run' ? params.id : method}`), { kind: 'not_found' })
      return await run(method === 'action.run' ? params.params ?? {} : params) ?? null
    },
    listen(listener: (method: string, params: unknown) => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
    setValue(key: string, value: Json, scope?: string) {
      if (scope === undefined) values.set(key, value)
      else {
        const whole = values.get(key)
        values.set(key, { ...(whole && typeof whole === 'object' && !Array.isArray(whole) ? whole : {}), [scope]: value })
      }
      for (const [sub, watch] of watches) {
        if (watch.key !== key) continue
        const part = partOf(key, watch.scope)
        const json = JSON.stringify(part)
        if (json === watch.last) continue
        watch.last = json
        tell('value.changed', { sub, key, value: part })
      }
    },
  }
  return machine
}

/** A test daemon as a machine of the window: everything it says comes in as it would from the app's connection. */
export function daemonMachine(daemon: TestDaemon, id = 'local', label = id): TestMachine {
  const listeners = new Set<(method: string, params: unknown) => void>()
  const offs: (() => void)[] = []
  const entry: MachineEntry = {
    id, label, state: 'connected', machine: { id: `${id}-daemon`, hostname: id }, features: daemon.features, extensions: daemon.extensions,
  }
  const machine: TestMachine = {
    id, entry,
    call: (method, params) => daemon.peer.call(method, params),
    listen(listener) {
      if (!listeners.size) {
        for (const event of RELEASED.notifications) {
          offs.push(daemon.peer.on(event, (params: unknown) => {
            if (event === 'features.changed') Object.assign(entry, { features: (params as { features: string[] }).features, extensions: (params as { extensions?: ExtensionManifest[] }).extensions ?? [] })
            for (const l of listeners) l(event, params)
          }))
        }
      }
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
        if (!listeners.size) for (const off of offs.splice(0)) off()
      }
    },
  }
  return machine
}

export type MountOptions = {
  /** UI halves set up as the app's own (bundled), in order. */
  extensions?: UiExtension[]
  /** UI halves set up as a profile's: drawn only in threads of that profile, on that machine. */
  profile?: { ref: ProfileRef; machine?: string; extensions: UiExtension[] }
  /** The machines it reaches: fakes, or test daemons (`daemonMachine`, or the daemon itself as `local`). */
  machines?: (TestMachine | TestDaemon)[]
  /** The user's layout (`app.layout`). */
  layout?: Layout
  /** Phone-narrow: the narrow layout, no rail. */
  narrow?: boolean
  /** The thread shown, to start with. */
  select?: { machine?: string; thread: string }
  app?: AppConfig
}

export type Rendered = {
  container: HTMLElement
  text(): string
  /** The first element `selector` matches, if any. */
  find(selector: string): HTMLElement | null
  /** Click the first button or link whose text is `text` (or that `selector` matches), and let what it set off settle. */
  click(text: string): Promise<void>
  unmount(): Promise<void>
}

export type TestWindow = {
  registry: Registry
  machines: TestMachine[]
  /** Every call the window made (not its watches), by machine. */
  calls: { machine: string; method: string; params: any }[]
  /** Draw a view by its id in a place, or everything the layout puts in a place; for a thread's place, the thread. */
  render(what: { view?: string; place: Place; machine?: string; thread?: string }): Promise<Rendered>
  /** The views the layout puts in `place` (a thread's: give the thread), as ids. */
  placed(place: Place, where?: { machine?: string; thread: string }): string[]
  /** Show a thread (or none), as clicking it in the sidebar would. */
  select(selection: { machine?: string; thread: string } | undefined): Promise<void>
  /** Run an action through the window's router, as code in it would. */
  dispatch(id: string, params?: Record<string, unknown>, options?: { machine?: string }): Promise<unknown>
  /** Press keys (`mod+shift+b`): the action bound to them runs, if one is offered now. Resolves to its id, if one ran. */
  press(keys: string): Promise<string | undefined>
  /** Change what a machine says of itself (gone: `{ state: 'disconnected' }`), as the app's connection would. */
  setMachine(id: string, change: Partial<MachineEntry>): Promise<void>
  /** Set up a profile's UI again (or none), as a change to its files would. */
  installProfile(machine: string, ref: ProfileRef, extensions: UiExtension[]): Promise<void>
  /** Let what's under way settle: answers, effects, renders. */
  settle(): Promise<void>
  /** Wait until `check` holds, letting what's under way settle between tries (a machine's answer, a value changing). */
  until(check: () => boolean, what?: string, timeout?: number): Promise<void>
  /** Take everything down: what's drawn, and every extension's setup (its signal aborted, its cleanup run). */
  unmount(): Promise<void>
}

const isDaemon = (m: TestMachine | TestDaemon): m is TestDaemon => 'peer' in m

/** A window for a test, with your UI halves set up in it. Unmount it after: that takes its DOM away again. */
export async function mountUi(options: MountOptions = {}): Promise<TestWindow> {
  const letGoOfDom = useDom()
  const app = options.app ?? defineApp({ name: 'Superego test', id: 'superego-test' })
  const machines = (options.machines ?? [fakeMachine()]).map((m) => isDaemon(m) ? daemonMachine(m) : m)
  const calls: TestWindow['calls'] = []
  const eventListeners = new Set<(event: SuperegoEvent) => void>()
  const emit = (event: SuperegoEvent) => { for (const l of eventListeners) l(event) }
  // The app's own settings, kept here: the layout among them.
  const appValues: Record<string, Json> = { ...(options.layout ? { [LAYOUT]: options.layout as Json } : {}) }
  const appWatches = new Set<string>()
  let appSubs = 0
  const entries = () => machines.map((m) => ({ ...m.entry }))
  const offs = machines.map((m) => m.listen((method, params) => emit({ machine: m.id, method, params })))
  const bridge: SuperegoBridge = {
    async call(machine, method, params: any) {
      if (machine === 'app') {
        if (method === 'settings.watch') { const sub = `app${++appSubs}`; appWatches.add(sub); return { sub, value: { sections: [], values: appValues } } }
        if (method === 'app.settings.set') {
          appValues[params.key] = params.value
          for (const sub of appWatches) emit({ machine: 'app', method: 'settings.changed', params: { sub, value: { sections: [], values: { ...appValues } } } })
          return null
        }
        if (method === 'unwatch') { appWatches.delete(params.sub); return null }
        if (method === 'action.list') return []
        calls.push({ machine, method, params })
        return null
      }
      const m = machines.find((x) => x.id === machine)
      if (!m) throw new Error(`No machine ${machine} in this test window`)
      if (m.entry.state !== 'connected') throw Object.assign(new Error(`${m.entry.label} is not connected`), { kind: 'disconnected' })
      if (!['value.watch', 'unwatch', 'threads.watch', 'settings.watch', 'extensions.declare', 'action.list'].includes(method)) calls.push({ machine, method, params })
      return m.call(method, params)
    },
    machines: async () => entries(),
    onEvent(listener) { eventListeners.add(listener); return () => { eventListeners.delete(listener) } },
  }
  window.superego = bridge
  // Phone-narrow, or not, as the window's media query asks.
  const narrow = Boolean(options.narrow)
  window.matchMedia = ((query: string) => ({
    matches: narrow && /max-width/.test(query), media: query, onchange: null,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia
  localStorage.clear()
  if (options.select) setLocalState('selection', { machine: options.select.machine ?? machines[0]?.id, thread: options.select.thread }, undefined)

  const registry = windowRegistry(app, options.extensions ?? [])
  if (options.profile) registry.installProfile(options.profile.machine ?? machines[0]!.id, options.profile.ref, options.profile.extensions)

  // The shell's state as the window has it, for the router's context and for `select`.
  let shell: { select(selection: { machine: string; thread: string } | undefined): void; selection?: { machine: string; thread: string }; threads: Record<string, ThreadInfo[] | undefined> } = { select() {}, threads: {} }
  function Shell({ children }: { children: ReactNode }) {
    const { selection, select } = useSelection()
    const all = useAllThreads()
    const list = useMachines()
    shell = { select, ...(selection ? { selection } : {}), threads: all }
    registry.router.setContext({
      app, machines: list, selection, select, openSettings() {}, newThread() {}, togglePalette() {}, toggleNavigator() {}, showLog() {},
      threadOf: (s) => all[s.machine]?.find((t) => t.id === s.thread), sessions: [], lastThread: {},
      appSetting: (key) => appValues[key] as never, toggleSidebar() {}, back() {}, forward() {},
    })
    return <>{children}</>
  }
  const roots = new Set<Root>()
  const settle = async () => {
    for (let i = 0; i < 3; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
  }
  const draw = async (node: ReactNode) => {
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    roots.add(root)
    await act(async () => { root.render(<RegistryProvider registry={registry}><ShellStateProvider><Shell>{node}</Shell></ShellStateProvider></RegistryProvider>) })
    await settle()
    return { container, root }
  }
  // The shell's state, drawn once: machines and their threads followed, selection and context kept.
  const base = await draw(null)
  const machineOf = (id?: string) => id ?? machines[0]!.id

  const ui: TestWindow = {
    registry, machines, calls,
    async render({ view, place, machine, thread }) {
      const at = machineOf(machine)
      if (thread && !threadOf(at, thread)) throw new Error(`No thread ${thread} on ${at}: give it to the machine (threads)`)
      if (view) {
        const info = thread ? threadOf(at, thread) : undefined
        const ids = scopedViews(registry, info ? { machine: at, thread: info } : undefined).map((v) => v.id)
        if (!ids.includes(view)) throw new Error(`No view ${view} ${info ? `in thread ${thread}` : 'in the window'}: ${ids.join(', ') || 'none'}`)
      }
      const { container, root } = await draw(<Draw view={view} place={place} machine={at} thread={thread} registry={registry} />)
      return {
        container,
        text: () => container.textContent ?? '',
        find: (selector) => container.querySelector<HTMLElement>(selector),
        async click(text) {
          const target = [...container.querySelectorAll<HTMLElement>('button, a, [role="button"]')].find((el) => el.textContent?.trim() === text)
            ?? container.querySelector<HTMLElement>(text)
          if (!target) throw new Error(`Nothing to click that says "${text}" in: ${container.textContent}`)
          await act(async () => { target.click() })
          await settle()
        },
        async unmount() { await act(async () => root.unmount()); roots.delete(root); container.remove() },
      }
    },
    placed(place, where) {
      const thread = where && threadOf(machineOf(where.machine), where.thread)
      const scope = thread ? { machine: machineOf(where!.machine), thread } : undefined
      return placedFor(registry, layoutOf(appValues[LAYOUT]), { narrow, where: scope })[place]
    },
    async select(selection) {
      await act(async () => { shell!.select(selection && { machine: machineOf(selection.machine), thread: selection.thread }) })
      await settle()
    },
    async dispatch(id, params = {}, { machine } = {}) {
      let result: unknown
      await act(async () => { result = await registry.router.dispatch(id, params, { source: 'test', ...(machine ? { machine } : {}) }) })
      await settle()
      return result
    },
    async press(keys) {
      const pressed = normalize(keys)
      const action = registry.router.all(shell.selection?.machine).find((a) => bound(a, undefined) === pressed && registry.router.offered(a.id))
      if (!action) return undefined
      await ui.dispatch(action.id)
      return action.id
    },
    async setMachine(id, change) {
      const m = machines.find((x) => x.id === id)
      if (!m) throw new Error(`No machine ${id}`)
      Object.assign(m.entry, change)
      await act(async () => { emit({ machine: 'app', method: '$machines', params: entries() }) })
      await settle()
    },
    async installProfile(machine, ref, extensions) {
      await act(async () => { registry.installProfile(machine, ref, extensions) })
      await settle()
    },
    settle,
    async until(check, what = 'the condition', timeout = 10_000) {
      const end = Date.now() + timeout
      while (!check()) {
        if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`)
        await act(async () => { await new Promise((r) => setTimeout(r, 20)) })
      }
    },
    async unmount() {
      for (const root of [...roots]) await act(async () => root.unmount())
      roots.clear()
      base.container.remove()
      for (const off of offs) off()
      // Every profile's UI torn down; the app's extensions with the registry.
      registry.teardown()
      letGoOfDom()
    },
  }
  const threadOf = (machine: string, id: string) => shell.threads[machine]?.find((t) => t.id === id)
  return ui
}

/** A view (or a place's views) as the window draws it, for the thread given, looked up live. */
function Draw({ view, place, machine, thread, registry }: { view?: string; place: Place; machine: string; thread?: string; registry: Registry }) {
  const machines = useMachines()
  const all = useAllThreads()
  const entry = machines.find((m) => m.id === machine)
  const info = thread ? all[machine]?.find((t) => t.id === thread) : undefined
  if (thread && (!entry || !info)) return null
  if (!view) return <PlacedViews place={place} {...(entry && info ? { machine: entry, thread: info } : {})} />
  const where = entry && info ? { machine: entry.id, thread: info } : undefined
  const found = scopedViews(registry, where).find((v) => v.id === view)
  if (!found) return null
  const Component = found.component as (props: ViewProps) => ReactNode
  return <Component place={place} {...(entry && info ? { machine: entry, thread: info } : {})} />
}
