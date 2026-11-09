// The window's side of actions. Window actions run here with the shell's context; machine and app actions are
// forwarded to where they run (see `dispatch`). Every dispatch from this window is logged, and the log is one action
// away (Show action log).
import { useEffect, useState } from 'react'
import { defineAction, obj, Router, str, type ActionDef, type ActionInfo, type ActionLogEntry, type AppConfig } from '@mu/protocol'
import { Dialog } from '@mu/ui'
import type { ThreadInfo } from '@mu/protocol'
import type { MachineEntry } from '../shared.ts'
import type { NewThreadStart, Selection } from './state.tsx'
import { unread, type Session } from './sessions.ts'

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
  /** ⌘. : the next unread thread anywhere, or only in the selected thread's session. */
  unreadScope: 'all' | 'session'
  dispatch: Dispatch
}

/**
 * Run an action by id, wherever it runs: a window action here; an app action in the main process; a machine action on
 * `options.machine`, else the selected thread's machine, else this computer. A thread action takes the selected
 * thread when its `id` isn't given.
 */
export type Dispatch = (id: string, params?: Record<string, unknown>, options?: { source?: string; machine?: string }) => Promise<unknown>

export type WindowAction = ActionDef<any, unknown, WindowContext>

export function createWindowRouter() {
  const router = new Router<WindowContext>()
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
      return router.track(id, params, source, () => window.mu.call('app', id, params))
    }
    const target = machine ?? (typeof params.machine === 'string' ? params.machine : undefined) ?? context?.selection?.machine ?? 'local'
    const action = remote.get(target)?.find((a) => a.id === id)
    const { machine: _machine, ...rest } = params
    const filled = action?.thread && rest.id === undefined && context?.selection?.machine === target ? { ...rest, id: context.selection.thread } : rest
    // Through action.run: it finds actions registered after this window connected (a profile's, as it loads).
    return router.track(id, filled, `${source} → ${target}`, () => window.mu.call(target, 'action.run', { id, params: filled }))
  }

  return {
    router,
    dispatch,
    setContext(next: Omit<WindowContext, 'dispatch'>) { context = { ...next, dispatch } },
    /** Fetch what `target` offers ('app', or a connected machine's id). */
    async load(target: string) {
      try {
        remote.set(target, await window.mu.call(target, 'action.list', {}) as ActionInfo[])
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

/** The shell's own actions. Extensions add theirs with `mu.action`. */
export const coreActions: WindowAction[] = [
  defineAction({ id: 'app.palette', title: 'Commands', runs: 'window', keys: 'mod+k', run: (_p, c: WindowContext) => c.togglePalette() }),
  defineAction({ id: 'app.navigator', title: 'Go to a session, thread or pane', runs: 'window', keys: 'mod+l', run: (_p, c: WindowContext) => c.toggleNavigator() }),
  defineAction({ id: 'app.sidebar', title: 'Toggle sidebar', runs: 'window', keys: 'mod+/', run: (_p, c: WindowContext) => c.toggleSidebar() }),
  // Between sessions: the thread last shown in each.
  defineAction({ id: 'session.next', title: 'Next session', runs: 'window', keys: 'mod+shift+]', run: (_p, c: WindowContext) => stepSession(c, 1) }),
  defineAction({ id: 'session.previous', title: 'Previous session', runs: 'window', keys: 'mod+shift+[', run: (_p, c: WindowContext) => stepSession(c, -1) }),
  defineAction({ id: 'thread.unread', title: 'Next unread thread', runs: 'window', keys: 'mod+.', run: (_p, c: WindowContext) => nextUnread(c) }),
  // Within a thread: the thread itself, then each pane beside it.
  defineAction({ id: 'pane.next', title: 'Next pane', runs: 'window', keys: 'ctrl+tab', run: (_p, c: WindowContext) => stepPane(c, 1) }),
  defineAction({ id: 'pane.previous', title: 'Previous pane', runs: 'window', keys: 'ctrl+shift+tab', run: (_p, c: WindowContext) => stepPane(c, -1) }),
  defineAction({ id: 'app.settings', title: 'Settings', runs: 'window', keys: 'mod+,', run: (_p, c: WindowContext) => c.openSettings() }),
  defineAction({ id: 'app.log', title: 'Show action log', runs: 'window', run: (_p, c: WindowContext) => c.showLog() }),
  // Panes of the selected thread.
  defineAction({
    id: 'panes.changes', title: 'Show changes', runs: 'window', keys: 'mod+shift+d',
    run: async (_p, c: WindowContext) => { if (c.selection) await c.dispatch('pane.open', { id: c.selection.thread, kind: 'diff' }, { machine: c.selection.machine, source: 'panes' }) },
  }),
  defineAction({
    id: 'panes.close', title: 'Close pane', runs: 'window', keys: 'mod+shift+w',
    run: async (_p, c: WindowContext) => {
      const thread = c.selection && c.threadOf(c.selection)
      const front = thread?.panes?.find((p) => p.id === thread.pane) ?? thread?.panes?.at(-1)
      if (c.selection && front) await c.dispatch('pane.close', { id: c.selection.thread, pane: front.id }, { machine: c.selection.machine, source: 'panes' })
    },
  }),
  defineAction({
    id: 'thread.new', title: 'New thread…', runs: 'window', keys: 'mod+n',
    params: obj({}), run: (_p, c: WindowContext) => c.newThread(),
  }),
  defineAction({
    id: 'thread.select', title: 'Show a thread', runs: 'window',
    params: obj({ machine: str(), thread: str() }),
    run: ({ machine, thread }, c: WindowContext) => c.select({ machine, thread }),
  }),
]

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

/** The next thread after this one, in order, with something unread; around to the start, but never this one. */
function nextUnread(c: WindowContext) {
  const { session } = current(c)
  const scope = c.unreadScope === 'session' && session ? [session] : c.sessions
  const order = scope.flatMap((s) => s.threads.map((thread) => ({ machine: s.machine.id, thread })))
  const at = order.findIndex((o) => o.machine === c.selection?.machine && o.thread.id === c.selection.thread)
  for (let step = 1; step <= order.length; step++) {
    const next = order[(at + step + order.length) % order.length]!
    if (next.thread.id === c.selection?.thread && next.machine === c.selection.machine) continue
    if (unread(next.thread)) return c.select({ machine: next.machine, thread: next.thread.id })
  }
}

/** The thread, then its panes, then around: the next one brought forward. */
async function stepPane(c: WindowContext, by: number) {
  const thread = c.selection && c.threadOf(c.selection)
  if (!c.selection || !thread?.panes?.length) return
  const columns = [undefined, ...thread.panes.map((p) => p.id)]
  const at = Math.max(0, columns.indexOf(thread.pane))
  const next = columns[(at + by + columns.length) % columns.length]
  await c.dispatch('pane.focus', { id: thread.id, ...(next ? { pane: next } : {}) }, { machine: c.selection.machine, source: 'keys' })
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
