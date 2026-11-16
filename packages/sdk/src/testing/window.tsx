// A window for a test: your UI halves set up in the real registry, drawn by the real shell state over a bridge to fake
// machines (whose methods, values and threads you give) or to test daemons (`testDaemon`), in a DOM of its own
// (happy-dom's, laid over Node's globals while it's mounted). Draw a view or a place, click in it, press keys, change a machine (gone,
// an older Superego) and see what it does.
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import {
  defineApp, RELEASED, type ActionInfo, type AppConfig, type ExtensionManifest, type Json, type Notifications, type ProfileRef, type ThreadInfo,
} from '@superego/protocol'
import type { MachineEntry, SuperegoBridge, SuperegoEvent } from '@superego/app/shared'
import {
  bound, DescribedCall, describeRun, LAYOUT, layoutOf, linkHandler, mainKind, normalize, pageApp, PaneBody, paneKind, placedFor, PlacedViews, profileUisLoaded, RegistryProvider, resetProfileUi,
  scopedViews, seenIn, setLocalState, Shell as Window, ShellStateProvider, Slot, toolRow, urlKind, ViewScopeProvider, useAllThreads, useMachines, useSelection, windowRegistry,
  type BehaviourSlot, type Layout, type Place, type Registry, type SlotProps, type UiExtension, type ViewProps,
} from '@superego/app/internals'
import type { LinkHandler, LinkWhere, ToolRow, ToolRowCall } from '@superego/app/ui'
import type { TestDaemon } from './daemon.ts'
import { useDom } from './dom.ts'

/**
 * React's `act`, with React told it's in a test only while the window acts. What the window does (draw, click, select,
 * settle, wait) goes through here, and what it sets off lands before it returns. A window over a machine is live too:
 * answers and values come in between, as they would in the app, and React draws those on its own schedule then, rather
 * than warning that they weren't in `act` (no test could have put them there).
 */
function inAct(work: () => Promise<unknown>): Promise<void> {
  enterAct()
  // Left as React lets go of its queue, not a microtask later: what resolves in between would draw outside it.
  return new Promise((resolve, reject) => {
    act(async () => { await work() }).then(() => { leaveAct(); resolve() }, (error: unknown) => { leaveAct(); reject(error) })
  })
}

/**
 * `inAct` for what's done at once (a machine's notification): drawn before it returns. While the window acts already,
 * it's in that act's: an act of its own would end React's early, leaving the rest of that one outside.
 */
function inActNow(work: () => void) {
  if (acting) return work()
  enterAct()
  try { act(work) } finally { leaveAct() }
}

let acting = 0
const actEnvironment = (on: boolean) => { (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = on }
function enterAct() { if (acting++ === 0) actEnvironment(true) }
function leaveAct() { if (--acting === 0) actEnvironment(false) }

/** A machine the window talks to: how it answers, and what it says. */
export type TestMachine = {
  id: string
  /** The machine as the window lists it: its label, state, features and extensions. */
  entry: MachineEntry
  /** Answer one of the window's calls. */
  call(method: string, params: unknown): Promise<unknown>
  /** Tell `tell` of every notification it sends, until the function returned is called. */
  listen(tell: (method: string, params: unknown) => void): () => void
  /** A fake's: change a live value (whole, or one scope's part) and tell its watchers. */
  setValue?(key: string, value: Json, scope?: string): void
}

/** What a `fakeMachine` is and answers. */
export type FakeMachineOptions = {
  /** Its id: `local` unless given. */
  id?: string
  /** Its name in the window: its id unless given. */
  label?: string
  /** Its protocol features (`FEATURES`): those its generation released unless given. */
  features?: string[]
  /** The extensions set up there, each at its version (a name alone: at the version of the window's UI half of it, else 1.0.0). */
  extensions?: (ExtensionManifest | string)[]
  /** Its threads. */
  threads?: ThreadInfo[]
  /** Its live values, by key: what `value.watch` answers. A scoped value: its scopes' values, by scope. */
  values?: Record<string, Json>
  /** Its methods and actions, by name: what a call answers (thrown: the call fails). */
  methods?: Record<string, (params: any) => unknown>
  /** Its actions as data, for keys and the palette (`action.list`). */
  actions?: ActionInfo[]
  /** Whether the window reaches it: `connected` unless given. */
  state?: MachineEntry['state']
}

/** A thread to show, with what a daemon would say of it; give what matters to the test. */
export function testThread(thread: Partial<ThreadInfo> = {}): ThreadInfo {
  const id = thread.id ?? `t${++threads}`
  return {
    id, title: `Thread ${id}`, cwd: '/work', createdAt: 0, activeAt: 0, project: { root: '/work', name: 'work' }, status: { state: 'idle' },
    ...thread,
  }
}
let threads = 0

/** The features a daemon of this generation offers. */
const CURRENT: string[] = [...RELEASED.features]

/**
 * A machine of your making: its threads, values and methods answer the window's calls; any other call fails as an
 * unknown method would. Everything asked of it is in `calls` (the window's, by method).
 */
export function fakeMachine(options: FakeMachineOptions = {}): TestMachine & { calls: { method: string; params: any }[]; setValue(key: string, value: Json, scope?: string): void } {
  const id = options.id ?? 'local'
  // A name alone takes its version from the window it's mounted in (see `mountUi`).
  const extensions = (options.extensions ?? []).map((e): ExtensionManifest => typeof e === 'string' ? { name: e } : e)
  const features = options.features ?? CURRENT
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
      if (!['value.watch', 'unwatch', 'threads.watch', 'settings.watch', 'extension.declare', 'action.list'].includes(method)) calls.push({ method, params })
      if (method === 'value.watch') {
        const sub = `v${++subs}`
        const scope = params.scope as string | undefined
        const value = partOf(params.key, scope)
        watches.set(sub, { key: params.key, ...(scope !== undefined ? { scope } : {}), last: JSON.stringify(value) })
        return { sub, value }
      }
      if (method === 'unwatch') { watches.delete(params.sub); return null }
      if (method === 'threads.watch') return { sub: `t${++subs}`, value: params.hidden ? [] : options.threads ?? [] }
      if (method === 'thread.list') return params.archived ? [] : options.threads ?? []
      if (method === 'settings.watch') return { sub: `s${++subs}`, value: { sections: [], values: {} } }
      if (method === 'extension.declare') return null
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
            if (event === 'features.changed') {
              const { features, extensions } = params as Notifications['features.changed']
              Object.assign(entry, { features, extensions })
            }
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

/** What `mountUi` sets up: your UI halves, the machines the window reaches, and what it shows. */
export type MountOptions = {
  /** UI halves set up as the app's own (bundled), in order. */
  extensions?: UiExtension[]
  /** UI halves set up as a profile's: drawn only in threads of that profile, on that machine. One that fails to start throws. */
  profile?: { ref: ProfileRef; machine?: string; extensions: UiExtension[] }
  /** The machines it reaches: fakes, or test daemons (`daemonMachine`, or the daemon itself as `local`). */
  machines?: (TestMachine | TestDaemon)[]
  /** The user's layout (`app.layout`). */
  layout?: Layout
  /** Phone-narrow: the narrow layout, no rail. */
  narrow?: boolean
  /** The thread shown, to start with. */
  select?: { machine?: string; thread: string }
  /** The app the window is: a test one unless given. */
  app?: AppConfig
  /**
   * Draw the whole window, as the app does (`ui.window`): the rail, the sidebar, the title bar, the thread shown and what's
   * beside it, the palette (⌘K), Settings. Keys pressed on it (`ui.key`) go where the app's would.
   */
  window?: boolean
}

/**
 * What `render` draws, and for which thread: `thread` an id of one the machine has (followed as it changes), or a
 * `ThreadInfo` as it is (`testThread({ profile })`, say). A pane or a thread's slot without one: the selected thread,
 * else the machine's first, else a test thread (of `mountUi`'s profile, if it has one).
 */
export type RenderWhat<S extends BehaviourSlot = BehaviourSlot> = { machine?: string; thread?: string | ThreadInfo } & (
  /** A view by its id in a place, or everything the layout puts in a place. */
  | { view?: string; place: Place }
  /** A pane of a kind, as the thread's panes draw it, with its params. */
  | { pane: { kind: string; params?: Json; title?: string; id?: string } }
  /** Everything in a slot, as the window draws it, with the props it gives (a thread's slots: its machine and thread; the editor's: `path`, `open`). */
  | { slot: S; props?: Partial<SlotProps[S]> }
  /** A tool call's row in the transcript, as the extension that describes the tool says (`superego.tool`): `state` done unless given. */
  | { tool: { name: string; arguments?: Record<string, unknown>; id?: string } & Partial<Pick<ToolRowCall, 'state' | 'result' | 'live'>> }
)

/** Where in the window a lookup is for: a machine (the first, unless given) and a thread, as `render` takes them. */
export type TestWhere = { machine?: string; thread?: string | ThreadInfo }

/** What `render` drew, to look in and click. */
export type Rendered = {
  /** The element it's drawn in. */
  container: HTMLElement
  /** All its text, as it reads now. */
  text(): string
  /** The first element `selector` matches, if any. */
  find(selector: string): HTMLElement | null
  /** Click the first button or link whose text is `text` (or that `selector` matches), and let what it set off settle. */
  click(text: string): Promise<void>
  /** Take it away (the window stays). */
  unmount(): Promise<void>
}

/** A window `mountUi` set up: draw places and views in it, click, press keys, change machines, and wait for it. */
export type TestWindow = {
  /** What the extensions set up in it: the window's own workings, which change with it. */
  registry: Registry
  /** The machines it reaches. */
  machines: TestMachine[]
  /** Every call the window made (not its watches), by machine. */
  calls: { machine: string; method: string; params: any }[]
  /** The whole window, as `mountUi({ window: true })` draws it, with what it opens over itself (menus, dialogs). */
  window: Rendered | undefined
  /**
   * A key pressed where the focus is (the window's body, if nothing has it), as the keyboard sends it: `mod+k`,
   * `shift+mod+]`, `escape`, `enter`, `ctrl+1`. Unlike `press`, it goes through the page: what has the focus hears it
   * first, then the window's shortcuts.
   */
  key(keys: string): Promise<void>
  /**
   * Type `text` into the field `selector` matches (in the whole page), as a person would: focused, its value set, an input
   * event. React hears it only in a DOM that was there as it loaded (`// @vitest-environment happy-dom`).
   */
  type(selector: string, text: string): Promise<void>
  /**
   * Draw a view by its id in a place, or everything the layout puts in a place (a thread's place: give the thread); a
   * pane of a kind (`{ pane: { kind, params } }`); or what fills a slot (`{ slot: 'thread.badge', thread }`). A view,
   * pane kind or slot that the window wouldn't draw there throws, saying what it would.
   */
  render<S extends BehaviourSlot>(what: RenderWhat<S>): Promise<Rendered>
  /** The views the layout puts in `place` (a thread's: give the thread), as ids. */
  placed(place: Place, where?: { machine?: string; thread: string }): string[]
  /**
   * How the transcript reads calls to the tool `name` in a thread (`where`: as `render`'s), as the extension that
   * describes them said (`superego.tool`, a prefix's like `mcp__*`); `{}`, the core's defaults. Draw one with
   * `render({ tool })`.
   */
  toolRow(name: string, where?: TestWhere): ToolRow
  /** A run of calls to these tools, as its folded line says it ("Read 2 files and ran a command"), in parts. */
  describeRun(tools: string[], where?: TestWhere): string[]
  /** Which tool a run of calls to these is shown as (its icon): the weightiest. */
  mainKind(tools: string[], where?: TestWhere): string
  /**
   * What claims `href` (a link's, or inline code's text) in a thread's messages (`where.thread`), or outside any thread
   * without one (a settings page): its handler, if one claims it.
   */
  linkHandler(href: string, kind: 'link' | 'code', where?: TestWhere): LinkHandler | undefined
  /** The pane kind web pages open in, in a thread (`where`: as `render`'s), if any shows them. */
  urlKind(where?: TestWhere): string | undefined
  /** Show a thread (or none), as clicking it in the sidebar would. */
  select(selection: { machine?: string; thread: string } | undefined): Promise<void>
  /** Run an action through the window's router, as code in it would. */
  dispatch(id: string, params?: Record<string, unknown>, options?: { machine?: string }): Promise<unknown>
  /** Press keys (`mod+shift+b`): the action bound to them runs, if one is offered now. Resolves to its id, if one ran. */
  press(keys: string): Promise<string | undefined>
  /** Change what a machine says of itself (gone: `{ state: 'disconnected' }`), as the app's connection would. */
  setMachine(id: string, change: Partial<MachineEntry>): Promise<void>
  /** Set up a profile's UI again (or none), as a change to its files would. One that fails to start throws. */
  installProfile(machine: string, ref: ProfileRef, extensions: UiExtension[]): Promise<void>
  /** Let what's under way settle: answers, effects, renders. */
  settle(): Promise<void>
  /** Wait until `check` holds (or its promise gives true), letting what's under way settle between tries (a machine's answer, a value changing). */
  until(check: () => boolean | Promise<boolean>, what?: string, timeout?: number): Promise<void>
  /**
   * Take everything down: what's drawn, and every extension's setup (its signal aborted, its cleanup run). A profile's UI
   * it's still fetching lands first: unmount before closing the daemons it's on.
   */
  unmount(): Promise<void>
}

const isDaemon = (m: TestMachine | TestDaemon): m is TestDaemon => 'peer' in m

/**
 * A window for a test: your UI halves set up in the real registry, drawn by the real shell state over a bridge to fake
 * machines (`fakeMachine`) or test daemons (`daemonMachine`), in a DOM of its own. Draw a view or a place, click in it,
 * press keys, change a machine and see what it does. Unmount it after: that takes its DOM away again.
 *
 *   const ui = await mountUi({ extensions: [builds], machines: [fakeMachine({ values: { 'builds.queue': [] } })] })
 *   const beside = await ui.render({ place: 'beside', thread: thread.id })
 *   expect(beside.text()).toContain('No builds queued')
 *   await ui.unmount()
 */
export async function mountUi(options: MountOptions = {}): Promise<TestWindow> {
  const letGoOfDom = useDom()
  const app = options.app ?? defineApp({ name: 'Superego test', id: 'superego-test' })
  // A fake's extension named alone is at the version of the UI half mounted here: the two speak. On this window's copy
  // of its entry, so a fake mounted again takes the next window's versions.
  const versioned = (m: TestMachine): TestMachine => ({
    ...m,
    entry: {
      ...m.entry,
      ...(m.entry.extensions ? { extensions: m.entry.extensions.map((e) => e.version !== undefined ? e
        : { ...e, version: options.extensions?.find((x) => x.name === e.name)?.version ?? '1.0.0' }) } : {}),
    },
  })
  const machines = (options.machines ?? [fakeMachine()]).map((m) => isDaemon(m) ? daemonMachine(m) : versioned(m))
  const calls: TestWindow['calls'] = []
  const eventListeners = new Set<(event: SuperegoEvent) => void>()
  const emit = (event: SuperegoEvent) => { for (const l of eventListeners) l(event) }
  // The app's own endpoint, as a browser's page keeps it: its settings (the layout among them) the app's own.
  const appSide = pageApp((event) => inActNow(() => emit(event)))
  if (options.layout) await appSide.settings.set(LAYOUT, options.layout as Json).catch((error: unknown) => { letGoOfDom(); throw error })
  const entries = () => machines.map((m) => ({ ...m.entry }))
  // What a machine says (a live value changing, a thread's status) re-renders what shows it: in `act`, as React asks of a test.
  const offs = machines.map((m) => m.listen((method, params) => inActNow(() => emit({ machine: m.id, method, params }))))
  const bridge: SuperegoBridge = {
    async call(machine, method, params: any) {
      if (machine === 'app') {
        const answer = appSide.answer(method)
        if (answer) return answer(params as never)
        // The window says which thread it shows, on every selection, and which keys it takes: the app's business, not a test's.
        if (method === 'app.shown' || method === 'app.boundKeys') return null
        if (method === 'app.windows') return []
        // The window and the app it's in are one build here.
        if (method === 'app.build') return { differs: false }
        calls.push({ machine, method, params })
        return null
      }
      const m = machines.find((x) => x.id === machine)
      if (!m) throw new Error(`No machine ${machine} in this test window`)
      if (m.entry.state !== 'connected') throw Object.assign(new Error(`${m.entry.label} is not connected`), { kind: 'disconnected' })
      if (!['value.watch', 'unwatch', 'threads.watch', 'settings.watch', 'extension.declare', 'action.list'].includes(method)) calls.push({ machine, method, params })
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

  // The window logs a profile's UI that fails to start and goes on without it; a test fails on it.
  const install = (into: Registry, machine: string, ref: ProfileRef, extensions: UiExtension[]) => {
    const [failed] = into.installProfile(machine, ref, extensions)
    if (failed) throw failed.error
  }
  const registry = (() => {
    let made: Registry | undefined
    try {
      made = windowRegistry(app, options.extensions ?? [])
      if (options.profile) install(made, options.profile.machine ?? machines[0]!.id, options.profile.ref, options.profile.extensions)
      return made
    } catch (error) {
      made?.teardown()
      for (const off of offs) off()
      letGoOfDom()
      throw error
    }
  })()
  // As the app sets a window up: the app's own actions fetched, and the app settings its extensions declare registered.
  await registry.router.load('app')
  for (const { owner: _owner, ...section } of registry.appSettings) await appSide.call('settings.register', { section })

  // The shell's state as the window has it, for the router's context and for `select`.
  let shell: { select(selection: { machine: string; thread: string } | undefined): void; selection?: { machine: string; thread: string }; threads: Record<string, ThreadInfo[] | undefined> } = { select() {}, threads: {} }
  function Shell({ children }: { children: ReactNode }) {
    const { selection, select } = useSelection()
    const all = useAllThreads()
    const list = useMachines()
    shell = { select, ...(selection ? { selection } : {}), threads: all }
    // The whole window drawn: its shell says what actions see, as the app's does.
    if (options.window) return <>{children}</>
    registry.router.setContext({
      app, machines: list, selection, select, openSettings() {}, newThread() {}, togglePalette() {}, toggleNavigator() {}, showLog() {},
      threadOf: (s) => all[s.machine]?.find((t) => t.id === s.thread), projects: [], lastThread: {},
      appSetting: (key) => appSide.settings.get(key) as never, toggleSidebar() {}, back() {}, forward() {}, railTabs: () => [],
    })
    return <>{children}</>
  }
  const roots = new Set<Root>()
  const settle = async () => {
    for (let i = 0; i < 3; i++) await inAct(async () => { await new Promise((r) => setTimeout(r, 0)) })
  }
  const draw = async (node: ReactNode) => {
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    roots.add(root)
    await inAct(async () => { root.render(<RegistryProvider registry={registry}><ShellStateProvider><Shell>{node}</Shell></ShellStateProvider></RegistryProvider>) })
    await settle()
    return { container, root }
  }
  // The shell's state, drawn once: machines and their threads followed, selection and context kept. The whole window, if asked.
  const base = await draw(options.window ? <Window /> : null)
  const machineOf = (id?: string) => id ?? machines[0]!.id

  /** What's drawn in `container`, to look in and click. */
  const rendered = (container: HTMLElement, unmount: () => Promise<void>): Rendered => ({
    container,
    text: () => container.textContent ?? '',
    find: (selector) => container.querySelector<HTMLElement>(selector),
    async click(text) {
      const target = [...container.querySelectorAll<HTMLElement>('button, a, [role="button"]')].find((el) => el.textContent?.trim() === text)
        ?? container.querySelector<HTMLElement>(text)
      if (!target) throw new Error(`Nothing to click that says "${text}" in: ${container.textContent}`)
      await inAct(async () => { target.click() })
      await settle()
    },
    unmount,
  })

  const ui: TestWindow = {
    registry, machines, calls,
    // The page's body: what the window opens over itself (menus, dialogs, the palette) is drawn there, outside its root.
    window: options.window ? rendered(document.body, async () => { throw new Error('The whole window goes with the test window: unmount that') }) : undefined,
    async key(keys) {
      const parts = keys.toLowerCase().split('+')
      const name = parts.pop()!
      const mac = navigator.platform ? navigator.platform.startsWith('Mac') : process.platform === 'darwin'
      const key = KEY_NAMES[name] ?? name
      const init: KeyboardEventInit = {
        key, code: /^[a-z]$/.test(name) ? `Key${name.toUpperCase()}` : /^[0-9]$/.test(name) ? `Digit${name}` : CODES[name] ?? key,
        metaKey: parts.includes('meta') || (mac && parts.includes('mod')), ctrlKey: parts.includes('ctrl') || (!mac && parts.includes('mod')),
        shiftKey: parts.includes('shift'), altKey: parts.includes('alt'), bubbles: true, cancelable: true,
      }
      const target = document.activeElement && document.activeElement !== document.body ? document.activeElement : document.body
      const view = target.ownerDocument.defaultView as unknown as typeof globalThis
      await inAct(async () => {
        if (target.dispatchEvent(new view.KeyboardEvent('keydown', init))) target.dispatchEvent(new view.KeyboardEvent('keyup', init))
      })
      await settle()
    },
    async type(selector, text) {
      const field = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector)
      if (!field) throw new Error(`No field ${selector} to type into`)
      await inAct(async () => {
        field.focus()
        Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), 'value')!.set!.call(field, text)
        // The DOM's own Event (Node has one of its own, which the DOM refuses).
        const view = field.ownerDocument.defaultView as unknown as typeof globalThis
        field.dispatchEvent(new view.Event('input', { bubbles: true }))
      })
      await settle()
    },
    async render(what) {
      const at = machineOf(what.machine)
      const given = what.thread
      if (typeof given === 'string' && !threadOf(at, given)) throw new Error(`No thread ${given} on ${at}: give it to the machine (threads), or give a ThreadInfo`)
      let node: ReactNode
      if ('tool' in what) {
        const { name, arguments: args = {}, id = 'call-1', state = 'done', ...rest } = what.tool
        const thread = given ?? defaultThread(at)
        node = <InThread machine={at} thread={thread} draw={(machine, info) =>
          <DescribedCall row={toolRow(registry, name, { machine: at, thread: info })} call={{ machine, thread: info, call: { id, name, arguments: args }, state, ...rest }} />} />
      } else if ('pane' in what || ('slot' in what && what.slot !== 'overlay' && what.slot !== 'onboarding')) {
        // A pane or a thread's slot is always some thread's.
        const thread = given ?? defaultThread(at)
        const info = typeof thread === 'string' ? threadOf(at, thread)! : thread
        const where = { machine: at, thread: info }
        if ('pane' in what) {
          if (!paneKind(registry, what.pane.kind, where)) {
            const kinds = [...new Set(seenIn(registry.panes, where).map((p) => p.kind))]
            const theirs = registry.panes.some((p) => p.kind === what.pane.kind && p.owner.profile)
            throw new Error(`No pane kind ${what.pane.kind} in thread ${info.id}${theirs ? " (a profile's pane kinds are its threads': give a thread of that profile)" : ''}: ${kinds.join(', ') || 'none'}`)
          }
          const { kind, params, title, id = 'pane-1' } = what.pane
          const pane = { id, kind, ...(params !== undefined ? { params } : {}), ...(title !== undefined ? { title } : {}) }
          node = <InThread machine={at} thread={thread} draw={(machine, info) => <PaneBody machine={machine} thread={info} pane={pane} />} />
        } else {
          const slot = slotNamed(what.slot)
          if (!seenIn(registry.slots[slot], where).length) {
            const theirs = registry.slots[slot].length
            throw new Error(`Nothing fills ${slot} in thread ${info.id}${theirs ? ` (${theirs} elsewhere: a profile's fill its threads' slots, and a thread goes without an optional extension it names in without)` : ''}`)
          }
          const props = what.props as Record<string, unknown> | undefined
          node = <InThread machine={at} thread={thread} draw={(machine, info) =>
            <Slot name={slot} props={{ path: '', open() {}, ...props, machine, thread: info } as never} />} />
        }
      } else if ('slot' in what) {
        if (!registry.slots.overlay.length) throw new Error('Nothing fills overlay: only the app\'s extensions can')
        node = <Slot name="overlay" props={{}} />
      } else {
        const { view, place } = what
        if (view) {
          const info = given === undefined ? undefined : typeof given === 'string' ? threadOf(at, given) : given
          const ids = scopedViews(registry, info ? { machine: at, thread: info } : undefined).map((v) => v.id)
          if (!ids.includes(view)) throw new Error(`No view ${view} ${info ? `in thread ${info.id}` : 'in the window'}: ${ids.join(', ') || 'none'}`)
        }
        node = <Draw view={view} place={place} machine={at} thread={given} registry={registry} />
      }
      const { container, root } = await draw(node)
      return rendered(container, async () => { await inAct(async () => root.unmount()); roots.delete(root); container.remove() })
    },
    placed(place, where) {
      const thread = where && threadOf(machineOf(where.machine), where.thread)
      const scope = thread ? { machine: machineOf(where!.machine), thread } : undefined
      return placedFor(registry, layoutOf(appSide.settings.get(LAYOUT)), { narrow, where: scope })[place]
    },
    toolRow: (name, where) => toolRow(registry, name, whereOf(where)),
    describeRun: (tools, where) => describeRun(tools.map(called), (name) => toolRow(registry, name, whereOf(where))),
    mainKind: (tools, where) => mainKind(tools.map(called), (name) => toolRow(registry, name, whereOf(where))),
    linkHandler(href, kind, where = {}) {
      const at: LinkWhere = where.thread === undefined ? {} : whereOf(where)
      return linkHandler(registry, href, kind, at)
    },
    urlKind: (where) => urlKind(registry, whereOf(where)),
    async select(selection) {
      await inAct(async () => { shell!.select(selection && { machine: machineOf(selection.machine), thread: selection.thread }) })
      await settle()
    },
    async dispatch(id, params = {}, { machine } = {}) {
      let result: unknown
      await inAct(async () => { result = await registry.router.dispatch(id, params, { source: 'test', ...(machine ? { machine } : {}) }) })
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
      await inAct(async () => { emit({ machine: 'app', method: '$machines', params: entries() }) })
      await settle()
    },
    async installProfile(machine, ref, extensions) {
      await inAct(async () => { install(registry, machine, ref, extensions) })
      await settle()
    },
    settle,
    async until(check, what = 'the condition', timeout = 10_000) {
      const end = Date.now() + timeout
      while (!await check()) {
        if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`)
        await inAct(async () => { await new Promise((r) => setTimeout(r, 20)) })
      }
    },
    async unmount() {
      // A profile's UI the window is still fetching from a machine lands first: else closing a daemon next fails it.
      await inAct(async () => { await profileUisLoaded() })
      for (const root of [...roots]) await inAct(async () => root.unmount())
      roots.clear()
      base.container.remove()
      for (const off of offs) off()
      // Every profile's UI torn down; the app's extensions with the registry.
      registry.teardown()
      // The next window fetches its profiles' UI afresh.
      resetProfileUi()
      letGoOfDom()
    },
  }
  const threadOf = (machine: string, id: string) => shell.threads[machine]?.find((t) => t.id === id)
  /** A lookup's machine and thread, as `render` picks them. */
  const whereOf = (where: TestWhere = {}) => {
    const machine = machineOf(where.machine)
    const thread = where.thread ?? defaultThread(machine)
    const info = typeof thread === 'string' ? threadOf(machine, thread) : thread
    if (!info) throw new Error(`No thread ${String(thread)} on ${machine}: give it to the machine (threads), or give a ThreadInfo`)
    return { machine, thread: info }
  }
  /** A call to the tool `name`, as a run's blocks have it. */
  const called = (name: string) => ({ type: 'toolCall' as const, id: name, name, arguments: {} })
  // The thread a pane or slot is drawn for when none is given: the selected one, the machine's first, else one made up.
  const defaultThread = (machine: string): string | ThreadInfo => {
    if (shell.selection?.machine === machine && threadOf(machine, shell.selection.thread)) return shell.selection.thread
    const first = shell.threads[machine]?.[0]
    if (first) return first.id
    const ref = options.profile && (options.profile.machine ?? machines[0]!.id) === machine ? options.profile.ref : undefined
    return testThread({ id: 'test', ...(ref ? { profile: ref } : {}) })
  }
  const slotNamed = <S extends BehaviourSlot>(slot: S): S => {
    if (slot in registry.slots) return slot
    throw new Error(`No slot ${slot}: ${Object.keys(registry.slots).join(', ')} (one that's a place now is a view: render({ view, place }))`)
  }
  return ui
}

/** Keys by the names `ui.key` takes, as a keyboard event says them. */
const KEY_NAMES: Record<string, string> = {
  enter: 'Enter', escape: 'Escape', esc: 'Escape', tab: 'Tab', backspace: 'Backspace', delete: 'Delete', space: ' ',
  up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight',
}
/** Punctuation keys' places on the keyboard, which shortcuts go by (what they type changes with shift). */
const CODES: Record<string, string> = {
  '[': 'BracketLeft', ']': 'BracketRight', '/': 'Slash', '.': 'Period', ',': 'Comma', '`': 'Backquote', '\\': 'Backslash',
  ';': 'Semicolon', "'": 'Quote', '-': 'Minus', '=': 'Equal',
}

/** A view (or a place's views) as the window draws it, for the thread given, looked up live. */
function Draw({ view, place, machine, thread, registry }: { view?: string; place: Place; machine: string; thread?: string | ThreadInfo; registry: Registry }) {
  const machines = useMachines()
  const all = useAllThreads()
  const entry = machines.find((m) => m.id === machine)
  const info = typeof thread === 'string' ? all[machine]?.find((t) => t.id === thread) : thread
  if (thread && (!entry || !info)) return null
  if (!view) return <PlacedViews place={place} {...(entry && info ? { machine: entry, thread: info } : {})} />
  const where = entry && info ? { machine: entry.id, thread: info } : undefined
  const found = scopedViews(registry, where).find((v) => v.id === view)
  if (!found) return null
  const Component = found.component as (props: ViewProps) => ReactNode
  return <ViewScopeProvider value={where}><Component place={place} {...(entry && info ? { machine: entry, thread: info } : {})} /></ViewScopeProvider>
}

/** What `draw` gives, for the machine and thread as the window has them now (a thread given whole: as given). */
function InThread({ machine, thread, draw }: { machine: string; thread: string | ThreadInfo; draw: (machine: MachineEntry, thread: ThreadInfo) => ReactNode }) {
  const entry = useMachines().find((m) => m.id === machine)
  const all = useAllThreads()
  const info = typeof thread === 'string' ? all[machine]?.find((t) => t.id === thread) : thread
  if (!entry || !info) return null
  return <>{draw(entry, info)}</>
}
