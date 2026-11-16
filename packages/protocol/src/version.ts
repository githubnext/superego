// Which Superego a machine runs, next to this computer's: older, newer, the same, or not known. Machines run
// Superego from their own checkout, updated by hand (or by Update), so one can fall behind without anyone noticing.
import type { Hello } from './methods.ts'

/** What a daemon says of its code in `hello`: its build and protocol, and its commit when it runs from git. */
export type MachineVersion = { build: string; commit?: string; committedAt?: number; protocol: number }

/**
 * A machine's Superego next to this computer's. `behind` and `ahead` by commit time; `differs` when the commits
 * differ but were made at the same moment; `unknown` when it doesn't know its commit (it runs from outside git).
 */
export type VersionDrift =
  | { state: 'current' }
  | { state: 'behind' | 'ahead'; commit: string; by: number }
  | { state: 'differs'; commit: string }
  | { state: 'unknown' }

export const versionOf = (hello: Hello): MachineVersion => ({
  build: hello.machine.build, protocol: hello.version,
  ...(hello.machine.commit ? { commit: hello.machine.commit } : {}),
  ...(hello.machine.committedAt ? { committedAt: hello.machine.committedAt } : {}),
})

/** `there` next to `here`; undefined when `here` doesn't know its own commit (nothing to compare with). */
export function compareVersions(here: MachineVersion | undefined, there: MachineVersion | undefined): VersionDrift | undefined {
  if (!here?.commit || here.committedAt === undefined) return undefined
  if (!there?.commit || there.committedAt === undefined) return { state: 'unknown' }
  if (there.commit === here.commit) return { state: 'current' }
  const by = there.committedAt - here.committedAt
  if (by === 0) return { state: 'differs', commit: there.commit }
  return { state: by < 0 ? 'behind' : 'ahead', commit: there.commit, by: Math.abs(by) }
}

/** Whether a drift is worth saying: anything but the same Superego (or not knowing this computer's). */
export const drifted = (drift: VersionDrift | undefined): drift is Exclude<VersionDrift, { state: 'current' }> =>
  Boolean(drift && drift.state !== 'current')

/** A span of time, roughly: "3 minutes", "2 hours", "5 days". */
export function roughly(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000))
  const [n, unit] = minutes < 60 ? [minutes, 'minute'] : minutes < 48 * 60 ? [Math.round(minutes / 60), 'hour'] : [Math.round(minutes / 1440), 'day']
  return `${n} ${unit}${n === 1 ? '' : 's'}`
}

/** "an older Superego (5e9684c, 2 days behind)", or nothing when it's this computer's. */
export function driftPhrase(drift: VersionDrift | undefined, name = 'Superego'): string | undefined {
  if (!drifted(drift)) return undefined
  if (drift.state === 'unknown') return `a ${name} that doesn't know its commit`
  const commit = drift.commit.slice(0, 7)
  if (drift.state === 'differs') return `a different ${name} (${commit})`
  return drift.state === 'behind' ? `an older ${name} (${commit}, ${roughly(drift.by)} behind)` : `a newer ${name} (${commit}, ${roughly(drift.by)} ahead)`
}

/** "mbp runs an older Superego (5e9684c, 2 days behind)", or nothing when it runs this computer's. */
export function describeDrift(label: string, drift: VersionDrift | undefined, name = 'Superego'): string | undefined {
  const phrase = driftPhrase(drift, name)
  return phrase && `${label} runs ${phrase}`
}
