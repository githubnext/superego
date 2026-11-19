// The window's side of actions. Window actions run here with the shell's context; machine and app actions are
// forwarded to where they run (see `dispatch`). Every dispatch from this window is logged, and the log is one action
// away (Show action log).
import { useEffect, useState } from 'react'
import { createRouter, int, lit, obj, offers, opt, str, type Router, union, type ActionDef, type ActionInfo, type ActionLogEntry, type AppConfig, type Exposure, type Json, type JsonSchema, type Static } from '@superego/protocol'
import { Dialog } from '@superego/ui'
import type { ReturnedMessage, ThreadInfo } from '@superego/protocol'
import type { MachineEntry } from '../shared/bridge.ts'
import { APP, PANE_LAYOUT, type PaneLayout } from '../shared/app-settings.ts'
import type { NewThreadStart, Selection } from './state.tsx'
import { threadBeside, type Project, type Sidebar } from './projects.ts'
import { isPinned, pinAt, PINS, pinsOf, unpin, type Pin } from './pins.ts'
import { focusBeside, focusColumn, focusPrompt, focusThread } from './focus.ts'
import { scrollHalfPage } from './scroll.ts'
import { startRename } from './rename.ts'
import { setLocalState, windowState } from './local-state.ts'
import { giveBack } from './returned.ts'
import { clearProblem, reportProblem } from './machine-problems.ts'
import { showOnboarding } from './Onboarding.tsx'
import { maximizedStore, THREAD_COLUMN, toggleMaximized } from './maximized.ts'
import { NARROW } from './media.ts'
import { RAIL_TABS, tabAction, type RailTab } from './rail-tabs.ts'

/** What a window action gets besides its parameters. */
export type WindowContext = {
  app: AppConfig
  machines: MachineEntry[]
  selection: Selection | undefined
  select(selection: Selection | undefined): void
  openSettings(): void
  newThread(start?: NewThreadStart): void
  togglePalette(): void
  showLog(): void
  /** The thread a selection points at, as the window has it. */
  threadOf(selection: Selection): ThreadInfo | undefined
  /** Every project, in the sidebar's order, and the thread last shown in each (by project key). */
  projects: Project[]
  /** What the sidebar lists, top to bottom: the pinned threads, then the projects with the rest. */
  sidebar: Sidebar
  lastThread: Record<string, string>
  /** Fold sections or threads in the sidebar, by key (projects.ts's `fold`), or unfold them. */
  fold(keys: readonly string[], folded: boolean): void
  toggleSidebar(): void
  /**
   * Show the space `id` in the sidebar (the sidebar shown if it was hidden; on a phone, its drawer opened) and focus what's
   * used there: its selected row, else its first. Throws when `id` isn't one of the window's spaces.
   */
  focusSpace(id: string): void
  toggleNavigator(): void
  /** The picker of panes to open beside the selected thread (⌘⇧P). */
  togglePanePicker(): void
  /** The rail's tabs that ⌘1–⌘9 go to, as the rail is now (none on a phone, which has no rail). */
  railTabs(): RailTab[]
  /** Back and forward through the threads (and Settings) this window has shown. */
  back(): void
  forward(): void
  /** One of the app's settings as it is now (`useAppSetting` in components). */
  appSetting<T extends Json>(key: string): T | undefined
  dispatch: Dispatch
}

/**
 * Run an action by id, wherever it runs: a window action here; an app action in the main process; a machine action on
 * `options.machine`, else the selected thread's machine, else this computer. A thread action takes the selected
 * thread when its `id` isn't given.
 */
export type Dispatch = (id: string, params?: Record<string, unknown>, options?: { source?: string; machine?: string }) => Promise<unknown>

/**
 * An action that runs in the window. `when` says whether it applies now (a thread is selected, a pane has the focus):
 * keys and the palette offer it only then. Dispatching it from code runs it regardless.
 */
export type WindowAction = ActionDef<any, unknown, WindowContext> & { when?: (context: WindowContext) => boolean }

/**
 * Define a window action: with a pi-schema `params`, `run` gets them typed, and the window's context. `runs` is the
 * window's; `when`, if given, says when keys and the palette offer it.
 */
export function defineWindowAction<S extends JsonSchema | undefined = undefined, R = unknown>(
  def: Omit<ActionInfo, 'params' | 'expose' | 'runs'> & {
    params?: S; expose?: Exposure[]
    run(params: S extends JsonSchema ? Static<S> : Record<string, never>, context: WindowContext): R | Promise<R>
    when?: (context: WindowContext) => boolean
  },
): WindowAction {
  return { expose: ['ui'], ...def, runs: 'window' } as WindowAction
}

export function createWindowRouter() {
  const router = createRouter<WindowContext>()
  /** When each window action applies, for those that say. */
  const conditions = new Map<string, (context: WindowContext) => boolean>()
  /** The shell keeps this current; actions read it when they run. */
  let context: WindowContext | undefined
  /** What the app and each machine offer, by target (`APP` or a machine id). */
  const remote = new Map<string, ActionInfo[]>()
  const listeners = new Set<() => void>()
  let version = 0

  const dispatch: Dispatch = (id, params = {}, { source = 'ui', machine } = {}) => {
    if (router.has(id)) {
      if (!context) return Promise.reject(new Error('The window is not ready'))
      return router.dispatch(id, params, context, { source })
    }
    if (machine === APP || remote.get(APP)?.some((a) => a.id === id)) {
      return router.track(id, params, source, () => window.superego.call(APP, id, params))
    }
    const target = machine ?? (typeof params.machine === 'string' ? params.machine : undefined) ?? context?.selection?.machine ?? 'local'
    const action = remote.get(target)?.find((a) => a.id === id)
    const { machine: _machine, ...rest } = params
    const filled = action?.thread && rest.thread === undefined && context?.selection?.machine === target ? { ...rest, thread: context.selection.thread } : rest
    // Through action.run: it finds actions registered after this window connected (a profile's, as it loads).
    const ran = router.track(id, filled, `${source} → ${target}`, () => window.superego.call(target, 'action.run', { id, params: filled }))
    // A pane opened from this window was asked for here: the focus goes into it. (The agent's open beside, unfocused.)
    if (id === 'pane.open') void ran.then((pane) => { const opened = (pane as { id?: string } | null)?.id; if (opened) focusColumn(opened) }, () => {})
    // A stop from this window gives the messages you'd queued back to the thread's composer here, to write again: this
    // window's, as it pressed Stop (one window, so they come back once). An older daemon answers null: they're gone.
    if (id === 'thread.stop' && typeof filled.thread === 'string') {
      const thread = filled.thread
      void ran.then((stopped) => giveBack(target, thread, (stopped as { returned?: ReturnedMessage[] } | null)?.returned ?? []), () => {})
    }
    return ran
  }

  return {
    router,
    dispatch,
    /** Add a window action; the returned function removes it again. */
    register(action: WindowAction): () => void {
      const { when, ...def } = action
      const off = router.register({ ...def, runs: 'window' })
      if (when) conditions.set(action.id, when)
      return () => { off(); if (conditions.get(action.id) === when) conditions.delete(action.id) }
    },
    /** Whether keys and the palette offer `id` now: an action elsewhere always; a window action while its `when` holds. */
    offered(id: string): boolean {
      const when = conditions.get(id)
      if (!when) return true
      if (!context) return false
      try { return when(context) } catch (error) { console.error(`${id}: when failed`, error); return false }
    },
    setContext(next: Omit<WindowContext, 'dispatch'>) { context = { ...next, dispatch } },
    /** Fetch what `target` offers (`APP`, or a connected machine's id). */
    async load(target: string) {
      const what = 'Fetching its actions'
      try {
        remote.set(target, await window.superego.call(target, 'action.list', {}) as ActionInfo[])
      } catch (error) {
        return reportProblem(target, what, error)
      }
      clearProblem(target, what)
      version++
      for (const listener of listeners) listener()
    },
    /** Every action this window can dispatch: its own, the app's, and `machine`'s. */
    all(machine?: string): ActionInfo[] {
      return [...router.list(), ...(remote.get(APP) ?? []), ...(machine ? remote.get(machine) ?? [] : [])]
    },
    /** Changes whenever what `all` returns may have. */
    version: () => version,
    onChange(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
  }
}
export type WindowRouter = ReturnType<typeof createWindowRouter>

/** The dev server's restart endpoint, defined only when the window is served by it (see dev-packages.ts). */
declare const __SUPEREGO_DEV_SERVER__: string | undefined

/** The shell's own actions. Extensions add theirs with `superego.action`. */
export const coreActions = (app: AppConfig): WindowAction[] => [
  defineWindowAction({ id: 'app.palette', title: 'Commands', keys: 'mod+k', run: (_p, c) => c.togglePalette() }),
  defineWindowAction({ id: 'app.navigator', title: 'Go to a project, thread or pane', keys: 'mod+l', run: (_p, c) => c.toggleNavigator() }),
  // The panes the selected thread can open, as its pane menu has them: only while one is shown.
  defineWindowAction({
    id: 'pane.pick', title: 'Open a pane…', keys: 'mod+shift+p',
    when: (c) => Boolean(c.selection && c.threadOf(c.selection)),
    run: (_p, c) => { if (c.selection && c.threadOf(c.selection)) c.togglePanePicker() },
  }),
  defineWindowAction({ id: 'app.sidebar', title: 'Show or hide sidebar', keys: 'mod+/', run: (_p, c) => c.toggleSidebar() }),
  // ⌘1–⌘9: the rail's tabs in its order (see rail-tabs.ts).
  ...Array.from({ length: RAIL_TABS }, (_, i) => defineWindowAction({
    id: tabAction(i + 1), title: `Go to rail tab ${i + 1}`, keys: `mod+${i + 1}`,
    when: (c) => c.railTabs().length > i,
    run: (_p, c) => c.railTabs()[i]?.open(),
  })),
  // Through every thread, in the sidebar's order, across projects; and between projects, at the thread last shown in each.
  defineWindowAction({ id: 'thread.next', title: 'Next thread', keys: 'mod+shift+]', run: (_p, c) => stepThread(c, 1) }),
  defineWindowAction({ id: 'thread.previous', title: 'Previous thread', keys: 'mod+shift+[', run: (_p, c) => stepThread(c, -1) }),
  defineWindowAction({ id: 'project.next', title: 'Next project', run: (_p, c) => stepProject(c, 1) }),
  defineWindowAction({ id: 'project.previous', title: 'Previous project', run: (_p, c) => stepProject(c, -1) }),
  // Where this window has been, as a browser goes back and forward.
  defineWindowAction({ id: 'app.back', title: 'Back', keys: 'mod+[', run: (_p, c) => c.back() }),
  defineWindowAction({ id: 'app.forward', title: 'Forward', keys: 'mod+]', run: (_p, c) => c.forward() }),
  // Focus: the region beside (sidebar, thread, each pane), and the prompt.
  defineWindowAction({ id: 'focus.left', title: 'Focus the region to the left', keys: 'mod+alt+arrowleft', run: () => focusBeside(-1) }),
  defineWindowAction({ id: 'focus.right', title: 'Focus the region to the right', keys: 'mod+alt+arrowright', run: () => focusBeside(1) }),
  defineWindowAction({ id: 'focus.prompt', title: 'Focus the prompt', keys: 'ctrl+i', run: () => focusPrompt() }),
  defineWindowAction({ id: 'focus.thread', title: 'Focus the thread', run: () => focusThread() }),
  // What has the focus (the thread from its prompt) scrolls half a page.
  defineWindowAction({ id: 'scroll.down', title: 'Scroll down half a page', keys: 'ctrl+d', run: () => scrollHalfPage(1) }),
  defineWindowAction({ id: 'scroll.up', title: 'Scroll up half a page', keys: 'ctrl+u', run: () => scrollHalfPage(-1) }),
  // Within a thread: the thread itself, then each pane beside it.
  defineWindowAction({ id: 'pane.next', title: 'Next pane', keys: 'ctrl+tab', run: (_p, c) => stepPane(c, 1) }),
  defineWindowAction({ id: 'pane.previous', title: 'Previous pane', keys: 'ctrl+shift+tab', run: (_p, c) => stepPane(c, -1) }),
  // The focused pane a place along, as dragging its tab in the strip moves it; the thread stays first.
  defineWindowAction({ id: 'pane.moveLeft', title: 'Move pane left', keys: 'mod+alt+shift+arrowleft', when: (c) => Boolean(paneMove(c, -1)), run: (_p, c) => movePane(c, -1) }),
  defineWindowAction({ id: 'pane.moveRight', title: 'Move pane right', keys: 'mod+alt+shift+arrowright', when: (c) => Boolean(paneMove(c, 1)), run: (_p, c) => movePane(c, 1) }),
  // The panes side by side, scrolling past the window's edge, or stacked in one column: `layout`, else the other one.
  defineWindowAction({
    id: 'pane.layout', title: 'Toggle stacked panes', keys: 'mod+shift+\\',
    params: obj({ layout: opt(union([lit('scroll'), lit('stack')])) }),
    run: ({ layout }, c) => c.dispatch('app.settings.set', {
      key: PANE_LAYOUT, value: layout ?? (c.appSetting<PaneLayout>(PANE_LAYOUT) === 'stack' ? 'scroll' : 'stack'),
    }, { machine: APP, source: 'panes' }),
  }),
  // Another window (in a browser, another tab), starting as a copy of this one: the same thread, space and sidebar,
  // from where each goes its own way.
  defineWindowAction({
    id: 'app.newWindow', title: 'New window', keys: 'mod+shift+n',
    run: async () => { if (window.superego.web) window.open(location.href, '_blank'); else await window.superego.call(APP, 'app.newWindow', { state: windowState() }) },
  }),
  // In dev only: restart the window's dev server so packages linked since it started resolve (see dev-packages.ts).
  ...(typeof __SUPEREGO_DEV_SERVER__ === 'string' ? [defineWindowAction({
    id: 'app.reloadPackages', title: 'Reload, picking up new packages', 
    run: async () => {
      const answer = await fetch(__SUPEREGO_DEV_SERVER__, { method: 'POST' })
      if (!answer.ok) throw new Error(`The dev server didn't restart (${answer.status})`)
    },
  })] : []),
  defineWindowAction({ id: 'app.settings', title: 'Settings', keys: 'mod+,', run: (_p, c) => c.openSettings() }),
  // Another machine's Superego, updated from its own checkout there. Its progress shows in Settings → Machines.
  defineWindowAction({
    id: 'machine.update', title: `Update ${app.name} on a machine`,
    params: obj({ machine: opt(str()) }),
    when: (c) => c.machines.some((m) => m.remote && m.state === 'connected'),
    run: async ({ machine }, c) => {
      const id = machine ?? updatable(c)
      // Settings, at Machines (SettingsView's own section key), where the update's output shows.
      setLocalState('settings.target', '$machines', APP)
      c.openSettings()
      if (!id) return
      await window.superego.call(APP, 'app.updateMachine', { machine: id })
    },
  }),
  defineWindowAction({ id: 'app.log', title: 'Show action log', run: (_p, c) => c.showLog() }),
  // The first-launch page again, where it shows: with nothing selected.
  defineWindowAction({ id: 'app.onboarding', title: 'Show onboarding', run: (_p, c) => { c.select(undefined); showOnboarding() } }),
  // Panes of the selected thread.
  defineWindowAction({
    // The pane with the focus; the focus moves left, to the pane before it or the thread. The thread itself stays.
    id: 'pane.closeFocused', title: 'Close pane', keys: 'mod+w',
    run: async (_p, c) => {
      const thread = c.selection && c.threadOf(c.selection)
      const panes = thread?.panes ?? []
      const index = panes.findIndex((p) => p.id === focusedColumn(thread))
      if (!c.selection || index < 0) return
      await c.dispatch('pane.close', { thread: c.selection.thread, pane: panes[index]!.id }, { machine: c.selection.machine, source: 'panes' })
      focusColumn(panes[index - 1]?.id)
    },
  }),
  // A column (the thread's or a pane's) over the whole of the thread's area for a while (see maximized.ts), and back:
  // `column`, else the focused one.
  defineWindowAction({
    id: 'pane.maximize', title: 'Maximize or restore column', keys: 'mod+shift+enter',
    description: '`column`: a pane\'s id, or `thread` for the thread\'s own; else the one with the focus',
    params: obj({ column: opt(str()) }),
    when: (c) => Boolean(maximizable(c)),
    run: ({ column }, c) => {
      const at = maximizable(c)
      if (!at) return
      maximizedStore.set(toggleMaximized(maximizedStore.get(), at.key, at.panes, column, focusedColumn(at.thread) ?? THREAD_COLUMN))
    },
  }),
  defineWindowAction({
    id: 'thread.startRename', title: 'Rename thread…', 
    run: (_p, c) => { if (c.selection) startRename(c.selection.machine, c.selection.thread) },
  }),
  // Pins are the app's (see pins.ts): `thread` on `machine`, else the selected thread.
  defineWindowAction({
    id: 'thread.pin', title: 'Pin thread',
    description: 'To the top of the sidebar; pinned already, `at` moves it (0 is first)',
    params: obj({ machine: opt(str()), thread: opt(str()), at: opt(int()) }),
    when: (c) => Boolean(c.selection && pinnable(c, c.selection) && !isPinned(pinsNow(c), c.selection)),
    run: ({ machine, thread, at }, c) => setPins(c, pinAt(pinsNow(c), pinOf(c, { machine, thread }), at)),
  }),
  defineWindowAction({
    id: 'thread.unpin', title: 'Unpin thread',
    params: obj({ machine: opt(str()), thread: opt(str()) }),
    when: (c) => Boolean(c.selection && isPinned(pinsNow(c), c.selection)),
    run: ({ machine, thread }, c) => {
      const at = machine && thread ? { machine, thread } : c.selection
      if (!at) throw new Error('No thread to unpin')
      return setPins(c, unpin(pinsNow(c), at))
    },
  }),
  defineWindowAction({
    id: 'thread.new', title: 'New thread…', keys: 'mod+n',
    params: obj({}), run: (_p, c) => c.newThread(),
  }),
  defineWindowAction({
    id: 'thread.select', title: 'Show a thread', 
    params: obj({ machine: str(), thread: str() }),
    run: ({ machine, thread }, c) => c.select({ machine, thread }),
  }),
]

/**
 * The machine Update means without one named: the selected thread's, when it's another machine; else the one machine
 * running an older Superego than this computer. None when that's not one machine: Settings → Machines lists them all.
 */
function updatable(c: WindowContext): string | undefined {
  const selected = c.machines.find((m) => m.id === c.selection?.machine && m.remote && m.state === 'connected')
  if (selected) return selected.id
  const behind = c.machines.filter((m) => m.remote && m.state === 'connected' && (m.drift?.state === 'behind' || m.drift?.state === 'unknown'))
  return behind.length === 1 ? behind[0]!.id : undefined
}

/** The project the selected thread is in, and where it is in the order. */
function current(c: WindowContext) {
  const index = c.projects.findIndex((s) => s.machine.id === c.selection?.machine && s.threads.some((t) => t.id === c.selection?.thread))
  return { index, project: c.projects[index] }
}

/** Show a project: the thread last shown in it, else its first. */
export function showProject(c: Pick<WindowContext, 'select' | 'lastThread'>, project: Project) {
  const thread = project.threads.find((t) => t.id === c.lastThread[project.key]) ?? project.threads[0]
  if (thread) c.select({ machine: project.machine.id, thread: thread.id })
}

function stepProject(c: WindowContext, by: number) {
  if (!c.projects.length) return
  const { index } = current(c)
  const next = c.projects[index < 0 ? (by > 0 ? 0 : c.projects.length - 1) : (index + by + c.projects.length) % c.projects.length]
  if (next) showProject(c, next)
}

const pinsNow = (c: WindowContext) => pinsOf(c.appSetting(PINS))
const setPins = (c: WindowContext, pins: Pin[]) => c.dispatch('app.settings.set', { key: PINS, value: pins }, { machine: APP, source: 'pins' }).then(() => null)
/** A thread the sidebar lists: not archived, nor one no list shows (Ego's). */
const pinnable = (c: WindowContext, at: Pin) => { const info = c.threadOf(at); return Boolean(info && !info.archived && !info.hidden) }
/** The thread a pin action is for: the one named, else the selected; one the sidebar lists. */
function pinOf(c: WindowContext, { machine, thread }: { machine?: string; thread?: string }): Pin {
  const at = machine && thread ? { machine, thread } : c.selection
  if (!at) throw new Error('No thread to pin')
  if (!pinnable(c, at)) throw new Error(`Only a thread the sidebar lists can be pinned, not ${at.thread} on ${at.machine}`)
  return at
}

function stepThread(c: WindowContext, by: number) {
  const next = threadBeside(c.sidebar, c.selection, by)
  if (next) c.select(next)
}

/**
 * The column with the focus: where keyboard focus is, when it's in one (the thread's: undefined); else the pane the
 * thread has in focus. Keyboard focus is current; what the thread reports may still be on its way.
 */
function focusedColumn(thread: ThreadInfo | undefined): string | undefined {
  const column = (document.activeElement?.closest('.app__main [data-column]') as HTMLElement | null)?.dataset.column
  if (column) return column === 'thread' ? undefined : column
  return thread?.pane
}

/** The selected thread and its panes' ids, for maximizing a column: none without panes, or in a window as narrow as a phone's. */
function maximizable(c: WindowContext) {
  const thread = c.selection && c.threadOf(c.selection)
  if (!c.selection || !thread?.panes?.length || matchMedia(NARROW).matches) return undefined
  return { key: `${c.selection.machine}/${c.selection.thread}`, thread, panes: thread.panes.map((p) => p.id) }
}

/** The thread, then its panes, then around: the next one brought forward. */
async function stepPane(c: WindowContext, by: number) {
  const thread = c.selection && c.threadOf(c.selection)
  if (!c.selection || !thread?.panes?.length) return
  const columns = [undefined, ...thread.panes.map((p) => p.id)]
  const at = Math.max(0, columns.indexOf(focusedColumn(thread)))
  const next = columns[(at + by + columns.length) % columns.length]
  await c.dispatch('pane.focus', { thread: thread.id, ...(next ? { pane: next } : {}) }, { machine: c.selection.machine, source: 'keys' })
  focusColumn(next)
}

/** The focused pane of the selected thread and where it'd go, `by` a place along: none at the end, or where the machine can't. */
function paneMove(c: WindowContext, by: -1 | 1) {
  const thread = c.selection && c.threadOf(c.selection)
  const machine = c.machines.find((m) => m.id === c.selection?.machine)
  const panes = thread?.panes ?? []
  const index = panes.findIndex((p) => p.id === focusedColumn(thread))
  if (!c.selection || !offers(machine, 'pane-move') || index < 0 || !panes[index + by]) return undefined
  return { machine: c.selection.machine, thread: c.selection.thread, pane: panes[index]!.id, to: index + by }
}

async function movePane(c: WindowContext, by: -1 | 1) {
  const move = paneMove(c, by)
  if (!move) return
  await c.dispatch('pane.move', { thread: move.thread, pane: move.pane, to: move.to }, { machine: move.machine, source: 'keys' })
}

/** Whether an action can run with no parameters (after the selection fills in a thread's): keys and the palette. */
export function runsBare(action: ActionInfo): boolean {
  const required = ((action.params as { required?: string[] } | undefined)?.required ?? [])
    .filter((name) => !(action.thread && (name === 'thread' || name === 'machine')))
  return required.length === 0
}

/** The action log: this window's dispatches, newest first, live. */
export function ActionLog({ router, onClose }: { router: Router<WindowContext>; onClose(): void }) {
  const [entries, setEntries] = useState<ActionLogEntry[]>(() => router.log())
  useEffect(() => router.onDispatch(() => setEntries(router.log())), [router])
  const time = (at: number) => new Date(at).toLocaleTimeString(undefined, { hour12: false })
  return (
    <Dialog title="Action log" size="large" onClose={onClose} className="action-log">
      <table className="action-log__table">
        <thead><tr><th>time</th><th>action</th><th>from</th><th>ms</th><th>params</th></tr></thead>
        <tbody>
          {[...entries].reverse().map((e, i) => (
            <tr key={`${e.at}-${i}`} className={e.ok ? '' : 'is-error'}>
              <td>{time(e.at)}</td>
              <td>{e.id}{e.error && <div className="action-log__error">{e.error}</div>}</td>
              <td>{e.source}</td>
              <td>{e.ms}</td>
              <td><code>{e.params === undefined ? '' : JSON.stringify(e.params)}</code></td>
            </tr>
          ))}
          {entries.length === 0 && <tr><td colSpan={5} className="action-log__none">Nothing dispatched yet</td></tr>}
        </tbody>
      </table>
    </Dialog>
  )
}
