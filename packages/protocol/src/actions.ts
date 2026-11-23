// Actions: every intent in Superego (start a thread, send a message, toggle the rail, add a machine) is defined once, with
// a schema for its parameters, and runs through a router. Keys, the palette, the command line and tests all dispatch
// the same way, and every dispatch is logged. Streams (watches) and reads are not actions.
import { compile, type JsonSchema, type Static } from '@earendil-works/pi-schema'
import { RpcError } from './rpc.ts'
import type { Json } from './settings.ts'

/** Where an action runs: in a window, in the app's main process, or on a machine's daemon. */
export type Runs = 'window' | 'app' | 'machine'
/** Who may dispatch it: the app's UI, the command line, outside agents (`superego mcp`). */
export type Exposure = 'ui' | 'cli' | 'outside'

/** An action as data: what clients list, bind and show. */
export type ActionInfo = {
  /** Stable, dotted: `thread.start`, `threads.rail`. Extensions' start with their name. */
  id: string
  /** What it's called in the palette and menus. */
  title: string
  /** What it does, in a line: for the palette and `superego do`. */
  description?: string
  /** JSON Schema of the parameters (an object). Absent: none. */
  params?: JsonSchema
  runs: Runs
  /** Who may dispatch it: `['ui']` unless said. */
  expose: Exposure[]
  /** Its default shortcut, like `mod+shift+n`. */
  keys?: string
  /** It acts on a thread: `machine` and `thread` come from the selected one when not given. */
  thread?: boolean
  /**
   * It records the user's consent: to run a command or a project's code, to let a device or outside agents in. Only the
   * user gives it, in a window or in their own terminal, never an agent: it's refused for a client that said it runs in
   * a thread's shell (`hello`'s `from`), and it can't be exposed to `outside`.
   */
  consent?: true
  /** Its parameters by these names hold secrets (a key, a token): the action log keeps them as `•••`, never their values. */
  secret?: string[]
}

/** An action with what it does: `run`, given its params and what it runs for. Made with `defineAction`. */
export type ActionDef<P = any, R = unknown, C = unknown> = ActionInfo & {
  run(params: P, context: C): R | Promise<R>
  /**
   * Which params hold secrets in this dispatch, when that depends on them (`settings.set` of a secret setting): the log
   * keeps those as `•••` too, beside `secret`'s.
   */
  secretIn?(params: unknown): string[]
}

/** Define an action; with a pi-schema `params`, `run` gets them typed. */
export function defineAction<S extends JsonSchema | undefined, R, C = any>(
  def: Omit<ActionInfo, 'params' | 'expose'> & { params?: S; expose?: Exposure[]; run(params: S extends JsonSchema ? Static<S> : Record<string, never>, context: C): R | Promise<R> },
): ActionDef<any, R, C> {
  return { expose: ['ui'], ...def } as ActionDef<any, R, C>
}

/** One dispatch, as the log keeps it. `client` names the connection that dispatched it, on a daemon: who, not only how (`source`). */
export type ActionLogEntry = { at: number; id: string; source: string; ms: number; ok: boolean; params?: Json; error?: string; client?: { id: string; kind: string; label: string; from?: string } }

/**
 * Check parameters against `schema` (coercing strings, as the command line sends them): the parsed parameters, or an
 * `invalid_params` error naming what's wrong. Without a schema, anything goes.
 */
export function paramsParser(id: string, schema: JsonSchema | undefined): (params: unknown) => unknown {
  const validator = schema ? compile(schema, { coerce: true }) : undefined
  return (params) => {
    const value = params ?? {}
    if (!validator) return value
    const parsed = validator.parse(value)
    if (parsed.ok) return parsed.value
    const why = parsed.errors.map((e) => `${(e as { path?: string }).path || 'params'}: ${(e as { message?: string }).message ?? 'invalid'}`).join('; ')
    throw new RpcError('invalid_params', `${id}: ${why}`)
  }
}

/**
 * Holds actions and runs them: validates (and, from strings, coerces) parameters, runs, times and logs. `C` is what
 * actions get besides their parameters: the window's selection, the calling connection, and so on. Make one with
 * `createRouter`.
 */
export type Router<C = unknown> = {
  /** How many dispatches `log` keeps. */
  readonly logSize: number
  /** Hold `def`; the function returned lets go of it again. */
  register(def: ActionDef<any, unknown, C>): () => void
  has(id: string): boolean
  get(id: string): ActionInfo | undefined
  list(exposure?: Exposure): ActionInfo[]
  /**
   * Run `id`. `exposure`: who is asking, refused if the action isn't exposed to it. `from`: the thread whose agent's shell
   * is asking (its command line), refused for an action that records the user's `consent`.
   */
  dispatch(id: string, params: unknown, context: C, options?: { source?: string; exposure?: Exposure; from?: string; client?: ActionLogEntry['client'] }): Promise<unknown>
  /**
   * Time and log work done elsewhere for an action this router doesn't hold (a window forwarding to a daemon).
   * `client`: who dispatched it. `secret`: the params it logs as `•••` (`ActionInfo.secret`) for one it doesn't hold, or
   * `'all'` to log none (an action it knows nothing of, which may take a secret); one it holds says its own.
   */
  track<R>(id: string, params: unknown, source: string, run: () => Promise<R>, options?: { client?: ActionLogEntry['client']; secret?: string[] | 'all' }): Promise<R>
  /** The newest dispatches, oldest first. */
  log(): ActionLogEntry[]
  onDispatch(listener: (entry: ActionLogEntry) => void): () => void
}

/** A router holding no actions yet, keeping the last `logSize` dispatches (500). */
export function createRouter<C = unknown>({ logSize = 500 }: { logSize?: number } = {}): Router<C> {
  const actions = new Map<string, { def: ActionDef<any, unknown, C>; parse: (params: unknown) => unknown }>()
  const log: ActionLogEntry[] = []
  const listeners = new Set<(entry: ActionLogEntry) => void>()
  const router: Router<C> = {
    logSize,
    register(def) {
      if (actions.has(def.id)) throw new Error(`Action ${def.id} is already defined`)
      if (!/^[a-z][a-z0-9-]*(\.[a-z][a-zA-Z0-9-]*)+$/.test(def.id)) throw new Error(`Action id "${def.id}" must be dotted lowercase, like thread.start`)
      if (def.consent && def.expose.includes('outside')) throw new Error(`Action ${def.id} records the user's consent: it can't be exposed to outside agents`)
      actions.set(def.id, { def, parse: paramsParser(def.id, def.params) })
      return () => { if (actions.get(def.id)?.def === def) actions.delete(def.id) }
    },
    has: (id) => actions.has(id),
    get: (id) => actions.get(id) && info(actions.get(id)!.def),
    list: (exposure) => [...actions.values()].map(({ def }) => info(def)).filter((a) => !exposure || a.expose.includes(exposure)),
    dispatch(id, params, context, { source = 'ui', exposure, from, client } = {}) {
      return router.track(id, params, source, async () => {
        const action = actions.get(id)
        if (!action) throw new RpcError('unknown_action', `No action ${id}`)
        if (exposure && !action.def.expose.includes(exposure)) throw new RpcError('not_exposed', `${id} can't be run from ${exposure}`)
        if (from && action.def.consent) throw consentRefused(action.def.title)
        return action.def.run(action.parse(params), context)
      }, client ? { client } : {})
    },
    async track(id, params, source, run, { client, secret } = {}) {
      const started = Date.now()
      const held = actions.get(id)?.def
      const logged = held ? withoutSecrets(params, [...held.secret ?? [], ...held.secretIn?.(params) ?? []]) : secret === 'all' ? undefined : withoutSecrets(params, secret)
      const record = (ok: boolean, error?: string) => {
        const entry: ActionLogEntry = { at: started, id, source, ms: Date.now() - started, ok, ...(logged !== undefined ? { params: logged as Json } : {}), ...(error ? { error } : {}), ...(client ? { client } : {}) }
        log.push(entry)
        if (log.length > logSize) log.splice(0, log.length - logSize)
        for (const listener of listeners) listener(entry)
      }
      try {
        const result = await run()
        record(true)
        return result
      } catch (error) {
        record(false, error instanceof Error ? error.message : String(error))
        throw error
      }
    },
    log: () => [...log],
    onDispatch(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
  return router
}

/**
 * Why an agent can't give the user's consent (`ActionInfo.consent`, a setting's `consent`): `what` is the action's title
 * or the setting's.
 */
export const consentRefused = (what: string) => new RpcError('consent', `${what}: that's the user's consent to give, not an agent's`, {
  hint: 'Ask the user to do it themselves: in the window (Settings), or in their own terminal.',
})

/** `params` as the log keeps them: those named in `secret` (that are there) as `•••`. */
function withoutSecrets(params: unknown, secret: string[] | undefined): unknown {
  if (!secret?.length || !params || typeof params !== 'object' || Array.isArray(params)) return params
  return Object.fromEntries(Object.entries(params).map(([name, value]) => [name, secret.includes(name) && value != null ? '•••' : value]))
}

const info = ({ run: _run, secretIn: _secretIn, ...rest }: ActionDef<any, unknown, any>): ActionInfo => rest

/** Schema builders for action parameters, so extensions need nothing beyond @superego/*. */
export { arr, bool, int, lit, nullable, num, obj, opt, str, union, unknown } from '@earendil-works/pi-schema'
export type { JsonSchema, Static } from '@earendil-works/pi-schema'
