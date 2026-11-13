// The window's side of actions. Window actions run here with the shell's context; machine and app actions are
// forwarded to where they run (see `dispatch`). Every dispatch from this window is logged, and the log is one action
// away (Show action log).
import { useEffect, useState } from 'react'
import { obj, opt, Router, str, type ActionDef, type ActionInfo, type ActionLogEntry, type AppConfig, type Exposure, type Json, type JsonSchema, type Static } from '@superego/protocol'
import { Dialog } from '@superego/ui'
import type { ThreadInfo } from '@superego/protocol'
import type { MachineEntry } from '../shared.ts'
import type { NewThreadStart, Selection } from './state.tsx'
import { threadBeside, type Session } from './sessions.ts'
import { focusBeside, focusColumn, focusPrompt, focusThread } from './focus.ts'
import { scrollHalfPage } from './scroll.ts'
import { startRename } from './rename.ts'
import { setLocalState } from './local-state.ts'

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
  /** Every session, in the sidebar's order, and the thread last shown in each (by session key). */
  sessions: Session[]
  lastThread: Record<string, string>
  toggleSidebar(): void
  toggleNavigator(): void
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
  const router = new Router<WindowContext>()
  /** When each window action applies, for those that say. */
  const conditions = new Map<string, (context: WindowContext) => boolean>()
  /** The shell keeps this current; actions read it when they run. */
  let context: WindowContext | undefined
  /** What the app and each machine offer, by target ('app' or a machine id). */
  const remote = new Map<string, ActionInfo[]>()
  const listeners = new Set<() => void>()
  let version = 0

  const dispatch: Dispatch = (id, params = {}, { source = 'ui', machine } = {}) => {
    if (router.has(id)) {
      if (!context) return Promise.reject(new Error('The window is not ready'))
      return router.dispatch(id, params, context, { source })
    }
    if (machine === 'app' || remote.get('app')?.some((a) => a.id === id)) {
      return router.track(id, params, source, () => window.superego.call('app', id, params))
    }
    const target = machine ?? (typeof params.machine === 'string' ? params.machine : undefined) ?? context?.selection?.machine ?? 'local'
    const action = remote.get(target)?.find((a) => a.id === id)
    const { machine: _machine, ...rest } = params
    const filled = action?.thread && rest.id === undefined && context?.selection?.machine === target ? { ...rest, id: context.selection.thread } : rest
    // Through action.run: it finds actions registered after this window connected (a profile's, as it loads).
    const ran = router.track(id, filled, `${source} → ${target}`, () => window.superego.call(target, 'action.run', { id, params: filled }))
    // A pane opened from this window was asked for here: the focus goes into it. (The agent's open beside, unfocused.)
    if (id === 'pane.open') void ran.then((pane) => { const opened = (pane as { id?: string } | null)?.id; if (opened) focusColumn(opened) }, () => {})
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
    /** Fetch what `target` offers ('app', or a connected machine's id). */
    async load(target: string) {
      try {
        remote.set(target, await window.superego.call(target, 'action.list', {}) as ActionInfo[])
        version++
        for (const listener of listeners) listener()
      } catch { /* an older daemon without actions: nothing to offer */ }
    },
    /** Every action this window can dispatch: its own, the app's, and `machine`'s. */
    all(machine?: string): ActionInfo[] {
      return [...router.list(), ...(remote.get('app') ?? []), ...(machine ? remote.get(machine) ?? [] : [])]
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
  defineWindowAction({ id: 'app.navigator', title: 'Go to a session, thread or pane', keys: 'mod+l', run: (_p, c) => c.toggleNavigator() }),
  defineWindowAction({ id: 'app.sidebar', title: 'Toggle sidebar', keys: 'mod+/', run: (_p, c) => c.toggleSidebar() }),
  // Through every thread, in the sidebar's order, across sessions; and between sessions, at the thread last shown in each.
  defineWindowAction({ id: 'thread.next', title: 'Next thread', keys: 'mod+shift+]', run: (_p, c) => stepThread(c, 1) }),
  defineWindowAction({ id: 'thread.previous', title: 'Previous thread', keys: 'mod+shift+[', run: (_p, c) => stepThread(c, -1) }),
  defineWindowAction({ id: 'session.next', title: 'Next session', run: (_p, c) => stepSession(c, 1) }),
  defineWindowAction({ id: 'session.previous', title: 'Previous session', run: (_p, c) => stepSession(c, -1) }),
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
  // Another window (in a browser, another tab), showing what this one does.
  defineWindowAction({
    id: 'app.newWindow', title: 'New window', keys: 'mod+shift+n',
    run: async () => { if (window.superego.web) window.open(location.href, '_blank'); else await window.superego.call('app', 'app.newWindow', {}) },
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
      setLocalState('settings.target', '$machines', 'app')
      c.openSettings()
      if (!id) return
      await c.dispatch('machines.install', { id }, { machine: 'app', source: 'machine.update' })
    },
  }),
  defineWindowAction({ id: 'app.log', title: 'Show action log', run: (_p, c) => c.showLog() }),
  // Panes of the selected thread.
  defineWindowAction({
    // The pane with the focus; the focus moves left, to the pane before it or the thread. The thread itself stays.
    id: 'panes.close', title: 'Close pane', keys: 'mod+w',
    run: async (_p, c) => {
      const thread = c.selection && c.threadOf(c.selection)
      const panes = thread?.panes ?? []
      const index = panes.findIndex((p) => p.id === focusedColumn(thread))
      if (!c.selection || index < 0) return
      await c.dispatch('pane.close', { id: c.selection.thread, pane: panes[index]!.id }, { machine: c.selection.machine, source: 'panes' })
      focusColumn(panes[index - 1]?.id)
    },
  }),
  defineWindowAction({
    id: 'thread.startRename', title: 'Rename thread…', 
    run: (_p, c) => { if (c.selection) startRename(c.selection.machine, c.selection.thread) },
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

/** The session the selected thread is in, and where it is in the order. */
function current(c: WindowContext) {
  const index = c.sessions.findIndex((s) => s.machine.id === c.selection?.machine && s.threads.some((t) => t.id === c.selection?.thread))
  return { index, session: c.sessions[index] }
}

/** Show a session: the thread last shown in it, else its first. */
export function showSession(c: Pick<WindowContext, 'select' | 'lastThread'>, session: Session) {
  const thread = session.threads.find((t) => t.id === c.lastThread[session.key]) ?? session.threads[0]
  if (thread) c.select({ machine: session.machine.id, thread: thread.id })
}

function stepSession(c: WindowContext, by: number) {
  if (!c.sessions.length) return
  const { index } = current(c)
  const next = c.sessions[index < 0 ? (by > 0 ? 0 : c.sessions.length - 1) : (index + by + c.sessions.length) % c.sessions.length]
  if (next) showSession(c, next)
}

function stepThread(c: WindowContext, by: number) {
  const next = threadBeside(c.sessions, c.selection, by)
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

/** The thread, then its panes, then around: the next one brought forward. */
async function stepPane(c: WindowContext, by: number) {
  const thread = c.selection && c.threadOf(c.selection)
  if (!c.selection || !thread?.panes?.length) return
  const columns = [undefined, ...thread.panes.map((p) => p.id)]
  const at = Math.max(0, columns.indexOf(focusedColumn(thread)))
  const next = columns[(at + by + columns.length) % columns.length]
  await c.dispatch('pane.focus', { id: thread.id, ...(next ? { pane: next } : {}) }, { machine: c.selection.machine, source: 'keys' })
  focusColumn(next)
}

/** Whether an action can run with no parameters (after the selection fills in a thread's): keys and the palette. */
export function runsBare(action: ActionInfo): boolean {
  const required = ((action.params as { required?: string[] } | undefined)?.required ?? [])
    .filter((name) => !(action.thread && (name === 'id' || name === 'machine')))
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
