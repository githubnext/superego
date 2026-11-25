// Machine types and helpers with no Node imports, so a browser renderer can use them too.
import { MACHINE_COLOURS, remoteCommand, type AppConfig } from '@superego/protocol'

/**
 * A machine a client connects to besides this computer: reached with `ssh <target> <command>`, or with `via`, any shell
 * command whose stdin and stdout reach the app's daemon (`docker exec -i box superego connect --start`, `fly ssh console ...`).
 */
export type MachineConfig = {
  id: string; label: string; target: string; command?: string; via?: string; enabled: boolean
  /** The identity of the daemon first reached there; a different one answering is refused. */
  daemonId?: string
  /** Its colour: a slot of the palette, 1 to MACHINE_COLOURS (`--superego-machine-<n>`). Given when it's added. */
  colour?: number
}

/** Whether `value` is a slot of the palette. */
export const isColour = (value: unknown): value is number => Number.isInteger(value) && (value as number) >= 1 && (value as number) <= MACHINE_COLOURS

/** The colour for a machine added beside those `taken`: the first slot none has, or, all taken, the least used (the first of those). */
export function nextColour(taken: readonly (number | undefined)[]): number {
  const uses = Array.from({ length: MACHINE_COLOURS }, (_, i) => taken.filter((c) => c === i + 1).length)
  return uses.indexOf(Math.min(...uses)) + 1
}

/**
 * Every machine with a colour: those without one (from before colours, or from an older client) given the next, in
 * order, this computer's (`here`) first. The same list always gets the same colours.
 */
export function withColours<M extends { colour?: number }>(here: number | undefined, machines: readonly M[]): { here: number; machines: M[] } {
  const taken: (number | undefined)[] = [here, ...machines.map((m) => m.colour)].map((c) => isColour(c) ? c : undefined)
  const give = (at: number) => taken[at] ?? (taken[at] = nextColour(taken))
  return { here: give(0), machines: machines.map((m, i) => isColour(m.colour) ? m : { ...m, colour: give(i + 1) }) }
}

/** How a machine is reached, as the user would type it. `ssh <target>` runs the app's remote command unless it says. */
export const routeOf = (config: MachineConfig, app: AppConfig) => config.via ?? `ssh ${config.target} ${config.command ?? remoteCommand(app)}`

export type MachineId = string
export type { ConnectionState, MachineEntry } from '@superego/protocol'

/** `promise`, or `error()` after `ms`. What it was waiting on is the caller's to stop: close the transport, say. */
export function within<T>(promise: Promise<T>, ms: number, error: () => Error): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(error()), ms) })
  return Promise.race([promise, late]).finally(() => clearTimeout(timer))
}
