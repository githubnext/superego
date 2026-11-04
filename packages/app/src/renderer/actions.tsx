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
  dispatch(id: string, params?: unknown, source?: string): Promise<unknown>
}

export type WindowAction = ActionDef<any, unknown, WindowContext>

export function createWindowRouter() {
  const router = new Router<WindowContext>()
  /** The shell keeps this current; actions read it when they run. */
  let context: WindowContext | undefined
  const dispatch = (id: string, params: unknown = {}, source = 'ui') => {
    if (!context) return Promise.reject(new Error('The window is not ready'))
    return router.dispatch(id, params, context, { source })
  }
  return {
    router,
    dispatch,
    setContext(next: Omit<WindowContext, 'dispatch'>) { context = { ...next, dispatch } },
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
