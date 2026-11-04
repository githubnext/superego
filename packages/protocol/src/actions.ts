// Actions: every intent in mu (start a session, send a message, toggle the rail, add a machine) is defined once, with
// a schema for its parameters, and runs through a router. Keys, the palette, the command line and tests all dispatch
// the same way, and every dispatch is logged. Streams (watches) and reads are not actions.
import { compile, type JsonSchema, type Static } from '@earendil-works/pi-schema'
import { RpcError } from './rpc.ts'
import type { Json } from './settings.ts'

/** Where an action runs: in a window, in the app's main process, or on a machine's daemon. */
export type Runs = 'window' | 'app' | 'machine'
/** Who may dispatch it: the app's UI, the command line, (later) MCP. */
export type Exposure = 'ui' | 'cli' | 'mcp'

/** An action as data: what clients list, bind and show. */
export type ActionInfo = {
  /** Stable, dotted: `session.create`, `threads.rail`. Extensions' start with their name. */
  id: string
  title: string
  description?: string
  /** JSON Schema of the parameters (an object). Absent: none. */
  params?: JsonSchema
  runs: Runs
  expose: Exposure[]
  /** Its default shortcut, like `mod+shift+n`. */
  keys?: string
  /** It acts on a session: `machine` and `id` come from the selected one when not given. */
  session?: boolean
}

export type ActionDef<P = any, R = unknown, C = unknown> = ActionInfo & { run(params: P, context: C): R | Promise<R> }

/** Define an action; with a pi-schema `params`, `run` gets them typed. */
export function defineAction<S extends JsonSchema | undefined, R, C = any>(
  def: Omit<ActionInfo, 'params' | 'expose'> & { params?: S; expose?: Exposure[]; run(params: S extends JsonSchema ? Static<S> : Record<string, never>, context: C): R | Promise<R> },
): ActionDef<any, R, C> {
  return { expose: ['ui'], ...def } as ActionDef<any, R, C>
}

/** One dispatch, as the log keeps it. */
export type ActionLogEntry = { at: number; id: string; source: string; ms: number; ok: boolean; params?: Json; error?: string }

type Compiled = ReturnType<typeof compileParams>
function compileParams(schema: JsonSchema | undefined) {
  return schema ? compile(schema, { coerce: true }) : undefined
}

/**
 * Holds actions and runs them: validates (and, from strings, coerces) parameters, runs, times and logs. `C` is what
 * actions get besides their parameters: the window's selection, the calling connection, and so on.
 */
export class Router<C = unknown> {
  #actions = new Map<string, { def: ActionDef<any, unknown, C>; validator: Compiled }>()
  #log: ActionLogEntry[] = []
  #listeners = new Set<(entry: ActionLogEntry) => void>()
  readonly logSize: number

  constructor({ logSize = 500 }: { logSize?: number } = {}) { this.logSize = logSize }

  register(def: ActionDef<any, unknown, C>): () => void {
    if (this.#actions.has(def.id)) throw new Error(`Action ${def.id} is already defined`)
    if (!/^[a-z][a-z0-9-]*(\.[a-z][a-zA-Z0-9-]*)+$/.test(def.id)) throw new Error(`Action id "${def.id}" must be dotted lowercase, like session.create`)
    this.#actions.set(def.id, { def, validator: compileParams(def.params) })
    return () => { if (this.#actions.get(def.id)?.def === def) this.#actions.delete(def.id) }
  }

  has(id: string) { return this.#actions.has(id) }
  get(id: string): ActionInfo | undefined { return this.#actions.get(id) && info(this.#actions.get(id)!.def) }
  list(exposure?: Exposure): ActionInfo[] {
    return [...this.#actions.values()].map(({ def }) => info(def)).filter((a) => !exposure || a.expose.includes(exposure))
  }

  async dispatch(id: string, params: unknown, context: C, { source = 'ui', exposure }: { source?: string; exposure?: Exposure } = {}): Promise<unknown> {
    const started = Date.now()
    const action = this.#actions.get(id)
    const record = (ok: boolean, error?: string) => {
      const entry: ActionLogEntry = { at: started, id, source, ms: Date.now() - started, ok, ...(params !== undefined ? { params: params as Json } : {}), ...(error ? { error } : {}) }
      this.#log.push(entry)
      if (this.#log.length > this.logSize) this.#log.splice(0, this.#log.length - this.logSize)
      for (const listener of this.#listeners) listener(entry)
    }
    try {
      if (!action) throw new RpcError('unknown_action', `No action ${id}`)
      if (exposure && !action.def.expose.includes(exposure)) throw new RpcError('not_exposed', `${id} can't be run from ${exposure}`)
      let value: unknown = params ?? {}
      if (action.validator) {
        const parsed = action.validator.parse(value)
        if (!parsed.ok) {
          const why = parsed.errors.map((e) => `${(e as { path?: string }).path || 'params'}: ${(e as { message?: string }).message ?? 'invalid'}`).join('; ')
          throw new RpcError('invalid_params', `${id}: ${why}`)
        }
        value = parsed.value
      }
      const result = await action.def.run(value, context)
      record(true)
      return result
    } catch (error) {
      record(false, error instanceof Error ? error.message : String(error))
      throw error
    }
  }

  /** Time and log work done elsewhere for an action this router doesn't hold (a window forwarding to a daemon). */
  async track<R>(id: string, params: unknown, source: string, run: () => Promise<R>): Promise<R> {
    const started = Date.now()
    const record = (ok: boolean, error?: string) => {
      const entry: ActionLogEntry = { at: started, id, source, ms: Date.now() - started, ok, ...(params !== undefined ? { params: params as Json } : {}), ...(error ? { error } : {}) }
      this.#log.push(entry)
      if (this.#log.length > this.logSize) this.#log.splice(0, this.#log.length - this.logSize)
      for (const listener of this.#listeners) listener(entry)
    }
    try {
      const result = await run()
      record(true)
      return result
    } catch (error) {
      record(false, error instanceof Error ? error.message : String(error))
      throw error
    }
  }

  /** The newest dispatches, oldest first. */
  log(): ActionLogEntry[] { return [...this.#log] }
  onDispatch(listener: (entry: ActionLogEntry) => void): () => void {
    this.#listeners.add(listener)
    return () => { this.#listeners.delete(listener) }
  }
}

const info = ({ run: _run, ...rest }: ActionDef<any, unknown, any>): ActionInfo => rest

/** Schema builders for action parameters, so extensions need nothing beyond @mu/*. */
export { arr, bool, int, lit, nullable, num, obj, opt, str, union, unknown } from '@earendil-works/pi-schema'
