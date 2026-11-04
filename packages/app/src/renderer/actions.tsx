// The window's side of actions. Window actions run here with the shell's context; machine and app actions are
// forwarded to where they run (see `dispatch`). Every dispatch from this window is logged, and the log is one action
// away (Show action log).
import { useEffect, useState } from 'react'
import { defineAction, obj, Router, str, type ActionDef, type ActionInfo, type ActionLogEntry, type AppConfig } from '@mu/protocol'
import { Dialog } from '@mu/ui'
import type { MachineEntry } from '../shared.ts'
import type { NewSessionStart, Selection } from './state.tsx'

/** What a window action gets besides its parameters. */
export type WindowContext = {
  app: AppConfig
  machines: MachineEntry[]
  selection: Selection | undefined
  select(selection: Selection | undefined): void
  openSettings(): void
  newSession(start?: NewSessionStart): void
  togglePalette(): void
  showLog(): void
  dispatch: Dispatch
}

/**
 * Run an action by id, wherever it runs: a window action here; an app action in the main process; a machine action on
 * `options.machine`, else the selected session's machine, else this computer. A session action takes the selected
 * session when its `id` isn't given.
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
    const filled = action?.session && rest.id === undefined && context?.selection?.machine === target ? { ...rest, id: context.selection.session } : rest
    return router.track(id, filled, `${source} → ${target}`, () => window.mu.call(target, id, filled))
  }

  return {
    router,
    dispatch,
    setContext(next: Omit<WindowContext, 'dispatch'>) { context = { ...next, dispatch } },
    /** Fetch what `target` offers ('app', or a connected machine's id). */
    async load(target: string) {
      try {
        remote.set(target, await window.mu.call(target, 'action.list', {}) as ActionInfo[])
        for (const listener of listeners) listener()
      } catch { /* an older daemon without actions: nothing to offer */ }
    },
    /** Every action this window can dispatch: its own, the app's, and `machine`'s. */
    all(machine?: string): ActionInfo[] {
      return [...router.list(), ...(remote.get('app') ?? []), ...(machine ? remote.get(machine) ?? [] : [])]
    },
    onChange(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
  }
}
export type WindowRouter = ReturnType<typeof createWindowRouter>

/** The shell's own actions. Extensions add theirs with `mu.action`. */
export const coreActions: WindowAction[] = [
  defineAction({ id: 'app.palette', title: 'Command palette', runs: 'window', keys: 'mod+k', run: (_p, c: WindowContext) => c.togglePalette() }),
  defineAction({ id: 'app.settings', title: 'Settings', runs: 'window', keys: 'mod+,', run: (_p, c: WindowContext) => c.openSettings() }),
  defineAction({ id: 'app.log', title: 'Show action log', runs: 'window', run: (_p, c: WindowContext) => c.showLog() }),
  defineAction({
    id: 'session.new', title: 'New session…', runs: 'window', keys: 'mod+n',
    params: obj({}), run: (_p, c: WindowContext) => c.newSession(),
  }),
  defineAction({
    id: 'session.select', title: 'Show a session', runs: 'window',
    params: obj({ machine: str(), session: str() }),
    run: ({ machine, session }, c: WindowContext) => c.select({ machine, session }),
  }),
]

/** Whether an action can run with no parameters (after the selection fills in a session's): keys and the palette. */
export function runsBare(action: ActionInfo): boolean {
  const required = ((action.params as { required?: string[] } | undefined)?.required ?? [])
    .filter((name) => !(action.session && (name === 'id' || name === 'machine')))
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
